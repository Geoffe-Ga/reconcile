/**
 * The steward's side of the shelf (#488; docs/spec/listed-doors.md §6.2,
 * §6.4): importing the steward's secret in Settings, and the console's read
 * and its Release.
 *
 * The secret is taken only when both public keys it derives are the ones the
 * app pins (`shelf/steward.ts`), so no other key is ever kept as the
 * steward's, and with no pins none is. It goes into the store through
 * `keepKeys`, sealed in the passkey vault where there is one, and leaves the
 * store only to sign a release on this device; a copy read out is zeroed once
 * the notice is signed.
 */
import { base64url } from '../crypto/base64url';
import { stewardKeysOf, stewardSecretFrom } from '../crypto/steward';
import type { Shelf } from '../net/shelf';
import { foldShelf, waitingListings } from '../shelf/fold';
import { signNotice } from '../shelf/notices';
import { STEWARD_PINS, type StewardPins } from '../shelf/steward';
import { type StewardKeyStore, VaultLocked } from '../store/db';
import type { StewardImport } from './StewardKeyCard';
import type { StewardQueue } from '../screens/Steward';

/** Whether `secret` derives exactly the two keys `pins` holds. */
export function derivesPins(secret: Uint8Array, pins: StewardPins | null = STEWARD_PINS): boolean {
  if (pins === null) return false;
  const { signing, box } = stewardKeysOf(secret);
  signing.secretKey.fill(0);
  box.secretKey.fill(0);
  return base64url(signing.publicKey) === pins.sign && base64url(box.publicKey) === pins.box;
}

/**
 * Keeps the secret `text` spells as the steward's at device time `at`, when
 * it derives the pinned keys: `wrong` when it doesn't, `locked` on a device
 * whose vault isn't open, `failed` when the store refused it otherwise.
 */
export async function importStewardKey(
  store: Pick<StewardKeyStore, 'keepStewardKey'>,
  text: string,
  at: number,
): Promise<StewardImport> {
  const secret = stewardSecretFrom(text);
  if (secret === null || !derivesPins(secret)) return 'wrong';
  try {
    await store.keepStewardKey(secret, at);
    return 'imported';
  } catch (error) {
    return error instanceof VaultLocked ? 'locked' : 'failed';
  } finally {
    secret.fill(0);
  }
}

/**
 * The console's queue: every held listing, beside any live listing that
 * holds its name, read fresh from the relay. `unavailable` while the relay
 * has no shelf, `failed` when either read fails.
 */
export async function readQueue(shelf: Pick<Shelf, 'read' | 'readHeld'>): Promise<StewardQueue> {
  try {
    const [live, held] = await Promise.all([shelf.read(), shelf.readHeld()]);
    if (live === null || held === null) return 'unavailable';
    return waitingListings(held.records, foldShelf(live.records, live.now));
  } catch {
    return 'failed';
  }
}

/**
 * Signs a release of `address` with the steward's key and PUTs it under the
 * steward's address; true once the relay has it, false when the device holds
 * no key that derives the pins or the relay refused it.
 */
export async function releaseListing(
  store: Pick<StewardKeyStore, 'getStewardKey'>,
  shelf: Pick<Shelf, 'put'>,
  address: string,
): Promise<boolean> {
  const secret = await store.getStewardKey().catch(() => undefined);
  if (secret === undefined) return false;
  try {
    if (!derivesPins(secret)) return false;
    const { signing, box } = stewardKeysOf(secret);
    box.secretKey.fill(0);
    const record = signNotice(signing, { v: 1, kind: 'notice', act: 'release', address });
    signing.secretKey.fill(0);
    await shelf.put(base64url(signing.publicKey), record);
    return true;
  } catch {
    return false;
  } finally {
    secret.fill(0);
  }
}
