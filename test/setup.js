'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const { createFakeCarrier } = require('./fake-carrier.js');

chai.use(chaiAsPromised);
global.should = chai.should();
global.assert = chai.assert;

// The adapter (src/index.ts) builds to ESM (tsconfig: module esnext); this file is
// CommonJS (test/package.json: "type": "commonjs") so upstream's vendored test.*.js
// files run unmodified with require()/globals. A mocha root hook plugin lets a
// CJS --require file still await an ESM import before the suite runs.
exports.mochaHooks = {
  async beforeAll() {
    const PouchDB = require('pouchdb-core');
    const { NativeAdapter } = await import('../lib/index.js');

    PouchDB.plugin(NativeAdapter({ carrier: createFakeCarrier() }));
    PouchDB.preferredAdapters = ['native'];

    global.PouchDB = PouchDB;
  },
};
