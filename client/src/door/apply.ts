/**
 * Asking to join at a front door, from the applicant's device (#121;
 * ADR-0038, ADR-0014).
 *
 * The form asks for the name they'd like to use and why they'd like to join,
 * and nothing else: no contact details. Send makes a reply X25519 key and a
 * random 32-byte reply seed, keeps both on the device, and PUTs the
 * application, `{name, message, reply: {seed, key}}` as UTF-8 JSON, sealed to
 * the page's `box` key and padded to a blob size (`crypto/door.ts`), to the
 * door's inbox for 30 days. Only the members' devices open it.
 *
 * It may also carry a copy of up to {@link DOCUMENTS_MAX} of the applicant's
 * personal Documents (#425; ADR-0077 §3), `documents: [{title, text}]` after
 * the reply, only when they chose some: their titles and text, never an id,
 * a time, a share or anything else the device keeps of them, so no link ties
 * one application to another (ADR-0009). An application without them is
 * byte for byte what the app wrote before. The copy travels inside the one
 * sealed, padded blob, under {@link DOCUMENTS_MAX_BYTES}, which is what the
 * largest blob has left once the longest application without documents is
 * in it, so every application the form lets through fits one blob. The
 * applicant's device keeps no copy: what it sent is still its own Document.
 *
 * A member answers with an invite link sealed to the reply key, in the reply
 * mailbox the seed derives. For {@link SENT_DAYS} days, every sync reads each
 * pending application's reply mailbox ({@link checkReplies}); a reply that
 * opens and carries an invite link keeps its seed with the application, and
 * Your groups shows "<group name> invited you", which leads into Join. The
 * invite then admits them as any invite does: vouches and the wait still
 * apply (ADR-0014, #101).
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { isUsableKxKey, kxPublicKeyOf, newKxKey } from '../crypto/box';
import {
  APPLICATION_INFO,
  applicationIdOf,
  doorChannelsOf,
  MAX_PADDED_PLAINTEXT,
  newReplySeed,
  openPadded,
  REPLY_INFO,
  replyMailboxOf,
  sealPadded,
} from '../crypto/door';
import { codePointLength } from '../engine/text';
import type { Relay } from '../net/relay';
import {
  type ApplicationDocument,
  SENT_DAYS,
  type SentApplication,
  type SentStore,
} from '../store/applications';
import { fragmentOf, keyIn, type OpenPage } from './page';

/** The longest name an application carries, in code points: an invite preview's limit. */
export const NAME_MAX = 120;

/** The longest message an application carries, in code points: a justification's limit. */
export const MESSAGE_MAX = 2_000;

/** How long the relay keeps an application: its 30-day blob retention (ADR-0057). */
export const APPLICATION_TTL_DAYS = 30;

/** The most personal Documents one application carries a copy of (#425). */
export const DOCUMENTS_MAX = 3;

/** The longest title a copy carries, in code points: a personal Document's own limit. */
const TITLE_MAX = 120;

const DAY_MS = 86_400_000;

/** What an application says: the applicant's chosen name, why, and where an invite goes. */
export interface Application {
  readonly name: string;
  readonly message: string;
  /** The reply seed and the reply X25519 public key, each in unpadded base64url. */
  readonly reply: { readonly seed: string; readonly key: string };
  /** A copy of 1 to 3 of their personal Documents, only when they chose some (#425). */
  readonly documents?: readonly ApplicationDocument[];
}

/** What the form hands Send: the two fields as typed, and the personal Documents chosen, if any. */
export interface ApplyValues {
  readonly name: string;
  readonly message: string;
  /** The chosen Documents: only each one's title and text goes, whatever else they hold. */
  readonly documents?: readonly ApplicationDocument[];
}

/** Why a choice of Documents can't go with an application: too many, or too long together. */
export type DocumentsProblem = 'too-many' | 'too-long';

/** What Send reaches: the relay, where the device keeps what it sent, and its clock. */
export interface ApplyServices {
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly store: Pick<SentStore, 'addSent'>;
  /** The device clock in milliseconds: when it was sent. */
  readonly now: () => number;
}

/** What reading replies reaches. */
export interface ReplyServices {
  readonly relay: Pick<Relay, 'getBlobs'>;
  readonly store: Pick<SentStore, 'listSent' | 'updateSent' | 'dropSent'>;
  readonly now: () => number;
}

/** Each document's title and text alone, in that order, as an application carries them. */
function copiesOf(documents: readonly ApplicationDocument[]): ApplicationDocument[] {
  return documents.map(({ title, text }) => ({ title, text }));
}

/**
 * `application` as the bytes it's sealed as: compact JSON, its keys in a
 * fixed order, `documents` last and only when it carries some.
 */
export function encodeApplication(application: Application): Uint8Array<ArrayBuffer> {
  const { name, message, reply, documents = [] } = application;
  const json = {
    name,
    message,
    reply: { seed: reply.seed, key: reply.key },
    ...(documents.length === 0 ? {} : { documents: copiesOf(documents) }),
  };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/** The bytes `documents` take in an application: their list as compact JSON, in UTF-8. */
function documentsBytes(documents: readonly ApplicationDocument[]): number {
  return new TextEncoder().encode(JSON.stringify(copiesOf(documents))).length;
}

/**
 * The bytes the longest application without documents takes: a name of 120
 * code points and a message of 2,000, each escaped to six bytes (`\u0000`),
 * the most JSON spends on one code point, and a reply.
 */
const LONGEST_WITHOUT = encodeApplication({
  name: '\u0000'.repeat(NAME_MAX),
  message: '\u0000'.repeat(MESSAGE_MAX),
  reply: { seed: 'A'.repeat(43), key: 'A'.repeat(43) },
}).length;

/**
 * The most bytes the documents may take together, as {@link documentsBytes}
 * counts them: what the largest padded box carries (65,460) less the longest
 * application without them (12,859) and the field's own `,"documents":`, so
 * 52,588. Any name and message the form takes then fit beside them in one
 * 64 KiB blob.
 */
export const DOCUMENTS_MAX_BYTES = MAX_PADDED_PLAINTEXT - LONGEST_WITHOUT - ',"documents":'.length;

/**
 * Why `documents` can't go with an application, or null when they can:
 * more than {@link DOCUMENTS_MAX}, or more than {@link DOCUMENTS_MAX_BYTES}
 * together, as they're sealed.
 */
export function documentsProblem(
  documents: readonly ApplicationDocument[],
): DocumentsProblem | null {
  if (documents.length > DOCUMENTS_MAX) return 'too-many';
  return documentsBytes(documents) > DOCUMENTS_MAX_BYTES ? 'too-long' : null;
}

/** The JSON object `bytes` spell in UTF-8, or null. */
function objectIn(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether `value` is text of at most `max` code points. */
function textUpTo(value: unknown, max: number): value is string {
  return typeof value === 'string' && codePointLength(value) <= max;
}

/** The reply an application names: a 32-byte seed and a key a box can be sealed to, or null. */
function replyIn(value: unknown): Application['reply'] | null {
  const json =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const { seed, key } = json;
  if (Object.keys(json).sort().join() !== 'key,seed') return null;
  if (typeof seed !== 'string' || typeof key !== 'string' || keyIn(seed) === null) return null;
  const bytes = keyIn(key);
  return bytes !== null && isUsableKxKey(bytes) ? { seed, key } : null;
}

/** Whether `value` is text of 1 to `max` code points that isn't blank. */
function filledUpTo(value: unknown, max: number): value is string {
  return textUpTo(value, max) && value.trim() !== '';
}

/** The copy `value` spells: exactly a title of 1 to 120 code points, not blank, and text; or null. */
function documentIn(value: unknown): ApplicationDocument | null {
  if (typeof value !== 'object' || value === null) return null;
  const json = value as Record<string, unknown>;
  const { title, text } = json;
  if (Object.keys(json).sort().join() !== 'text,title') return null;
  return filledUpTo(title, TITLE_MAX) && typeof text === 'string' ? { title, text } : null;
}

/** The copies `value` lists: 1 to 3 well-formed documents within the cap, or null. */
function documentsIn(value: unknown): ApplicationDocument[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const documents = value.map(documentIn);
  if (documents.some((document) => document === null)) return null;
  const read = documents as ApplicationDocument[];
  return documentsProblem(read) === null ? read : null;
}

/** The keys an application holds: today's three, and `documents` beside them (#425). */
const KEYS = ['message,name,reply', 'documents,message,name,reply'];

/**
 * The application `bytes` spell, or null: anything but exactly a name of 1
 * to 120 code points, not blank, a message of at most 2,000, a reply a box
 * can be sealed to and, when it carries any, 1 to 3 documents within the cap
 * (#425), is refused, so a member's device shows nothing else and never
 * fails to answer one it shows.
 */
export function parseApplication(bytes: Uint8Array): Application | null {
  const json = objectIn(bytes);
  if (json === null || !KEYS.includes(Object.keys(json).sort().join())) return null;
  const { name, message } = json;
  if (!filledUpTo(name, NAME_MAX) || !textUpTo(message, MESSAGE_MAX)) return null;
  const reply = replyIn(json.reply);
  if (reply === null) return null;
  if (!('documents' in json)) return { name, message, reply };
  const documents = documentsIn(json.documents);
  return documents === null ? null : { name, message, reply, documents };
}

/** An invite link's own form, as a reply carries it. */
const INVITE = /^#join\/([A-Za-z0-9_-]{43})$/;

/** The 32-byte invite seed in a reply's invite link, from any origin, or null. */
export function inviteSeedIn(text: string): Uint8Array | null {
  const [, seed] = INVITE.exec(fragmentOf(text.trim()) ?? '') ?? [];
  return seed === undefined ? null : keyIn(seed);
}

/**
 * The copy of `documents` an application carries: each title and text
 * alone, in NFC. The form measures this, so what it lets through is what
 * Send seals.
 */
export function documentCopies(documents: readonly ApplicationDocument[]): ApplicationDocument[] {
  return documents.map(({ title, text }) => ({
    title: title.normalize('NFC'),
    text: text.normalize('NFC'),
  }));
}

/**
 * Send: seals the application to `page`'s box key, padded, PUTs it to the
 * door's inbox for 30 days, and only once the relay has it keeps the reply
 * seed and key on this device. Offline, nothing is kept. The name and message
 * are trimmed and NFC-normalized first, and each chosen Document's title and
 * text is NFC-normalized ({@link documentCopies}, #425); a choice the form
 * would refuse ({@link documentsProblem}) sends nothing.
 */
export async function apply(
  services: ApplyServices,
  address: Uint8Array,
  page: OpenPage,
  values: ApplyValues,
): Promise<'sent' | 'failed'> {
  const documents = documentCopies(values.documents ?? []);
  if (documentsProblem(documents) !== null) return 'failed';
  const seed = newReplySeed();
  const replyKey = newKxKey();
  const application = {
    name: values.name.trim().normalize('NFC'),
    message: values.message.trim().normalize('NFC'),
    reply: { seed: base64url(seed), key: base64url(kxPublicKeyOf(replyKey)) },
    documents,
  };
  const { inbox } = doorChannelsOf(address);
  try {
    const box = fromBase64url(page.box);
    const blob = sealPadded(box, encodeApplication(application), APPLICATION_INFO, inbox);
    await services.relay.putBlob(inbox, blob, APPLICATION_TTL_DAYS);
    const sent: SentApplication = {
      id: applicationIdOf(blob),
      door: base64url(address),
      groupName: page.name,
      seed,
      replyKey,
      sentAt: services.now(),
    };
    await services.store.addSent(sent);
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** The invite seed in the last reply in `mailbox` that opens under `replyKey`, or null. */
async function latestInvite(
  relay: ReplyServices['relay'],
  sent: SentApplication,
): Promise<Uint8Array | null> {
  const mailbox = replyMailboxOf(sent.seed);
  const { records } = await relay.getBlobs(mailbox, 0);
  let invite: Uint8Array | null = null;
  for (const { data } of records) {
    const plaintext = openPadded(sent.replyKey, data, REPLY_INFO, mailbox);
    const seed = plaintext === null ? null : inviteSeedIn(new TextDecoder().decode(plaintext));
    invite = seed ?? invite;
  }
  return invite;
}

/** Whether `a` and `b` hold the same bytes, or are both absent. */
function same(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  return base64url(a ?? new Uint8Array()) === base64url(b ?? new Uint8Array());
}

/**
 * Forgets each application whose reply carried the invite `seed`, once this
 * device has joined with it: Your groups then lists the group itself.
 */
export async function forgetJoined(
  store: Pick<SentStore, 'listSent' | 'dropSent'>,
  seed: Uint8Array,
): Promise<void> {
  for (const sent of await store.listSent()) {
    if (sent.invite !== undefined && same(sent.invite, seed)) await store.dropSent(sent.id);
  }
}

/**
 * Reads each pending application's reply mailbox and keeps the invite in the
 * latest reply that opens; forgets an application {@link SENT_DAYS} days
 * after it was sent, by the device clock, with no request. A mailbox that
 * can't be read waits for the next sync.
 */
export async function checkReplies(services: ReplyServices): Promise<void> {
  const now = services.now();
  for (const sent of await services.store.listSent()) {
    if (now - sent.sentAt >= SENT_DAYS * DAY_MS) {
      await services.store.dropSent(sent.id);
      continue;
    }
    const invite = await latestInvite(services.relay, sent).catch(() => null);
    if (invite === null || same(invite, sent.invite)) continue;
    await services.store.updateSent(sent.id, (held) => ({ ...held, invite }));
  }
}
