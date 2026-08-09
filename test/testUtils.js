'use strict';

const pouchdbErrors = require('pouchdb-errors');
const pouchdbUtils = require('pouchdb-utils');
const pouchdbBinaryUtils = require('pouchdb-binary-utils');

/**
 * Port of `apache/pouchdb`'s `tests/integration/utils.js` (`testUtils`), scoped to
 * what the vendored spec files we've brought in actually use — grows as later tasks
 * vendor files that need more of it; not a full port (see `test/vendor/VENDORED.md`).
 */
const testUtils = {};

// Prefix http adapter database names with their host and node adapter ones with a
// db location. We only ever run against the 'local' adapter (no CouchDB target).
//
// Deviates from upstream (Date.now() alone): our fake carrier is in-memory with no
// real I/O latency, so consecutive tests can land in the same millisecond and get
// colliding db names - and since `_destroy` isn't implemented yet (spec 03 task 7),
// a collision leaks state from one test into the next instead of erroring cleanly.
// A monotonic counter guarantees uniqueness regardless of clock resolution.
let counter = 0;
testUtils.adapterUrl = function (adapter, name) {
  counter += 1;
  return `${name}_${Date.now()}_${counter}`;
};

// Upstream's `testUtils.errors` is `pouchdb-for-coverage`'s re-export of
// `pouchdb-errors`; we depend on the real `pouchdb-errors` package directly (task 3),
// so just point at it.
testUtils.errors = pouchdbErrors;

// Random rev-id-fragment generator, used by vendored tests to build synthetic
// `_revisions` trees. Real `pouchdb-utils` export, same one upstream uses.
testUtils.rev = pouchdbUtils.rev;

// We only ever run the 'local' adapter (no CouchDB target), so nothing here is ever
// actually a CouchDB/Safari session - vendored tests that branch on these only take
// the branch that assumes false, but still call these directly and need them defined.
testUtils.isCouchDB = function (cb) {
  cb(false);
};
testUtils.isSafari = function () {
  return false;
};
testUtils.isCouchMaster = function () {
  return false;
};

// Real `pouchdb-binary-utils` exports, same ones upstream's `pouchUtils.btoa`/`atob`
// point at.
testUtils.btoa = pouchdbBinaryUtils.btoa;
testUtils.atob = pouchdbBinaryUtils.atob;

// Wraps a callback-style function as one returning a promise. Ported verbatim from
// upstream.
testUtils.promisify = function (fun, context) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      args.push((err, res) => {
        if (err) return reject(err);
        return resolve(res);
      });
      fun.apply(context, args);
    });
  };
};

// Put doc after prevRev (so that doc is a child of prevDoc in rev_tree). Doc must
// have _rev. If prevRev is not specified just insert doc with correct _rev
// (new_edits=false!). Ported verbatim from upstream (minus its `testUtils.assign`
// indirection - a plain `pouchUtils.assign` polyfill, unnecessary on modern Node).
testUtils.putAfter = function (db, doc, prevRev, callback) {
  const newDoc = Object.assign({}, doc);
  if (!prevRev) {
    db.put(newDoc, { new_edits: false }, callback);
    return;
  }
  newDoc._revisions = {
    start: +newDoc._rev.split('-')[0],
    ids: [newDoc._rev.split('-')[1], prevRev.split('-')[1]],
  };
  db.put(newDoc, { new_edits: false }, callback);
};

// docs will be inserted one after another starting from root.
testUtils.putBranch = function (db, docs, callback) {
  function insert(i) {
    const doc = docs[i];
    const prev = i > 0 ? docs[i - 1]._rev : null;
    function next() {
      if (i < docs.length - 1) {
        insert(i + 1);
      } else {
        callback();
      }
    }
    db.get(doc._id, { rev: doc._rev }, (err) => {
      if (err) {
        testUtils.putAfter(db, docs[i], prev, next);
      } else {
        next();
      }
    });
  }
  insert(0);
};

testUtils.putTree = function (db, tree, callback) {
  function insert(i) {
    const branch = tree[i];
    testUtils.putBranch(db, branch, () => {
      if (i < tree.length - 1) {
        insert(i + 1);
      } else {
        callback();
      }
    });
  }
  insert(0);
};

testUtils.writeDocs = function (db, docs, callback, res) {
  if (!res) res = [];
  if (!docs.length) return callback(null, res);
  const doc = docs.shift();
  db.put(doc, (err, info) => {
    res.push(info);
    testUtils.writeDocs(db, docs, callback, res);
  });
};

// Delete specified databases.
testUtils.cleanup = function (dbs, done) {
  const unique = Array.from(new Set(dbs));
  let remaining = unique.length;
  if (remaining === 0) {
    done();
    return;
  }
  const finished = () => {
    remaining -= 1;
    if (remaining === 0) done();
  };
  unique.forEach((db) => {
    new global.PouchDB(db).destroy(finished, finished);
  });
};

module.exports = testUtils;
