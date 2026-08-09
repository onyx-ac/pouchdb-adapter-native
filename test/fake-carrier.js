'use strict';

/**
 * A JS-side stand-in for "the native side" — same design as
 * `InMemoryDocumentStore.kt` + `StorageDispatcher.kt`'s method routing
 * (`android/docstack-store/src/main/kotlin/ac/onyx/docstack/store/`), ported to JS.
 * No `Mutex`/`ConcurrentSkipListMap`/`AtomicLong` equivalents are needed: JS is
 * single-threaded, so a `bulkWrite` that never `await`s mid-batch is atomic for free.
 *
 * Exists purely for this package's own tests. Real carriers (WebView, headless) are
 * `docstack-permetic`/`docstack-headless`'s job, not this package's.
 */
function createFakeCarrier() {
  const databases = new Map();
  const subscribers = new Map();

  function dbFor(name) {
    let db = databases.get(name);
    if (!db) {
      db = { docs: new Map(), bySeq: new Map(), local: new Map(), attachments: new Map(), seqCounter: 0 };
      databases.set(name, db);
    }
    return db;
  }

  function existingDb(name) {
    return databases.get(name) || null;
  }

  function toStoredDoc(id, rev, seq, revRecord) {
    return { id, rev, seq, deleted: revRecord.deleted, body: revRecord.body };
  }

  function notFound(message) {
    const error = new Error(message);
    error.code = 'NOT_FOUND';
    return error;
  }

  function conflict(message) {
    const error = new Error(message);
    error.code = 'CONFLICT';
    return error;
  }

  function notify(dbName, docs) {
    const set = subscribers.get(dbName);
    if (!set || docs.length === 0) return;
    for (const listener of set) {
      for (const doc of docs) listener(doc);
    }
  }

  const handlers = {
    info([db]) {
      const d = existingDb(db);
      return { docCount: d ? d.docs.size : 0, updateSeq: d ? d.seqCounter : 0 };
    },

    getDoc([db, id, rev]) {
      const d = existingDb(db);
      const record = d && d.docs.get(id);
      if (!record) throw notFound(`doc not found: ${db}/${id}`);
      const targetRev = rev || record.winningRev;
      const revRecord = record.revisions.get(targetRev);
      if (!revRecord) throw notFound(`revision not found: ${db}/${id}@${targetRev}`);
      return toStoredDoc(id, targetRev, record.seq, revRecord);
    },

    getRevTrees([db, ids]) {
      const d = existingDb(db);
      return ids.map((id) => {
        const record = d && d.docs.get(id);
        if (!record) return { id, tree: null, winningRev: null, seq: 0, deleted: true };
        const winning = record.revisions.get(record.winningRev);
        return {
          id,
          tree: record.tree,
          winningRev: record.winningRev,
          seq: record.seq,
          deleted: winning ? winning.deleted : true,
        };
      });
    },

    bulkWrite([db, ops]) {
      const d = dbFor(db);
      const results = [];
      for (const op of ops) {
        const seq = ++d.seqCounter;
        const existing = d.docs.get(op.id);
        if (existing) d.bySeq.delete(existing.seq);
        const revisions = existing ? new Map(existing.revisions) : new Map();
        revisions.set(op.rev, {
          body: op.body ?? null,
          deleted: !!op.deleted,
          attachmentDigests: op.attachmentDigests || [],
        });
        d.docs.set(op.id, { tree: op.tree, winningRev: op.winningRev, seq, revisions });
        d.bySeq.set(seq, op.id);
        for (const digest of op.attachmentDigests || []) {
          const existingAttachment = d.attachments.get(digest);
          d.attachments.set(digest, {
            data: existingAttachment ? existingAttachment.data : null,
            refCount: (existingAttachment ? existingAttachment.refCount : 0) + 1,
          });
        }
        results.push({ id: op.id, rev: op.rev, seq });
      }
      notify(
        db,
        results.map((r) => {
          const record = d.docs.get(r.id);
          const winning = record.revisions.get(record.winningRev);
          return toStoredDoc(r.id, record.winningRev, record.seq, winning);
        }),
      );
      return results;
    },

    allDocs([db, options]) {
      const opts = options || {};
      const d = existingDb(db);
      if (!d) return { totalRows: 0, offset: opts.skip || 0, rows: [] };

      let entries;
      if (opts.keys) {
        entries = opts.keys.map((key) => [key, d.docs.get(key)]).filter(([, v]) => v);
      } else {
        entries = Array.from(d.docs.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        if (opts.startkey != null) entries = entries.filter(([id]) => id >= opts.startkey);
        if (opts.endkey != null) {
          entries = opts.inclusiveEnd === false
            ? entries.filter(([id]) => id < opts.endkey)
            : entries.filter(([id]) => id <= opts.endkey);
        }
        if (opts.descending) entries = entries.reverse();
      }

      const filtered = entries.filter(([, record]) => {
        const winning = record.revisions.get(record.winningRev);
        const deleted = winning ? winning.deleted : true;
        return opts.deleted || !deleted;
      });

      const totalRows = filtered.length;
      const skip = opts.skip || 0;
      const skipped = filtered.slice(skip);
      const paged = opts.limit != null ? skipped.slice(0, opts.limit) : skipped;

      const rows = paged.map(([id, record]) => {
        const winning = record.revisions.get(record.winningRev);
        const conflicts = opts.includeConflicts
          ? Array.from(record.revisions.keys()).filter((r) => r !== record.winningRev)
          : undefined;
        return {
          id,
          rev: record.winningRev,
          seq: record.seq,
          deleted: winning ? winning.deleted : true,
          body: opts.includeBody ? (winning ? winning.body : null) : undefined,
          conflicts: conflicts && conflicts.length ? conflicts : undefined,
        };
      });

      return { totalRows, offset: skip, rows };
    },

    changes([db, options]) {
      const opts = options || {};
      const d = existingDb(db);
      if (!d) return { lastSeq: opts.since || 0, results: [] };

      let entries = Array.from(d.bySeq.entries()).filter(([seq]) => seq > (opts.since || 0));
      entries.sort((a, b) => a[0] - b[0]);
      if (opts.descending) entries.reverse();
      if (opts.docIds) {
        const idSet = new Set(opts.docIds);
        entries = entries.filter(([, id]) => idSet.has(id));
      }
      if (opts.limit != null) entries = entries.slice(0, opts.limit);

      const results = entries.map(([seq, id]) => {
        const record = d.docs.get(id);
        const winning = record.revisions.get(record.winningRev);
        return {
          id,
          rev: record.winningRev,
          seq,
          deleted: winning ? winning.deleted : true,
          body: opts.includeBody ? (winning ? winning.body : null) : undefined,
        };
      });

      return { lastSeq: results.length ? results[results.length - 1].seq : opts.since || 0, results };
    },

    revsDiff([db, revsByDocId]) {
      const d = existingDb(db);
      const out = {};
      for (const [id, revs] of Object.entries(revsByDocId)) {
        const record = d && d.docs.get(id);
        const known = record ? record.revisions : new Map();
        out[id] = { missing: revs.filter((r) => !known.has(r)) };
      }
      return out;
    },

    bulkGet([db, requests]) {
      const d = existingDb(db);
      if (!d) return [];
      const results = [];
      for (const req of requests) {
        const record = d.docs.get(req.id);
        if (!record) continue;
        const rev = req.rev || record.winningRev;
        const revRecord = record.revisions.get(rev);
        if (!revRecord) continue;
        results.push(toStoredDoc(req.id, rev, record.seq, revRecord));
      }
      return results;
    },

    compact([db, id, revs, tree]) {
      const d = existingDb(db);
      if (!d) return null;
      const record = d.docs.get(id);
      if (!record) return null;
      const revisions = new Map(record.revisions);
      for (const rev of revs) revisions.delete(rev);
      d.docs.set(id, Object.assign({}, record, { tree, revisions }));
      return null;
    },

    getLocal([db, id]) {
      const d = existingDb(db);
      const record = d && d.local.get(id);
      return record ? { rev: record.rev, body: record.body } : null;
    },

    putLocal([db, id, doc, prevRev]) {
      const d = dbFor(db);
      const existing = d.local.get(id);
      const currentRev = existing ? existing.rev : undefined;
      if (currentRev !== (prevRev || undefined)) {
        throw conflict(`local doc conflict: ${db}/${id} (expected rev ${prevRev}, found ${currentRev})`);
      }
      const nextRevNumber = (existing ? parseInt(existing.rev.split('-')[1], 10) || 0 : 0) + 1;
      const rev = `0-${nextRevNumber}`;
      d.local.set(id, { rev, body: doc });
      return rev;
    },

    removeLocal([db, id, prevRev]) {
      const d = existingDb(db);
      const existing = d && d.local.get(id);
      if (!existing) throw notFound(`local doc not found: ${db}/${id}`);
      if (existing.rev !== prevRev) {
        throw conflict(`local doc conflict: ${db}/${id} (expected rev ${prevRev}, found ${existing.rev})`);
      }
      d.local.delete(id);
      return null;
    },

    getAttachment([db, digest]) {
      const d = existingDb(db);
      const record = d && d.attachments.get(digest);
      if (!record || record.data == null) throw notFound(`attachment not found: ${db}/${digest}`);
      return record.data;
    },

    putAttachment([db, digest, data]) {
      const d = dbFor(db);
      const existing = d.attachments.get(digest);
      d.attachments.set(digest, { data, refCount: existing ? existing.refCount : 0 });
      return null;
    },

    destroy([db]) {
      databases.delete(db);
      subscribers.delete(db);
      return null;
    },

    close() {
      return null;
    },
  };

  function mapError(error) {
    if (error && error.code === 'NOT_FOUND') return { code: 'NOT_FOUND', message: error.message };
    if (error && error.code === 'CONFLICT') return { code: 'CONFLICT', message: error.message };
    if (error instanceof TypeError || error instanceof RangeError) {
      return { code: 'INVALID_ARGUMENT', message: error.message };
    }
    return { code: 'INTERNAL', message: error && error.message ? error.message : String(error) };
  }

  async function carrier(request) {
    const handler = handlers[request.method];
    if (!handler) {
      return {
        v: request.v,
        id: request.id,
        ok: false,
        error: { code: 'INTERNAL', message: `unknown storage method: ${request.method} (contract drift)` },
      };
    }
    try {
      const value = await handler(request.args);
      return { v: request.v, id: request.id, ok: true, value };
    } catch (error) {
      return { v: request.v, id: request.id, ok: false, error: mapError(error) };
    }
  }

  /** Not part of the envelope (ADR-0002's carve-out, same as `StorageDispatcher.kt`'s
   * direct passthroughs) - a live-changes listener, not a request/response call. */
  carrier.subscribeChanges = function subscribeChanges(db, since, listener) {
    dbFor(db);
    let set = subscribers.get(db);
    if (!set) {
      set = new Set();
      subscribers.set(db, set);
    }
    const wrapped = (doc) => {
      if (doc.seq > since) listener(doc);
    };
    set.add(wrapped);
    return function unsubscribe() {
      set.delete(wrapped);
    };
  };

  return carrier;
}

module.exports = { createFakeCarrier };
