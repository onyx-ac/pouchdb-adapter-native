import { createError, MISSING_DOC, REV_CONFLICT } from 'pouchdb-errors';
import { CONTRACT_VERSION } from './contract.js';
import type { BridgeError, Carrier } from './contract.js';

export interface NativeAdapterOptions {
  carrier: Carrier;
}

const ADAPTER_NAME = 'native';

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
      this.carrier = carrier;

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

      this._bulkDocs = notImplemented('_bulkDocs', 'spec 03 task 3');
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
