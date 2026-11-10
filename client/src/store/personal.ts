/**
 * Personal Documents (#93; ADR-0001; ADR-0074's personal page at level 2): a
 * person's own mission statement, and any other Document they keep beside
 * it, edited directly with no Proposal or vote.
 *
 * A personal statement may be the most identifying thing anyone writes in
 * Reconcile, so it lives only in this device's IndexedDB, in a store of its
 * own beside the groups (`db.ts`). It leaves the device only inside the
 * passphrase-sealed backup file (`snapshot.ts`), and Erase deletes it with the
 * rest of the database. Nothing here touches the network, and no relay-bound
 * record carries it.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { nfcLength } from '../engine/text';

/** One personal Document, as the device keeps it and a backup file carries it. */
export interface PersonalDocument {
  /** {@link PERSONAL_ID_BYTES} random bytes in unpadded base64url, made on this device. */
  readonly id: string;
  /** 1 to {@link PERSONAL_TITLE_MAX} code points after NFC, with no space around it. */
  readonly title: string;
  /** The Markdown text, as typed: Preview normalizes it, and the store never does. */
  readonly text: string;
  /** When it was first saved, in device milliseconds. */
  readonly createdAt: number;
  /** When it was last saved, in device milliseconds; a restore keeps the later copy. */
  readonly updatedAt: number;
}

/** How many random bytes a personal Document's id holds: 128 bits, so two never meet. */
export const PERSONAL_ID_BYTES = 16;

/** The longest title, in code points after NFC, as a Proposal's title (spec §4). */
export const PERSONAL_TITLE_MAX = 120;

/** Where personal Documents are kept: the device's store (`openStore`). */
export interface PersonalStore {
  /** Every personal Document on the device, oldest first, so the first one written leads. */
  listPersonal(): Promise<PersonalDocument[]>;
  /** One personal Document, or `undefined` when the device holds none under `id`. */
  getPersonal(id: string): Promise<PersonalDocument | undefined>;
  /**
   * Keeps `document`, replacing any copy under its id.
   *
   * @throws {Error} when it isn't well formed ({@link isPersonalDocument}); nothing changes then.
   */
  savePersonal(document: PersonalDocument): Promise<void>;
  /** Deletes the personal Document `id` from this device; an id it doesn't hold is left alone. */
  deletePersonal(id: string): Promise<void>;
}

/** A new personal Document's id: {@link PERSONAL_ID_BYTES} from the platform's CSPRNG. */
export function newPersonalId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(PERSONAL_ID_BYTES)));
}

/** Whether `value` is an id this device makes: 16 bytes in canonical unpadded base64url. */
function isPersonalId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const bytes = fromBase64url(value);
    return bytes.length === PERSONAL_ID_BYTES && base64url(bytes) === value;
  } catch {
    return false;
  }
}

/** Whether `value` is a title the editor accepts: trimmed, and 1 to 120 code points after NFC. */
export function isPersonalTitle(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  const length = nfcLength(value);
  return length >= 1 && length <= PERSONAL_TITLE_MAX;
}

/** Whether `value` is a time in whole device milliseconds from 0 up. */
function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Whether `value` is a personal Document the device can keep: a 16-byte id, a
 * title the editor accepts, text, and whole times, last edited no earlier
 * than it was made. A backup's are checked with this before anything is kept.
 */
export function isPersonalDocument(value: unknown): value is PersonalDocument {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, text, createdAt, updatedAt } = value as Record<string, unknown>;
  const shaped = isPersonalId(id) && isPersonalTitle(title) && typeof text === 'string';
  return shaped && isTime(createdAt) && isTime(updatedAt) && updatedAt >= createdAt;
}

/**
 * Whether a restore keeps the device's `held` copy over the backup's
 * `restored` one: whenever the device has one edited no earlier. A tie keeps
 * the device's, as a group already on it does.
 */
export function keepsHeldCopy(
  held: PersonalDocument | undefined,
  restored: PersonalDocument,
): boolean {
  return held !== undefined && held.updatedAt >= restored.updatedAt;
}

/** Oldest first, then by id, so the order never depends on how the store returned them. */
export function byCreation(a: PersonalDocument, b: PersonalDocument): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}
