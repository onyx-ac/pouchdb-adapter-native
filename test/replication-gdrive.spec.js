'use strict';

// Spec 03 task 8: bidirectional replication between the native adapter and the
// real @docstack/pouchdb-adapter-googledrive package (a separate repo). Self-skips
// unless TEST_ENV=production is set, mirroring that package's own
// `maybeDescribe = isProd ? describe : describe.skip` convention - `npm test`
// stays fast and credential-free by default; this only runs when explicitly
// invoked via `npm run test:prod:replication` (TEST_ENV=production prefixed,
// through Git Bash on Windows - see docstack-pouchdb-adapter-gdrive/docs/TESTING.md).
const maybeDescribe = process.env.TEST_ENV === 'production' ? describe : describe.skip;

const path = require('path');
require('dotenv').config({
  path: path.join(path.dirname(require.resolve('@docstack/pouchdb-adapter-googledrive/package.json')), '.env'),
});

const GoogleDriveAdapter = require('@docstack/pouchdb-adapter-googledrive').default;
const PouchDBReplication = require('pouchdb-replication');

maybeDescribe('Bidirectional replication against real Google Drive (spec 03 task 8)', function () {
  this.timeout(120000);

  let hubB;
  let sourceA;
  const dbNameSuffix = Date.now();

  before(function () {
    const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error(
        'GOOGLE_ACCESS_TOKEN is not set - see docstack-pouchdb-adapter-gdrive/docs/TESTING.md ' +
          'for how to obtain one via the OAuth2 Playground, then put it in that package\'s .env file.',
      );
    }
    PouchDB.plugin(PouchDBReplication);
    PouchDB.plugin(GoogleDriveAdapter({ accessToken }));
  });

  afterEach(async function () {
    if (sourceA) {
      try {
        await sourceA.destroy();
      } catch (err) {
        console.warn('WARNING: cleanup of sourceA failed:', err.message);
      }
      sourceA = null;
    }
    if (hubB) {
      try {
        await hubB.destroy({ deleteFolder: true });
      } catch (err) {
        console.warn('WARNING: cleanup of hubB (Drive folder) failed:', err.message);
      }
      hubB = null;
    }
  });

  function replicateOnce(source, target) {
    return new Promise((resolve, reject) => {
      source.replicate
        .to(target)
        .on('complete', () => resolve())
        .on('error', reject);
    });
  }

  async function docsById(db) {
    const result = await db.allDocs({ include_docs: true });
    const map = {};
    for (const row of result.rows) {
      if (row.doc) map[row.id] = { _id: row.doc._id, _rev: row.doc._rev, val: row.doc.val };
    }
    return map;
  }

  it('converges in both directions, and a concurrent edit resolves to the same winning revision on both sides', async function () {
    sourceA = new PouchDB('task8-native-' + dbNameSuffix);
    hubB = new PouchDB('task8-drive-' + dbNameSuffix, {
      adapter: 'googledrive',
      folderName: 'task8-repl-' + dbNameSuffix,
      testMode: false,
      pollingIntervalMs: 0,
    });

    // --- A -> B: write on the native side, replicate, converge ------------------
    for (let i = 0; i < 5; i++) {
      await sourceA.put({ _id: `doc-${i}`, val: i });
    }
    await replicateOnce(sourceA, hubB);
    const aDocs = await docsById(sourceA);
    const bDocsAfterAtoB = await docsById(hubB);
    aDocs.should.deep.equal(bDocsAfterAtoB);

    // --- B -> A: write directly on the Drive side, replicate the other way ------
    await hubB.put({ _id: 'from-b-0', val: 'created on drive' });
    await hubB.put({ _id: 'from-b-1', val: 'also created on drive' });
    await replicateOnce(hubB, sourceA);
    const aDocsAfterBtoA = await docsById(sourceA);
    should.exist(aDocsAfterBtoA['from-b-0']);
    should.exist(aDocsAfterBtoA['from-b-1']);

    // --- Concurrent edit: both sides edit doc-0 independently, then sync --------
    const onA = await sourceA.get('doc-0');
    onA.val = 'edited-on-native';
    await sourceA.put(onA);

    const onB = await hubB.get('doc-0');
    onB.val = 'edited-on-drive';
    await hubB.put(onB);

    await new Promise((resolve, reject) => {
      sourceA
        .sync(hubB)
        .on('complete', () => resolve())
        .on('error', reject);
    });

    const winnerOnA = await sourceA.get('doc-0', { conflicts: true });
    const winnerOnB = await hubB.get('doc-0', { conflicts: true });

    winnerOnB._rev.should.equal(winnerOnA._rev);
    winnerOnB.val.should.equal(winnerOnA.val);
    winnerOnA._conflicts.should.be.an('array').that.is.not.empty;
    winnerOnB._conflicts.should.be.an('array').that.is.not.empty;
  });
});
