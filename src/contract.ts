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
 */
export type Carrier = (req: BridgeRequest) => Promise<BridgeResponse>;
