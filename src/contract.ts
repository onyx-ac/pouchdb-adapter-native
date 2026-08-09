/**
 * Hand-mirrored from `permetic-web/src/index.d.ts`'s Transport section
 * (`BridgeRequest`, `BridgeResponse`, `BridgeError`, `BridgeErrorCode`, `Carrier`) -
 * the same "contract drift is a compile error" discipline
 * `DocumentStore.kt`/`StorageDispatcher.kt` already follow on the Kotlin side, not a
 * reach-across import: this package must build standalone, and no shared npm package
 * for the contract exists yet.
 */
export const CONTRACT_VERSION = 1;

export interface BridgeRequest {
  v: typeof CONTRACT_VERSION;
  /** Correlation id, unique per in-flight request. */
  id: string;
  capability: 'storage';
  method: string;
  args: readonly unknown[];
}

export type BridgeResponse =
  | { v: 1; id: string; ok: true; value: unknown }
  | { v: 1; id: string; ok: false; error: BridgeError };

export type BridgeErrorCode =
  | 'UNAVAILABLE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'CANCELLED'
  | 'NETWORK'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  /** Never contains a stack trace in release builds. */
  details?: Record<string, unknown>;
}

/**
 * The only host-specific code in the system. WebView: WebMessageListener. Headless:
 * one bound Zipline suspending function. Everything above is identical (ADR-0002).
 *
 * `subscribeChanges` can't cross as a `Promise<BridgeResponse>` - it's a live push
 * subscription, not a request/response call - so it isn't dispatched through the
 * envelope the way every other method is. It's attached directly on the carrier
 * object instead, same carve-out `StorageDispatcher.kt`'s `DISPATCHED_METHODS` split
 * already makes on the Kotlin side.
 */
export interface Carrier {
  (req: BridgeRequest): Promise<BridgeResponse>;
  subscribeChanges?(db: string, since: number, listener: (change: StoredDocWire) => void): () => void;
}

export interface StoredDocWire {
  id: string;
  rev: string;
  seq: number;
  deleted: boolean;
  body?: Record<string, unknown> | null;
  conflicts?: string[];
}
