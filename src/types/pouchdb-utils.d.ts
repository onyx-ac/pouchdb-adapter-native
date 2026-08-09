/**
 * `pouchdb-utils` ships no TypeScript declarations and there's no `@types` package
 * for it, so this is a minimal ambient declaration covering only `uuid`, the only
 * export this adapter uses.
 */
declare module 'pouchdb-utils' {
  export function uuid(length?: number): string;
}
