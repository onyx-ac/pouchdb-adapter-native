import type { Carrier } from './contract';

export interface NativeAdapterOptions {
  carrier: Carrier;
}

const ADAPTER_NAME = 'native';

type Callback = (err: Error | null, result?: unknown) => void;

function notImplemented(method: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`NativeAdapter.${method} not implemented yet (spec 03)`);
  };
}

/**
 * PouchDB adapter over docstack-store's envelope protocol (spec 03). Registered via
 * `PouchDB.plugin(NativeAdapter({ carrier }))` - same code in the WebView and the
 * headless carrier, only `carrier` differs (ADR-0002); no carrier branch lives here.
 *
 * This pass is a skeleton (spec 03 task 1: conformance harness first, not method
 * coverage). Every `_method` below is a stub; `_info`/`_get`/`_getRevisionTree`/local
 * docs (task 2), `_bulkDocs` with `pouchdb-merge` (task 3), and the rest follow as
 * separate, reviewed steps.
 */
export function NativeAdapter(options: NativeAdapterOptions) {
  return function plugin(PouchDBConstructor: any): void {
    function NativePouchAdapter(this: any, _opts: unknown, callback: Callback): void {
      this.carrier = options.carrier;

      this._info = notImplemented('_info');
      this._get = notImplemented('_get');
      this._bulkDocs = notImplemented('_bulkDocs');
      this._allDocs = notImplemented('_allDocs');
      this._changes = notImplemented('_changes');
      this._getRevisionTree = notImplemented('_getRevisionTree');
      this._doCompaction = notImplemented('_doCompaction');
      this._getLocal = notImplemented('_getLocal');
      this._putLocal = notImplemented('_putLocal');
      this._removeLocal = notImplemented('_removeLocal');
      this._getAttachment = notImplemented('_getAttachment');
      this._revsDiff = notImplemented('_revsDiff');
      this._bulkGet = notImplemented('_bulkGet');
      this._destroy = notImplemented('_destroy');
      this._close = notImplemented('_close');

      callback(null, this);
    }

    (NativePouchAdapter as any).valid = (): boolean => true;
    PouchDBConstructor.adapter(ADAPTER_NAME, NativePouchAdapter, true);
  };
}

export type { Carrier, BridgeRequest, BridgeResponse, BridgeError, BridgeErrorCode } from './contract';
