/**
 * `pouchdb-utils` ships no TypeScript declarations and there's no `@types` package
 * for it, so this is a minimal ambient declaration covering only what this adapter
 * actually uses (`uuid`, `filterChange`).
 */
declare module 'pouchdb-utils' {
  export function uuid(length?: number): string;

  /**
   * Builds the `opts.filter`/`include_docs` post-processing step `_changes`
   * implementations are expected to run on every candidate change. Returns `false`
   * to drop the change, `true` to keep it (mutating `change.doc` in place per
   * `include_docs`/`attachments`), or an object to be treated as a fatal filter
   * error and passed straight to `opts.complete`.
   */
  export function filterChange(
    opts: Record<string, unknown>,
  ): (change: { doc?: Record<string, unknown> }) => boolean | Record<string, unknown>;
}
