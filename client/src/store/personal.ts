/**
 * Personal Documents (#93; ADR-0001; ADR-0074's personal page at level 2): a
 * person's own mission statement, and any other Document they keep beside
 * it, edited directly with no Proposal or vote.
 *
 * A personal statement may be the most identifying thing anyone writes in
 * Reconcile, so it lives only in this device's IndexedDB, in a store of its
 * own beside the groups (`db.ts`). It leaves the device only inside the
 * passphrase-sealed backup file (`snapshot.ts`), and Erase deletes it with the
 * rest of the database. Nothing here touches the network, and no group's
 * record carries it.
 *
 * The one deliberate exception is a share by link (#105), which the person
 * turns on for one Document: its {@link ShareState} sits on that Document's
 * record, so a backup carries it, and `src/share/shareLink.ts` posts the
 * Document's latest version, signed and sealed, to a mailbox of the share's
 * own. Only `updateShare` sets or drops it; the editor's saves keep it. On a
 * device whose keys are locked with a passkey, its seed, signing key and
 * public key live in the vault instead, and the record keeps only the
 * share's mark ({@link shareSealing}, #255), so the editor's saves write no
 * key, and Personal and the editor still read whether it's shared while the
 * vault is locked.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { publicKeyOf } from '../crypto/sign';
import { nfcLength } from '../engine/text';
import type { Sealing } from './sealing';
import type { Secrets } from './vault';

/**
 * A personal Document's share by link (#105). Every key in it is the share's
 * own, made for it alone and used for nothing else, so nothing the relay
 * stores ties the share to the person's groups.
 */
export interface ShareState {
  /** The 32 random bytes after `#share/` in the link: the share's mailbox id and seal key derive from them. */
  readonly seed: Uint8Array;
  /** The share's own Ed25519 secret key, which signs each copy. It never leaves the device but in a backup. */
  readonly secretKey: Uint8Array;
  /** Its public key, which the link carries, so a reader keeps only the copies it signed. */
  readonly publicKey: Uint8Array;
  /** The `n` of the last copy this device posted, or 0 before the first. */
  readonly n: number;
  /** When this device last posted a copy, in device milliseconds, or null before the first. */
  readonly lastPostedAt: number | null;
  /** Whether the link may show less than the Document holds: an edit not posted yet, or a post that failed. */
  readonly pending: boolean;
}

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
  /** Its share by link (#105), only while it is shared. */
  readonly share?: ShareState;
}

/** What the editor saves: a personal Document's words and times, never its share. */
export type PersonalText = Omit<PersonalDocument, 'share'>;

/** A share's keys: its seed, signing key and public key, everything that ties it to its link (#255). */
export type ShareKeys = Pick<ShareState, 'seed' | 'secretKey' | 'publicKey'>;

/** What a share says without its keys: what a vault leaves on its Document's record (#255). */
export type ShareMark = Omit<ShareState, keyof ShareKeys>;

/**
 * A personal Document as IndexedDB keeps it: its share whole on a device
 * with no vault, and only its mark under a vault, which holds its keys
 * (#255). A share kept before #255 holds its keys until the device seals or
 * unlocks.
 */
export interface StoredDocument extends PersonalText {
  readonly share?: ShareMark & Partial<ShareKeys>;
}

/**
 * A personal Document as Personal lists it and its editor opens it: its
 * words and times, and its share's mark while it's shared, with no key, so a
 * device whose keys are locked shows it too (#255).
 */
export interface PersonalEntry extends PersonalText {
  readonly share?: ShareMark;
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
   * Every personal Document as Personal and the editor show it, oldest first:
   * no key, so it never opens the vault and reads the same while it's locked
   * (#255).
   */
  listPersonalEntries(): Promise<PersonalEntry[]>;
  /**
   * Keeps `document`, replacing any copy under its id, in one change. A
   * share the device holds under that id stays, marked `pending` when the
   * title or text changed, so the link catches up (#105); a `share` on
   * `document` itself is never kept.
   *
   * @throws {Error} when it isn't well formed ({@link isPersonalDocument}); nothing changes then.
   */
  savePersonal(document: PersonalText): Promise<void>;
  /**
   * Sets the share of the Document `id` to what `edit` makes of the stored
   * Document, or drops it when `edit` returns undefined, in one change (#105),
   * and returns the Document as kept. A Document the device doesn't hold is
   * left alone, and undefined comes back, so no share brings one back.
   *
   * @throws {Error} when the share isn't well formed ({@link isShareState}); nothing changes then.
   */
  updateShare(
    id: string,
    edit: (document: PersonalDocument) => ShareState | undefined,
  ): Promise<PersonalDocument | undefined>;
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

/** A share's seed and keys are 32 bytes each. */
const SHARE_KEY_BYTES = 32;

/**
 * Whether `value` is 32 bytes: a `Uint8Array` from any realm, since IndexedDB
 * hands back clones that need not share this page's constructor.
 */
function isKey(value: unknown): value is Uint8Array {
  const bytes = Object.prototype.toString.call(value) === '[object Uint8Array]';
  return bytes && (value as Uint8Array).length === SHARE_KEY_BYTES;
}

/** Whether `publicKey` is the one `secretKey` makes, so the copies it signs are ones the link keeps. */
function isKeypair(secretKey: Uint8Array, publicKey: Uint8Array): boolean {
  const made = publicKeyOf(secretKey);
  return made.every((byte, i) => byte === publicKey[i]);
}

/**
 * Whether `value` is a share the device can keep (#105): a 32-byte seed, a
 * keypair whose public key is its secret key's own, a whole `n` from 0 up,
 * a whole post time or null, and a pending flag.
 */
export function isShareState(value: unknown): value is ShareState {
  if (typeof value !== 'object' || value === null) return false;
  const { seed, secretKey, publicKey, n, lastPostedAt, pending } = value as Record<string, unknown>;
  const counted = isTime(n) && (lastPostedAt === null || isTime(lastPostedAt));
  if (!counted || typeof pending !== 'boolean') return false;
  return isKey(seed) && isKey(secretKey) && isKey(publicKey) && isKeypair(secretKey, publicKey);
}

/**
 * Whether `value` is a personal Document the device can keep: a 16-byte id, a
 * title the editor accepts, text, and whole times, last edited no earlier
 * than it was made, and a share that checks out when it has one (#105). A
 * backup's are checked with this before anything is kept.
 */
export function isPersonalDocument(value: unknown): value is PersonalDocument {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, text, createdAt, updatedAt, share } = value as Record<string, unknown>;
  const shaped = isPersonalId(id) && isPersonalTitle(title) && typeof text === 'string';
  const timed = isTime(createdAt) && isTime(updatedAt) && updatedAt >= createdAt;
  return shaped && timed && (share === undefined || isShareState(share));
}

/** `document`'s words and times, without any share it carries. */
export function textOf(document: PersonalText): PersonalText {
  const { id, title, text, createdAt, updatedAt } = document;
  return { id, title, text, createdAt, updatedAt };
}

/**
 * The share to keep when the editor saves `saved` over `held` (#105): the
 * held share, as its record holds it, marked pending once the title or text
 * changed, so the link catches up; none when the device held none. Under a
 * vault the record holds only the share's mark, so a save writes no key
 * (#255).
 */
export function keptShare<Share extends ShareMark>(
  held: (PersonalText & { readonly share?: Share }) | undefined,
  saved: PersonalText,
): Share | undefined {
  const share = held?.share;
  if (share === undefined) return undefined;
  const changed = held?.title !== saved.title || held.text !== saved.text;
  return changed ? { ...share, pending: true } : share;
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

/**
 * What a restore keeps when the backup's `restored` copy replaces the
 * device's `held` one: the file's copy, but with the device's share when the
 * file's copy holds none, marked pending so its link catches up (#105). A
 * live link is never lost to a restore, so the person can still stop it.
 */
export function restoredCopy(
  held: PersonalDocument | undefined,
  restored: PersonalDocument,
): PersonalDocument {
  if (restored.share !== undefined || held?.share === undefined) return restored;
  return { ...restored, share: { ...held.share, pending: true } };
}

/** Oldest first, then by id, so the order never depends on how the store returned them. */
export function byCreation(a: PersonalText, b: PersonalText): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

/** A share's mark: everything it says but its keys. */
function markOf(share: ShareMark): ShareMark {
  return { n: share.n, lastPostedAt: share.lastPostedAt, pending: share.pending };
}

/** `document` as Personal and the editor show it: its words and times, and its share's mark. */
export function entryOf(document: StoredDocument): PersonalEntry {
  const { share } = document;
  return { ...textOf(document), ...(share === undefined ? {} : { share: markOf(share) }) };
}

/**
 * A personal Document's sealing (#255): its share's seed, signing key and
 * public key go into the vault, and its record keeps the share's mark, so a
 * Document's words, and whether it's shared, still read while the vault is
 * locked.
 */
export const shareSealing: Sealing<PersonalDocument, StoredDocument> = {
  hasSecrets: (document) => document.share !== undefined,
  split(document) {
    const { share } = document;
    const { seed, secretKey, publicKey } = share ?? {};
    if (share === undefined || !seed || !secretKey || !publicKey) {
      return { kept: document, secrets: null };
    }
    return {
      kept: { ...textOf(document), share: markOf(share) },
      secrets: { seed, secretKey, publicKey },
    };
  },
  join(document, secrets) {
    const { share } = document;
    if (share === undefined) return textOf(document);
    const held: Secrets = secrets ?? {};
    const { seed, secretKey, publicKey } = held;
    if (!seed || !secretKey || !publicKey) return null;
    return { ...textOf(document), share: { ...markOf(share), seed, secretKey, publicKey } };
  },
};
