/**
 * The steward's secret (#488; docs/spec/listed-doors.md §6.2), on the one
 * device that holds it: the 32 bytes both of the steward's keys derive from
 * (`crypto/steward.ts`), and when it was imported. It lives in the store's
 * device object store under its own key, and is written only through
 * `keepKeys`: on a device with a passkey vault the secret goes into the vault
 * ({@link stewardSealing}, `./sealing.ts`), as a recovering device's request
 * does (#118), and the record keeps only when it was imported. No backup file
 * or link carries it: the steward keeps the secret offline.
 */
import type { Sealing } from './sealing';

/** The steward's key whole: its secret, and when it was imported, in device ms. */
export interface StewardKey {
  readonly secret: Uint8Array;
  readonly stewardSince: number;
}

/** The key as IndexedDB keeps it: whole with no vault, or only when it was imported under one. */
export interface StoredStewardKey {
  readonly secret?: Uint8Array;
  readonly stewardSince: number;
}

/** The steward key's sealing (#488): its secret goes into the vault, its record keeps the time. */
export const stewardSealing: Sealing<StewardKey, StoredStewardKey> = {
  hasSecrets: () => true,
  split(key) {
    const { secret, stewardSince } = key;
    return secret === undefined
      ? { kept: key, secrets: null }
      : { kept: { stewardSince }, secrets: { secret } };
  },
  join(key, secrets) {
    const secret = secrets?.secret;
    return secret === undefined ? null : { secret, stewardSince: key.stewardSince };
  },
};
