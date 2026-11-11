/**
 * Sharing a personal Document by a read-only link (spec §11 "Share link";
 * #105; ADR-0074's personal page at level 2; ADR-0057's 30-day retention).
 *
 * 'Share link' makes a share of the Document's own: a random seed and a
 * fresh Ed25519 keypair, used for nothing else (`crypto/share.ts`). The link
 * is `${origin}/#share/${seed}.${publicKey}`, so both travel only after `#`,
 * which browsers never send to a server. Each copy of the Document, its
 * latest version or a tombstone (`copy.ts`), is signed under the share's key,
 * sealed and padded with the app's `Seal`, and posted to the share's mailbox
 * for 30 days. Nothing the relay stores ties the share to the person's
 * groups: no key, id or mailbox of theirs is in it, and its blobs look like
 * any group's. It still sees the poster's IP address live, as with any sync.
 *
 * Before each post the owner's device reads the mailbox and numbers the copy
 * one past the highest it holds that the share's key signed, so restoring an
 * older backup never rolls the link back. A verified tombstone there is
 * final: the device drops the share and posts nothing, so a backup can't
 * bring a stopped share back. A reader keeps only copies the link's key
 * signed, and shows the one with the highest number, ties going to the later
 * seq; any tombstone means the share has stopped. The relay's retention is
 * the only expiry, so `keepSharesAlive` posts the latest copy again at each
 * launch for a share last posted {@link REFRESH_AFTER_DAYS} or more days ago,
 * or one with an edit still to post.
 *
 * A share a restore brought back is paused (#328, `restoredCopy`): a
 * tombstone lasts only as long as the relay keeps it, so a backup made before
 * Stop sharing, restored once that has lapsed, would otherwise post the
 * Document to a link the person turned off. Nothing posts to a paused share
 * until the person chooses on that Document: {@link keepSharing} posts its
 * latest version, still finding any tombstone first, and Stop sharing posts
 * only a tombstone.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import type { Seal } from '../crypto/seal';
import { newShareSeed, openShareRecord, shareChannelOf, signShareRecord } from '../crypto/share';
import { newSigningKeys } from '../crypto/sign';
import { normalizeAtomText } from '../engine/atomText';
import type { Relay, RelayRecord } from '../net/relay';
import {
  type PersonalDocument,
  type PersonalStore,
  resumedShare,
  type ShareState,
} from '../store/personal';
import {
  COPY_VERSION,
  type CopyWords,
  encodeCopy,
  fitsShare,
  parseCopy,
  type ShareCopy,
} from './copy';

/** How long the relay keeps each copy: its 30-day blob retention (ADR-0057). */
export const SHARE_TTL_DAYS = 30;

/** A share last posted this many days ago is posted again at launch, well inside {@link SHARE_TTL_DAYS}. */
export const REFRESH_AFTER_DAYS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a link names: the share's seed and the public key whose copies count. */
export interface ShareLink {
  /** 32 random bytes; the share's mailbox id and seal key derive from them. */
  readonly seed: Uint8Array;
  /** The share's 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
}

/** What sharing reaches: the device's personal Documents, the relay, the seal and the device clock. */
export interface ShareServices {
  readonly store: Pick<PersonalStore, 'getPersonal' | 'listPersonal' | 'updateShare'>;
  readonly relay: Pick<Relay, 'putBlob' | 'getBlobs'>;
  readonly seal: Seal;
  /** The device clock in milliseconds: when a copy was last posted. */
  readonly now: () => number;
}

/** What a reader needs: the relay and the seal, and nothing of the owner's. */
export interface ShareReader {
  readonly relay: Pick<Relay, 'getBlobs'>;
  readonly seal: Seal;
}

/** What a link shows: the Document's latest version, or the not-shared line. */
export type SharedView =
  | { readonly kind: 'shown'; readonly title: string; readonly text: string }
  | { readonly kind: 'gone' };

/** How 'Share link' went: shared, with its link, or why not. */
export type StartOutcome =
  | { readonly kind: 'shared'; readonly link: ShareLink }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'missing' };

/**
 * How one post went: posted; too large to share, or failed to reach the
 * relay, both leaving the share pending; stopped, when the mailbox already
 * held a tombstone; unshared, when there was nothing to post; or paused,
 * when a restore brought the share back and the person hasn't kept it yet
 * (#328), so nothing went.
 */
export type PostOutcome = 'posted' | 'too-large' | 'failed' | 'stopped' | 'unshared' | 'paused';

/** How Stop sharing went: stopped, or failed and changed nothing. */
export type StopOutcome = 'stopped' | 'failed';

/** A link's own form: `#share/`, with no slash after `#`, as an invite's `#join/` (spec §3). */
export const SHARE_PREFIX = '#share/';

/** A seed or key: 32 bytes in 43 unpadded base64url characters. */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** The 32 bytes `text` spells in canonical unpadded base64url, or null. */
function keyIn(text: string | undefined): Uint8Array | null {
  if (text === undefined || !KEY_TEXT.test(text)) return null;
  const bytes = fromBase64url(text);
  // Re-encoding catches a final character whose spare bits aren't zero.
  return base64url(bytes) === text ? bytes : null;
}

/** The link to send: the app's origin, then the seed and public key after `#share/`. */
export function shareLinkOf(origin: string, link: ShareLink): string {
  return `${origin}/${SHARE_PREFIX}${sharePayloadOf(link)}`;
}

/** What follows `#share/`: the seed and the public key, joined by a dot. */
export function sharePayloadOf(link: ShareLink): string {
  return `${base64url(link.seed)}.${base64url(link.publicKey)}`;
}

/** `{seed}.{publicKey}` as the link it names, or null for anything else. */
export function parseSharePayload(payload: string): ShareLink | null {
  const parts = payload.split('.');
  if (parts.length !== 2) return null;
  const [seed, publicKey] = parts.map(keyIn);
  return seed && publicKey ? { seed, publicKey } : null;
}

/** The fragment of `text` when it's an absolute URL, else null. */
function fragmentOf(text: string): string | null {
  try {
    return new URL(text).hash;
  } catch {
    return null;
  }
}

/**
 * The share a pasted or opened link names, or null: the whole link from any
 * origin, its fragment alone, or the bare `{seed}.{publicKey}`.
 */
export function parseShareLink(text: string): ShareLink | null {
  const trimmed = text.trim();
  const fragment = fragmentOf(trimmed) ?? trimmed;
  if (fragment.startsWith('#')) {
    return fragment.startsWith(SHARE_PREFIX)
      ? parseSharePayload(fragment.slice(SHARE_PREFIX.length))
      : null;
  }
  return parseSharePayload(fragment);
}

/** One copy the link's key signed, with the seq the relay gave its blob. */
interface FoundCopy {
  readonly seq: number;
  readonly copy: ShareCopy;
}

/**
 * Every copy in `records` that opens under the share's seal and was signed
 * by `publicKey`, in seq order. A blob that doesn't open, a record by any
 * other key, a changed byte or a copy that doesn't parse is skipped.
 */
function copiesIn(
  seal: Seal,
  link: ShareLink,
  records: readonly RelayRecord[],
): readonly FoundCopy[] {
  const { mailbox, key } = shareChannelOf(link.seed);
  return records.flatMap(({ seq, data }) => {
    const record = seal.open(mailbox, key, data);
    const bytes = record && openShareRecord(record, link.publicKey);
    const copy = bytes && parseCopy(bytes);
    return copy ? [{ seq, copy }] : [];
  });
}

/** Every copy the link's key signed in its mailbox, reading every page. */
async function readCopies(
  { relay, seal }: ShareReader,
  link: ShareLink,
): Promise<readonly FoundCopy[]> {
  const page = await relay.getBlobs(shareChannelOf(link.seed).mailbox, 0);
  return copiesIn(seal, link, page.records);
}

/** Whether `found` holds a tombstone: then the share has stopped, whatever came after. */
function hasStopped(found: readonly FoundCopy[]): boolean {
  return found.some(({ copy }) => 'stopped' in copy);
}

/**
 * What the link shows: the copy with the highest `n`, ties going to the later
 * seq, or the not-shared line for an empty mailbox, one with no copy the
 * link's key signed, or one holding a tombstone.
 *
 * @throws {Error} when the relay can't be reached or answers wrongly.
 */
export async function readShare(reader: ShareReader, link: ShareLink): Promise<SharedView> {
  const found = await readCopies(reader, link);
  if (hasStopped(found)) return { kind: 'gone' };
  let latest: FoundCopy | undefined;
  for (const candidate of found) {
    // Copies come in seq order, so an equal n replaces: the later seq wins.
    if (latest === undefined || candidate.copy.n >= latest.copy.n) latest = candidate;
  }
  const copy = latest?.copy;
  return copy !== undefined && 'text' in copy
    ? { kind: 'shown', title: copy.title, text: copy.text }
    : { kind: 'gone' };
}

/** What a copy of `document` says: its title, and its text normalized as Preview shows it. */
function wordsOf(document: Pick<PersonalDocument, 'title' | 'text'>): CopyWords {
  return { title: document.title, text: normalizeAtomText(document.text) };
}

/** The link a share's state names. */
function linkOf(share: ShareState): ShareLink {
  return { seed: share.seed, publicKey: share.publicKey };
}

/** Whether `held` is the same share as `share`: the same seed. */
function sameShare(held: ShareState | undefined, share: ShareState): held is ShareState {
  return held !== undefined && base64url(held.seed) === base64url(share.seed);
}

/**
 * Reads the mailbox, then posts `body` as the next copy: numbered one past
 * the highest `n` there that the share's key signed, or its own last `n`,
 * whichever is higher. Returns the number it posted under, or `'stopped'`
 * with no post when the mailbox already holds a tombstone.
 *
 * @throws {Error} when the relay can't be reached or refuses the post.
 */
async function postNext(
  services: ShareServices,
  share: ShareState,
  body: CopyWords | { readonly stopped: true },
): Promise<number | 'stopped'> {
  const link = linkOf(share);
  const found = await readCopies(services, link);
  if (hasStopped(found)) return 'stopped';
  const n = found.reduce((highest, { copy }) => Math.max(highest, copy.n), share.n) + 1;
  const copy: ShareCopy = { v: COPY_VERSION, n, ...body };
  // `fitsShare` has checked the words at the largest n, so the record is at most 64,000 bytes.
  const record = signShareRecord(share, encodeCopy(copy));
  const { mailbox, key } = shareChannelOf(share.seed);
  await services.relay.putBlob(mailbox, services.seal.seal(mailbox, key, record), SHARE_TTL_DAYS);
  return n;
}

/** The tasks for each Document, chained, so one runs at a time and two posts never share an `n`. */
const turns = new Map<string, Promise<unknown>>();

/** Runs `task` after every task already queued for Document `id`, whether they succeeded or not. */
function inTurn<T>(id: string, task: () => Promise<T>): Promise<T> {
  const run = (turns.get(id) ?? Promise.resolve()).then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  turns.set(id, settled);
  void settled.then(() => {
    if (turns.get(id) === settled) turns.delete(id);
  });
  return run;
}

/** Marks `share` pending on Document `id`, unless it has been stopped or replaced meanwhile. */
async function markPending(services: ShareServices, id: string, share: ShareState): Promise<void> {
  await services.store.updateShare(id, (held) =>
    sameShare(held.share, share) ? { ...held.share, pending: true } : held.share,
  );
}

/** Drops `share` from Document `id`, unless it has been replaced meanwhile. */
async function dropShare(services: ShareServices, id: string, share: ShareState): Promise<void> {
  await services.store.updateShare(id, (held) =>
    sameShare(held.share, share) ? undefined : held.share,
  );
}

/**
 * The share as kept after copy `n` of `posted`'s words went out: numbered
 * `n`, stamped now, and still pending only if the Document changed meanwhile.
 */
function postedAs(
  held: PersonalDocument,
  share: ShareState,
  posted: PersonalDocument,
  at: number,
): ShareState {
  const changed = held.title !== posted.title || held.text !== posted.text;
  return { ...share, lastPostedAt: at, pending: changed };
}

/**
 * Posts the latest copy of Document `id`, if it is shared and not paused
 * (#328). A Document that has grown too large, or a relay that can't be
 * reached, leaves the share pending for `keepSharesAlive`; a tombstone
 * already in the mailbox drops the share and posts nothing.
 */
export function postCopy(services: ShareServices, id: string): Promise<PostOutcome> {
  return inTurn(id, async () => {
    const document = await services.store.getPersonal(id);
    const share = document?.share;
    if (document === undefined || share === undefined) return 'unshared';
    if (share.paused === true) return 'paused';
    const words = wordsOf(document);
    if (!fitsShare(words)) {
      await markPending(services, id, share);
      return 'too-large';
    }
    const n = await postNext(services, share, words).catch(() => null);
    if (n === null) {
      await markPending(services, id, share);
      return 'failed';
    }
    if (n === 'stopped') {
      await dropShare(services, id, share);
      return 'stopped';
    }
    const at = services.now();
    await services.store.updateShare(id, (held) =>
      sameShare(held.share, share)
        ? postedAs(held, { ...held.share, n }, document, at)
        : held.share,
    );
    return 'posted';
  });
}

/**
 * Posts Document `id`'s latest copy only when an edit waits for its link:
 * what leaving the editor does. A Document that isn't shared, or whose link
 * is up to date, sends nothing.
 */
export async function postEdits(
  services: ShareServices,
  id: string,
): Promise<PostOutcome | 'unchanged'> {
  const share = (await services.store.getPersonal(id))?.share;
  return share?.pending === true ? postCopy(services, id) : 'unchanged';
}

/**
 * 'Share link' for Document `id`: makes a fresh seed and keypair, posts the
 * first copy, and only once the relay has it keeps the share on the
 * Document and hands back its link. Offline, or for a Document too large to
 * share, nothing is kept. A Document already shared keeps its link.
 */
export function startSharing(services: ShareServices, id: string): Promise<StartOutcome> {
  return inTurn(id, async (): Promise<StartOutcome> => {
    const document = await services.store.getPersonal(id);
    if (document === undefined) return { kind: 'missing' };
    if (document.share !== undefined) return { kind: 'shared', link: linkOf(document.share) };
    const words = wordsOf(document);
    if (!fitsShare(words)) return { kind: 'too-large' };
    const keys = newSigningKeys();
    const fresh: ShareState = {
      seed: newShareSeed(),
      secretKey: keys.secretKey,
      publicKey: keys.publicKey,
      n: 0,
      lastPostedAt: null,
      pending: true,
    };
    // No one else holds a fresh seed, so its mailbox can't hold a tombstone.
    const n = await postNext(services, fresh, words).catch(() => null);
    if (typeof n !== 'number') return { kind: 'failed' };
    const at = services.now();
    const kept = await services.store.updateShare(
      id,
      (held) => held.share ?? postedAs(held, { ...fresh, n }, document, at),
    );
    return kept?.share === undefined
      ? { kind: 'missing' }
      : { kind: 'shared', link: linkOf(kept.share) };
  });
}

/**
 * Keep sharing for Document `id`, once a restore has paused its share
 * (#328): records the person's choice, then posts the latest copy, which
 * still reads the mailbox first, so a tombstone there drops the share and
 * nothing goes. A post that fails leaves the share pending, so the next
 * launch sends it. A Document that isn't shared is left alone.
 */
export async function keepSharing(services: ShareServices, id: string): Promise<PostOutcome> {
  const kept = await services.store.updateShare(id, (held) =>
    held.share === undefined ? undefined : resumedShare(held.share),
  );
  return kept?.share === undefined ? 'unshared' : postCopy(services, id);
}

/**
 * Stop sharing for Document `id`: posts a tombstone, then drops the share.
 * Offline, or while the relay refuses it, nothing changes. A mailbox that
 * already holds a tombstone needs no second one.
 */
export function stopSharing(services: ShareServices, id: string): Promise<StopOutcome> {
  return inTurn(id, async (): Promise<StopOutcome> => {
    const share = (await services.store.getPersonal(id))?.share;
    if (share === undefined) return 'stopped';
    const posted = await postNext(services, share, { stopped: true }).then(
      () => true,
      () => false,
    );
    if (!posted) return 'failed';
    await dropShare(services, id, share);
    return 'stopped';
  });
}

/**
 * Whether `share`'s link may still open at `now`: its last copy went out
 * less than {@link SHARE_TTL_DAYS} days ago, so the relay may still keep it.
 * A share never posted has no link anyone could open. The relay backup's
 * merge asks it of a share it can't tell from one this device stopped
 * (#247).
 */
export function mayStillOpen(share: ShareState, now: number): boolean {
  return share.lastPostedAt !== null && now - share.lastPostedAt < SHARE_TTL_DAYS * DAY_MS;
}

/**
 * Whether `share` needs posting at launch: an edit to post, never posted, or
 * posted {@link REFRESH_AFTER_DAYS} or more days ago, and never while a
 * restore has it paused (#328).
 */
function isDue(share: ShareState, now: number): boolean {
  if (share.paused === true) return false;
  if (share.pending || share.lastPostedAt === null) return true;
  return now - share.lastPostedAt >= REFRESH_AFTER_DAYS * DAY_MS;
}

/**
 * Posts the latest copy of every shared Document that is pending or due, one
 * after another, at app start, so a share that stays on outlives the relay's
 * 30-day retention. A paused share (#328) waits for the person. Returns each
 * one's id and how its post went.
 */
export async function keepSharesAlive(
  services: ShareServices,
): Promise<(readonly [string, PostOutcome])[]> {
  const documents = await services.store.listPersonal();
  const now = services.now();
  const outcomes: (readonly [string, PostOutcome])[] = [];
  for (const { id, share } of documents) {
    if (share !== undefined && isDue(share, now)) outcomes.push([id, await postCopy(services, id)]);
  }
  return outcomes;
}
