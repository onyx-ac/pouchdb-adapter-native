/**
 * `pouchdb-errors` ships no TypeScript declarations and there's no `@types` package
 * for it, so this is a minimal ambient declaration covering only what this adapter
 * actually uses.
 */
declare module 'pouchdb-errors' {
  export interface PouchDBErrorDescriptor {
    status: number;
    name: string;
    message: string;
  }

  export const MISSING_DOC: PouchDBErrorDescriptor;
  export const REV_CONFLICT: PouchDBErrorDescriptor;

  export function createError(error: PouchDBErrorDescriptor, reason?: string): Error;
}
