/**
 * `pouchdb-merge` ships no TypeScript declarations and there's no `@types` package
 * for it, so this is a minimal ambient declaration covering only what this adapter
 * actually uses (`merge`/`winningRev`/`isDeleted`/`revExists`/`isLocalId`).
 */
declare module 'pouchdb-merge' {
  /** `[revId, opts, children]` - CouchDB's key-tree node shape. */
  export type RevTreeNode = [string, Record<string, unknown>, RevTreeNode[]];

  export interface RevTreePath {
    pos: number;
    ids: RevTreeNode;
  }

  export type RevTree = RevTreePath[];

  export interface DocMetadata {
    id?: string;
    rev?: string;
    rev_tree: RevTree;
    deleted?: boolean;
    winningRev?: string;
  }

  export interface MergeResult {
    tree: RevTree;
    stemmedRevs: string[];
    conflicts: false | 'new_leaf' | 'new_branch' | 'internal_node';
  }

  export function merge(tree: RevTree, path: RevTreePath, depth: number): MergeResult;
  /** Marks every non-leaf 'available' node 'missing', in place, and returns the
   * cut revs - "compact down to leaves only", the semantics `auto_compaction`
   * needs (stronger than `merge()`'s depth-bounded stemming). */
  export function compactTree(metadata: { rev_tree: RevTree }): string[];
  export function winningRev(metadata: DocMetadata): string;
  export function isDeleted(metadata: DocMetadata, rev?: string): boolean;
  export function revExists(tree: RevTree, rev: string): boolean;
  export function isLocalId(id: string): boolean;

  /** Walks every node once, root to leaf; `opts` is the tree's own node object
   * (`tree[1]`), not a copy - mutating it (e.g. `opts.status = 'missing'`) rewrites
   * the tree in place. Return value becomes `ctx` for that node's children. */
  export function traverseRevTree(
    tree: RevTree,
    callback: (isLeaf: boolean, pos: number, revHash: string, ctx: unknown, opts: Record<string, unknown>) => unknown,
  ): void;
}
