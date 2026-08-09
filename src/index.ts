import { createError, MISSING_DOC, REV_CONFLICT } from 'pouchdb-errors';
import { parseDoc } from 'pouchdb-adapter-utils';
import { isDeleted, isLocalId, merge, revExists, winningRev } from 'pouchdb-merge';
import { uuid } from 'pouchdb-utils';
import { CONTRACT_VERSION } from './contract.js';
import type { BridgeError, Carrier } from './contract.js';
import type { ParsedDoc } from 'pouchdb-adapter-utils';
import type { DocMetadata } from 'pouchdb-merge';

export interface NativeAdapterOptions {
  carrier: Carrier;
}

const ADAPTER_NAME = 'native';

/** Reserved local doc backing `db.id()` - a stable per-database instance id that
 * survives close/reopen. Matches the reference adapter's own approach, just backed
 * by the local-doc primitive instead of a bespoke metadata key. */
const INSTANCE_ID_LOCAL_DOC = '_local/instanceId';

type Callback = (err: Error | null, result?: unknown) => void;

interface StoredDocWire {
  id: string;
  rev: string;
  seq: number;
  deleted: boolean;
  body?: Record<string, unknown> | null;
  conflicts?: string[];
}

interface RevTreeEntryWire {
  id: string;
  tree: string | null;
  winningRev: string | null;
  seq: number;
  deleted: boolean;
}

interface StoreInfoWire {
  docCount: number;
  updateSeq: number;
}

interface LocalDocWire {
  rev: string;
  body: Record<string, unknown>;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function mapBridgeError(error: BridgeError): Error {
  switch (error.code) {
    case 'NOT_FOUND':
      return createError(MISSING_DOC, error.message);
    case 'CONFLICT':
      return createError(REV_CONFLICT, error.message);
    default:
      return Object.assign(new Error(error.message), { name: error.code.toLowerCase() });
  }
}

async function call(carrier: Carrier, method: string, args: readonly unknown[]): Promise<unknown> {
  const response = await carrier({
    v: CONTRACT_VERSION,
    id: nextRequestId(),
    capability: 'storage',
    method,
    args,
  });
  if (response.ok) return response.value;
  throw mapBridgeError(response.error);
}

/**
 * PouchDB's adapter methods are plain callback-style functions, not `async` ones -
 * some call sites inspect or rely on the return value (`return this._putLocal(doc, cb)`
 * in pouchdb-core), and an `async function` returns a `Promise` instead of `undefined`
 * there, which broke callback delivery. This keeps the assigned method itself
 * synchronous (always returns `undefined`) while the real work stays async internally.
 */
function runAsync<T>(callback: Callback, fn: () => Promise<T>): void {
  fn().then(
    (result) => callback(null, result),
    (err) => callback(err as Error),
  );
}

/**
 * A stub still has to behave like a real adapter method: find the trailing callback
 * (PouchDB's own convention) and report the error through it, rather than throwing
 * synchronously — a synchronous throw here left `db.destroy()` (called by
 * `test/testUtils.js`'s cleanup) hanging instead of rejecting, since PouchDB core
 * expects `_destroy` to resolve via callback, not throw.
 */
function notImplemented(method: string, task: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const cb = args[args.length - 1];
    const error = new Error(`NativeAdapter.${method} not implemented yet (${task})`);
    if (typeof cb === 'function') {
      (cb as Callback)(error);
    } else {
      throw error;
    }
  };
}

/** Drops PouchDB's underscore-prefixed special fields before storing a local doc's body. */
function localDocBody(doc: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    if (key === '_id' || key === '_rev' || key === '_revisions' || key === '_deleted') continue;
    body[key] = doc[key];
  }
  return body;
}

/** True when a `newEdits` write's parent rev isn't actually present in the existing
 * tree (the caller claimed a rev that doesn't exist) - traced from
 * `pouchdb-adapter-utils`'s `processDocs.js` (`rootIsMissing`). */
function rootIsMissing(docInfo: ParsedDoc): boolean {
  return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
}

function buildWriteOp(
  docInfo: ParsedDoc,
  winningRevId: string,
  deleted: boolean,
  expectedPrevWinningRev: string | null,
) {
  return {
    id: docInfo.metadata.id,
    rev: docInfo.metadata.rev,
    tree: JSON.stringify(docInfo.metadata.rev_tree),
    winningRev: winningRevId,
    deleted,
    body: docInfo.data,
    expectedPrevWinningRev: expectedPrevWinningRev ?? undefined,
  };
}

/**
 * PouchDB adapter over docstack-store's envelope protocol (spec 03). Registered via
 * `PouchDB.plugin(NativeAdapter({ carrier }))` - same code in the WebView and the
 * headless carrier, only `carrier` differs (ADR-0002); no carrier branch lives here.
 *
 * Spec 03 task 2: `_info`, `_get`, `_getRevisionTree`, local docs. Regular docs only
 * ever enter a PouchDB store through `_bulkDocs` (task 3), so `_get`/`_getRevisionTree`
 * only support a plain `db.get(id)` here - `revs`/`open_revs`/`conflicts` options need
 * real multi-revision trees to mean anything and are follow-up work.
 */
export function NativeAdapter(options: NativeAdapterOptions) {
  return function plugin(PouchDBConstructor: any): void {
    function NativePouchAdapter(this: any, opts: any, callback: Callback): void {
      const carrier = options.carrier;
      const dbName: string = opts.name;
      const revsLimit: number = opts.revs_limit || 1000;
      this.carrier = carrier;

      this._id = (idCallback: Callback): void => {
        runAsync(idCallback, async () => {
          const existing = (await call(carrier, 'getLocal', [dbName, INSTANCE_ID_LOCAL_DOC])) as LocalDocWire | null;
          if (existing) return existing.body.uuid as string;
          const freshId = uuid();
          try {
            await call(carrier, 'putLocal', [dbName, INSTANCE_ID_LOCAL_DOC, { uuid: freshId }]);
            return freshId;
          } catch (err) {
            // Lost a race with another instance of this db creating it concurrently.
            const raced = (await call(carrier, 'getLocal', [dbName, INSTANCE_ID_LOCAL_DOC])) as LocalDocWire | null;
            if (raced) return raced.body.uuid as string;
            throw err;
          }
        });
      };

      this._info = (infoCallback: Callback): void => {
        runAsync(infoCallback, async () => {
          const info = (await call(carrier, 'info', [dbName])) as StoreInfoWire;
          return {
            doc_count: info.docCount,
            update_seq: info.updateSeq,
            backend_adapter: ADAPTER_NAME,
          };
        });
      };

      this._get = (id: string, getOpts: any, getCallback: Callback): void => {
        if (typeof getOpts === 'function') {
          getCallback = getOpts;
          getOpts = {};
        }
        runAsync(getCallback, async () => {
          const [entry] = (await call(carrier, 'getRevTrees', [dbName, [id]])) as RevTreeEntryWire[];
          if (!entry.tree) throw createError(MISSING_DOC, 'missing');
          const targetRev: string = getOpts.rev || entry.winningRev;
          if (!getOpts.rev && entry.deleted) throw createError(MISSING_DOC, 'deleted');

          const stored = (await call(carrier, 'getDoc', [dbName, id, targetRev])) as StoredDocWire;
          const doc: Record<string, unknown> = Object.assign({}, stored.body, { _id: id, _rev: stored.rev });
          if (stored.deleted) doc._deleted = true;

          const metadata = { id, rev_tree: JSON.parse(entry.tree), seq: entry.seq, deleted: entry.deleted };
          return { doc, metadata };
        });
      };

      this._getRevisionTree = (docId: string, treeCallback: Callback): void => {
        runAsync(treeCallback, async () => {
          const [entry] = (await call(carrier, 'getRevTrees', [dbName, [docId]])) as RevTreeEntryWire[];
          if (!entry.tree) throw createError(MISSING_DOC, 'missing');
          return JSON.parse(entry.tree);
        });
      };

      this._getLocal = (id: string, localCallback: Callback): void => {
        runAsync(localCallback, async () => {
          const stored = (await call(carrier, 'getLocal', [dbName, id])) as LocalDocWire | null;
          if (!stored) throw createError(MISSING_DOC, 'missing');
          return Object.assign({}, stored.body, { _id: id, _rev: stored.rev });
        });
      };

      this._putLocal = (doc: any, putOpts: any, putCallback: Callback): void => {
        if (typeof putOpts === 'function') {
          putCallback = putOpts;
          putOpts = {};
        }
        runAsync(putCallback, async () => {
          const rev = (await call(carrier, 'putLocal', [dbName, doc._id, localDocBody(doc), doc._rev])) as string;
          return { ok: true, id: doc._id, rev };
        });
      };

      this._removeLocal = (doc: any, removeOpts: any, removeCallback: Callback): void => {
        if (typeof removeOpts === 'function') {
          removeCallback = removeOpts;
          removeOpts = {};
        }
        runAsync(removeCallback, async () => {
          await call(carrier, 'removeLocal', [dbName, doc._id, doc._rev]);
          return { ok: true, id: doc._id, rev: '0-0' };
        });
      };

      this._bulkDocs = (req: any, bulkOpts: any, bulkCallback: Callback): void => {
        if (typeof bulkOpts === 'function') {
          bulkCallback = bulkOpts;
          bulkOpts = {};
        }
        const newEdits = !!bulkOpts.new_edits;

        runAsync(bulkCallback, async () => {
          const userDocs: Record<string, unknown>[] = req.docs;
          const results: unknown[] = new Array(userDocs.length);

          interface Entry {
            index: number;
            doc: Record<string, unknown>;
            isLocal: boolean;
            parsed?: ParsedDoc;
          }

          // parseDoc for every regular doc up front. A parse error (bad rev format,
          // reserved top-level key) fails the *whole* _bulkDocs call - matches every
          // real PouchDB adapter (see pouchdb-adapter-leveldb-core), not a per-doc
          // error, however surprising that looks next to the per-doc conflict
          // handling below.
          const entries: Entry[] = [];
          for (let index = 0; index < userDocs.length; index++) {
            const doc = userDocs[index];
            const id = doc._id as string | undefined;
            if (id && isLocalId(id)) {
              entries.push({ index, doc, isLocal: true });
              continue;
            }
            const parsedOrError = parseDoc(doc, newEdits);
            if ('error' in parsedOrError && parsedOrError.error) {
              throw parsedOrError;
            }
            entries.push({ index, doc, isLocal: false, parsed: parsedOrError as ParsedDoc });
          }

          // Local docs bypass bulkWrite entirely - reuse the already-implemented
          // single-doc paths (task 2), same routing pouchdb-adapter-utils's own
          // processDocs.js does inline inside _bulkDocs.
          for (const entry of entries) {
            if (!entry.isLocal) continue;
            try {
              if (entry.doc._deleted) {
                await call(carrier, 'removeLocal', [dbName, entry.doc._id, entry.doc._rev]);
                results[entry.index] = { ok: true, id: entry.doc._id, rev: '0-0' };
              } else {
                const rev = await call(carrier, 'putLocal', [
                  dbName,
                  entry.doc._id,
                  localDocBody(entry.doc),
                  entry.doc._rev,
                ]);
                results[entry.index] = { ok: true, id: entry.doc._id, rev };
              }
            } catch (err) {
              results[entry.index] = err;
            }
          }

          const regular = entries.filter((e) => !e.isLocal);
          if (regular.length > 0) {
            const uniqueIds = Array.from(new Set(regular.map((e) => e.parsed!.metadata.id)));
            const treeEntries = (await call(carrier, 'getRevTrees', [dbName, uniqueIds])) as RevTreeEntryWire[];
            const existingTrees = new Map(treeEntries.map((e) => [e.id, e]));

            // A batch can legally contain several edits to the same id (real
            // replication payloads do this) - group and process sequentially per id
            // so the second edit sees the first edit's merged tree, not the
            // originally-fetched one.
            const byId = new Map<string, Entry[]>();
            for (const entry of regular) {
              const id = entry.parsed!.metadata.id!;
              const list = byId.get(id);
              if (list) list.push(entry);
              else byId.set(id, [entry]);
            }

            const ops: { entry: Entry; op: ReturnType<typeof buildWriteOp> }[] = [];

            for (const [id, group] of byId) {
              const existing = existingTrees.get(id);
              let prevMeta: DocMetadata | null =
                existing && existing.tree
                  ? { rev_tree: JSON.parse(existing.tree), winningRev: existing.winningRev ?? undefined, deleted: existing.deleted }
                  : null;

              for (const entry of group) {
                let docInfo = entry.parsed!;
                try {
                  if (!prevMeta) {
                    // Brand new doc - traced from processDocs.js's insertDoc().
                    const merged = merge([], docInfo.metadata.rev_tree[0], revsLimit);
                    docInfo.metadata.rev_tree = merged.tree;
                    if (newEdits && rootIsMissing(docInfo)) {
                      throw createError(REV_CONFLICT);
                    }
                    const winning = winningRev(docInfo.metadata);
                    const deleted = isDeleted(docInfo.metadata, winning);
                    if (bulkOpts.was_delete && deleted) {
                      throw createError(MISSING_DOC, 'deleted');
                    }
                    ops.push({ entry, op: buildWriteOp(docInfo, winning, deleted, null) });
                    results[entry.index] = { ok: true, id, rev: docInfo.metadata.rev };
                    prevMeta = { rev_tree: merged.tree, winningRev: winning, deleted };
                  } else {
                    // Existing doc - traced from updateDoc.js, exactly.
                    if (revExists(prevMeta.rev_tree, docInfo.metadata.rev!) && !newEdits) {
                      results[entry.index] = { ok: true, id, rev: docInfo.metadata.rev };
                      continue;
                    }

                    const previousWinningRev = prevMeta.winningRev || winningRev(prevMeta);
                    const previouslyDeleted =
                      prevMeta.deleted !== undefined ? prevMeta.deleted : isDeleted(prevMeta, previousWinningRev);
                    let deleted = docInfo.metadata.deleted !== undefined ? docInfo.metadata.deleted : isDeleted(docInfo.metadata);
                    const isRoot = /^1-/.test(docInfo.metadata.rev!);

                    // Undeleting via a fresh newEdits put re-parents onto the
                    // tombstone rev instead of conflicting (CouchDB "resurrection").
                    if (previouslyDeleted && !deleted && newEdits && isRoot) {
                      const resurrected = Object.assign({}, docInfo.data, { _id: id, _rev: previousWinningRev });
                      const reparsed = parseDoc(resurrected, newEdits);
                      if ('error' in reparsed && reparsed.error) throw reparsed;
                      docInfo = reparsed as ParsedDoc;
                      deleted = docInfo.metadata.deleted !== undefined ? docInfo.metadata.deleted : isDeleted(docInfo.metadata);
                    }

                    const merged = merge(prevMeta.rev_tree, docInfo.metadata.rev_tree[0], revsLimit);
                    const inConflict =
                      newEdits &&
                      ((previouslyDeleted && deleted && merged.conflicts !== 'new_leaf') ||
                        (!previouslyDeleted && merged.conflicts !== 'new_leaf') ||
                        (previouslyDeleted && !deleted && merged.conflicts === 'new_branch'));
                    if (inConflict) throw createError(REV_CONFLICT);

                    const newRev = docInfo.metadata.rev!;
                    docInfo.metadata.rev_tree = merged.tree;
                    const winning = winningRev(docInfo.metadata);
                    const winningDeleted = isDeleted(docInfo.metadata, winning);
                    const newRevDeleted = newRev === winning ? winningDeleted : isDeleted(docInfo.metadata, newRev);

                    ops.push({ entry, op: buildWriteOp(docInfo, winning, newRevDeleted, previousWinningRev) });
                    results[entry.index] = { ok: true, id, rev: newRev };
                    prevMeta = { rev_tree: merged.tree, winningRev: winning, deleted: winningDeleted };
                  }
                } catch (err) {
                  results[entry.index] = err;
                }
              }
            }

            if (ops.length > 0) {
              const writeResults = (await call(carrier, 'bulkWrite', [
                dbName,
                ops.map((o) => o.op),
              ])) as (unknown | null)[];
              // null means that op's expectedPrevWinningRev had gone stale by the
              // time bulkWrite ran (a concurrent writer landed first) - the
              // optimistic success result set above was wrong, fix it up.
              writeResults.forEach((writeResult, i) => {
                if (writeResult === null) {
                  results[ops[i].entry.index] = createError(REV_CONFLICT);
                }
              });
            }
          }

          return results;
        });
      };
      this._allDocs = notImplemented('_allDocs', 'spec 03 task 4');
      this._changes = notImplemented('_changes', 'spec 03 task 4');
      this._doCompaction = notImplemented('_doCompaction', 'spec 03 task 7');
      this._getAttachment = notImplemented('_getAttachment', 'spec 03 task 6');
      this._revsDiff = notImplemented('_revsDiff', 'spec 03 task 5');
      this._bulkGet = notImplemented('_bulkGet', 'spec 03 task 5');
      this._destroy = notImplemented('_destroy', 'spec 03 task 7');
      this._close = notImplemented('_close', 'spec 03 task 7');

      callback(null, this);
    }

    (NativePouchAdapter as any).valid = (): boolean => true;
    PouchDBConstructor.adapter(ADAPTER_NAME, NativePouchAdapter, true);
  };
}

export type { Carrier, BridgeRequest, BridgeResponse, BridgeError, BridgeErrorCode } from './contract.js';
