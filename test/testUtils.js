'use strict';

/**
 * Port of `apache/pouchdb`'s `tests/integration/utils.js` (`testUtils`), scoped to
 * what the vendored spec files we've brought in actually use — `adapterUrl` and
 * `cleanup` today. Grows as later tasks vendor files that need more of it; not a
 * full port (see `test/vendor/VENDORED.md`).
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
