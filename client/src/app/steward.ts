/**
 * The steward's side of the shelf (#488, #489; docs/spec/listed-doors.md
 * §6.2, §6.4): importing the steward's secret in Settings, and the console's
 * read and its five notices: release, hold, uphold, suspend and pause.
 *
 * The secret is taken only when both public keys it derives are the ones the
 * app pins (`shelf/steward.ts`), so no other key is ever kept as the
 * steward's, and with no pins none is. It goes into the store through
 * `keepKeys`, sealed in the passkey vault where there is one, and leaves the
 * store only to sign a notice on this device; a copy read out is zeroed once
 * the notice is signed. A notice names a clause and what it acts on, never
 * who reported it (ADR-0013).
 *
 * The console also reads the steward's inbox (#490, `shelf/inbox.ts`): the
 * box secret is derived from the steward's secret for the read and zeroed
 * after, as a notice's signing key is.
 */
import { base64url } from '../crypto/base64url';
import { stewardKeysOf, stewardSecretFrom } from '../crypto/steward';
import type { Relay } from '../net/relay';
import type { Shelf } from '../net/shelf';
import { foldShelf, standingHolds, waitingListings } from '../shelf/fold';
import { type InboxItem, type InboxKeep, readStewardInbox } from '../shelf/inbox';
import { foldNotices, signNotice } from '../shelf/notices';
import type { NoticeBody } from '../shelf/record';
import { STEWARD_PINS, type StewardPins } from '../shelf/steward';
import { type StewardKeyStore, VaultLocked } from '../store/db';
import type { StewardImport } from './StewardKeyCard';
import type { StewardQueue, StewardView } from '../screens/Steward';

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

/** No reports or appeals: the inbox of a console with nothing to read it with. */
const NO_INBOX = (): Promise<InboxItem[]> => Promise.resolve([]);

/**
 * The reports and appeals in the steward's inbox (#490), newest first, read
 * after the cursor `store` keeps, with the box secret derived from the
 * steward's secret on this device; none on a device without one. The
 * secret and the box secret are zeroed once read.
 *
 * @throws {Error} when the relay or the store fails.
 */
export async function readInbox(
  store: Pick<StewardKeyStore, 'getStewardKey'> & InboxKeep,
  relay: Pick<Relay, 'getBlobs'>,
): Promise<InboxItem[]> {
  const secret = await store.getStewardKey();
  if (secret === undefined) return [];
  const { signing, box } = stewardKeysOf(secret);
  secret.fill(0);
  signing.secretKey.fill(0);
  try {
    return await readStewardInbox({ relay, keep: store }, box.secretKey);
  } finally {
    box.secretKey.fill(0);
  }
}

/**
 * The console's view, read fresh from the relay: every held listing beside
 * any live listing that holds its name, what stands on the shelf (every
 * entry at once, as its own group sees it), each hold that stands, and the
 * reports and appeals `inbox` reads (#490). `unavailable` while the relay
 * has no shelf, `failed` when any read fails.
 */
export async function readQueue(
  shelf: Pick<Shelf, 'read' | 'readHeld'>,
  inbox: () => Promise<readonly InboxItem[]> = NO_INBOX,
): Promise<StewardQueue> {
  try {
    const [live, held, items] = await Promise.all([shelf.read(), shelf.readHeld(), inbox()]);
    if (live === null || held === null) return 'unavailable';
    const own = new Set(live.records.map(({ address }) => address));
    const state = foldShelf(live.records, live.now, { own });
    const { released } = foldNotices(live.records);
    const view: StewardView = {
      waiting: waitingListings(held.records, state, released),
      listings: state.listings,
      entries: state.entries,
      holds: standingHolds(live.records, held.records, live.now),
      paused: state.paused,
      inbox: items,
    };
    return view;
  } catch {
    return 'failed';
  }
}

/**
 * Signs `notice` with the steward's key and PUTs it under the steward's
 * address; true once the relay has it, false when the device holds no key
 * that derives the pins or the relay refused it.
 */
export async function sendNotice(
  store: Pick<StewardKeyStore, 'getStewardKey'>,
  shelf: Pick<Shelf, 'put'>,
  notice: NoticeBody,
): Promise<boolean> {
  const secret = await store.getStewardKey().catch(() => undefined);
  if (secret === undefined) return false;
  try {
    if (!derivesPins(secret)) return false;
    const { signing, box } = stewardKeysOf(secret);
    box.secretKey.fill(0);
    const record = signNotice(signing, notice);
    signing.secretKey.fill(0);
    await shelf.put(base64url(signing.publicKey), record);
    return true;
  } catch {
    return false;
  } finally {
    secret.fill(0);
  }
}

/** Signs and PUTs a release of `address`, as {@link sendNotice} does (#488). */
export function releaseListing(
  store: Pick<StewardKeyStore, 'getStewardKey'>,
  shelf: Pick<Shelf, 'put'>,
  address: string,
): Promise<boolean> {
  return sendNotice(store, shelf, { v: 1, kind: 'notice', act: 'release', address });
}
