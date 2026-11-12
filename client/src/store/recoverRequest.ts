/**
 * A recovering device's request (#118): the seed its code and request
 * mailbox come from, the secret half of the X25519 key the contacts' shares
 * are sealed to, and when it started. It lives in the store's device object
 * store under its own key until a backup opens or the person stops.
 *
 * A new device may make its passkey vault at the offer after the pilot
 * notice (#95), before it starts recovering, or during the wait from
 * Settings. On such a device the seed and secret key go into the vault
 * ({@link requestSealing}, `./sealing.ts`), as a share's keys do (#255), and
 * the record keeps only when the request started.
 */
import type { Sealing } from './sealing';

/** The request whole: its seed, its X25519 secret key, and when it started, in device ms. */
export interface RecoverRequest {
  readonly seed: Uint8Array;
  readonly secretKey: Uint8Array;
  readonly startedAt: number;
}

/** The request as IndexedDB keeps it: whole on a device with no vault, or only when it started under one. */
export interface StoredRecoverRequest {
  readonly seed?: Uint8Array;
  readonly secretKey?: Uint8Array;
  readonly startedAt: number;
}

/**
 * A recovering device's sealing (#118): its seed and X25519 secret key go
 * into the vault, and its record keeps when it started.
 */
export const requestSealing: Sealing<RecoverRequest, StoredRecoverRequest> = {
  hasSecrets: () => true,
  split(request) {
    const { seed, secretKey, startedAt } = request;
    if (seed === undefined || secretKey === undefined) return { kept: request, secrets: null };
    return { kept: { startedAt }, secrets: { seed, secretKey } };
  },
  join(request, secrets) {
    const { seed, secretKey } = secrets ?? {};
    return seed === undefined || secretKey === undefined
      ? null
      : { seed, secretKey, startedAt: request.startedAt };
  },
};
