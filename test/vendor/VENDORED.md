# Vendored PouchDB test files

Spec 03 task 1 decision: vendor real spec files from `apache/pouchdb`'s
`tests/integration/` rather than write a bespoke suite. PouchDB doesn't publish an
installable conformance package, and third-party adapters that get its suite "for
free" (e.g. `pouchdb-adapter-fs`) all do so by building on
`pouchdb-adapter-leveldb-core` — a key/value seam. This adapter deliberately isn't
that (ADR-0001: document-level seam, no leveldown interface), so there's no
off-the-shelf path; vendoring real upstream files is the most faithful alternative to
spec 03's "PouchDB's adapter conformance suite passes in full."

Every vendored file's `adapters` array must be trimmed to `['local']` — there is no
CouchDB `http` target in this project.

| File | Vendored from | Modifications |
| --- | --- | --- |
| `test.aa.setup.js` | `apache/pouchdb`, `master`, `tests/integration/test.aa.setup.js` (fetched 2026-08-09) | `require('../../packages/node_modules/pouchdb/package.json')` → `require('pouchdb-core/package.json')` — the upstream path only resolves inside the pouchdb monorepo; we depend on `pouchdb-core` directly, not the `pouchdb` meta-package. |

Files land here as the adapter methods they exercise are implemented (spec 03 tasks
2+), not all at once — task 1 only proves the harness runs a real upstream file at
all.
