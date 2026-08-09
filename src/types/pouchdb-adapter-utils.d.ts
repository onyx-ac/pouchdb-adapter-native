/**
 * `pouchdb-adapter-utils` ships no TypeScript declarations and there's no `@types`
 * package for it, so this is a minimal ambient declaration covering only `parseDoc`,
 * the only export this adapter uses.
 */
declare module 'pouchdb-adapter-utils' {
  import type { DocMetadata } from 'pouchdb-merge';

  export interface ParsedDoc {
    metadata: DocMetadata;
    data: Record<string, unknown>;
  }

  /**
   * Returns a plain error object (`.error === true`, PouchDB error shape) for a
   * malformed rev/doc instead of throwing, *except* for a reserved top-level key
   * (`DOC_VALIDATION`), which it throws. Callers must handle both.
   */
  export function parseDoc(
    doc: Record<string, unknown>,
    newEdits: boolean,
    dbOpts?: { deterministic_revs?: boolean },
  ): ParsedDoc | { error: true; status?: number; name?: string; message?: string };
}
