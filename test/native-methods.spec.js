'use strict';

/**
 * `_info`/`_get`/`_getRevisionTree` (spec 03 task 2) have no vendorable upstream file
 * yet: regular docs only ever enter a PouchDB store through `_bulkDocs` (`db.put`/
 * `db.post` always route through it, task 3), so nothing can vendor `test.get.js`/
 * `test.basics.js` meaningfully until then. This hand-written suite seeds a doc by
 * calling the fake carrier's `bulkWrite` directly - the same call `_bulkDocs` will
 * make in task 3 - so these three methods get real coverage now instead of shipping
 * untested until task 3 happens to exercise them incidentally. Deliberately *not* in
 * `test/vendor/` - see `test/vendor/VENDORED.md`.
 */
const { createFakeCarrier } = require('./fake-carrier.js');

describe('native adapter methods (hand-written, not vendored)', function () {
  let PouchDB;
  let carrier;

  before(async function () {
    const PouchDBConstructor = require('pouchdb-core');
    const { NativeAdapter } = await import('../lib/index.js');
    carrier = createFakeCarrier();
    PouchDBConstructor.plugin(NativeAdapter({ carrier }));
    PouchDBConstructor.preferredAdapters = ['native'];
    PouchDB = PouchDBConstructor;
  });

  function revTreeFor(rev) {
    return [{ pos: 1, ids: [rev.split('-')[1], { status: 'available' }, []] }];
  }

  // PouchDB prefixes storage names with PouchDB.prefix ("_pouch_") before it ever
  // reaches the adapter's opts.name - confirmed empirically (debug.cjs), not
  // documented anywhere obvious. Seeding through the carrier directly (bypassing
  // PouchDB's own name resolution) has to apply the same prefix or it writes to a
  // different "database" than the one `new PouchDB(dbName)` reads from.
  function storageDbName(dbName) {
    return PouchDB.prefix + dbName;
  }

  async function seed(dbName, id, rev, body) {
    const response = await carrier({
      v: 1,
      id: 'seed-' + id,
      capability: 'storage',
      method: 'bulkWrite',
      args: [storageDbName(dbName), [{
        id,
        rev,
        tree: JSON.stringify(revTreeFor(rev)),
        winningRev: rev,
        deleted: false,
        body,
      }]],
    });
    if (!response.ok) throw new Error(response.error.message);
    return response.value[0];
  }

  it('_info reports the seeded doc count and update seq', async function () {
    const dbName = 'native-methods-info';
    await seed(dbName, 'doc1', '1-abc', { hello: 'world' });

    const db = new PouchDB(dbName);
    const info = await db.info();
    info.doc_count.should.equal(1);
    info.update_seq.should.be.at.least(1);
  });

  it('_get returns the seeded doc body with _id/_rev set', async function () {
    const dbName = 'native-methods-get';
    await seed(dbName, 'doc1', '1-abc', { hello: 'world' });

    const db = new PouchDB(dbName);
    const doc = await db.get('doc1');
    doc._id.should.equal('doc1');
    doc._rev.should.equal('1-abc');
    doc.hello.should.equal('world');
  });

  it('_get rejects a missing doc with not_found', async function () {
    const dbName = 'native-methods-get-missing';
    const db = new PouchDB(dbName);
    let error;
    try {
      await db.get('nope');
    } catch (err) {
      error = err;
    }
    should.exist(error);
    error.name.should.equal('not_found');
  });

  it('_getRevisionTree returns the parsed tree stored for the doc', async function () {
    const dbName = 'native-methods-tree';
    await seed(dbName, 'doc1', '1-abc', { hello: 'world' });

    const db = new PouchDB(dbName);
    const tree = await new Promise((resolve, reject) => {
      db._getRevisionTree('doc1', (err, result) => (err ? reject(err) : resolve(result)));
    });
    tree.should.deep.equal(revTreeFor('1-abc'));
  });
});
