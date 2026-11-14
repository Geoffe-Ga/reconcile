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
 * Every one of those days is the relay's (#347), as the governance log's
 * are: a tombstone lapses on the relay's clock, so a device clock moved back
 * must never make a share look recently posted. A post's time is the relay
 * minute the read of its mailbox gave just before it, and each decision to
 * post, a refresh's 20 days and an idle share's 30 alike, is taken on the
 * minute that same read gave. Decisions made with no read of their own, what
 * Personal and the editor show and whether a launch looks at a share at all,
 * take the latest minute the device has heard from the relay
 * ({@link heardRelay}): a lower bound, made only of the relay's own
 * readings, which the device clock can't move back. The device clock only
 * picks when a launch looks; the relay's minute decides whether anything
 * goes.
 *
 * A share a restore brought back is paused (#328, `restoredCopy`): a
 * tombstone lasts only as long as the relay keeps it, so a backup made before
 * Stop sharing, restored once that has lapsed, would otherwise post the
 * Document to a link the person turned off. Nothing posts to a paused share
 * until the person chooses on that Document: {@link keepSharing} posts its
 * latest version, still finding any tombstone first, and Stop sharing posts
 * only a tombstone.
 *
 * A share this device hasn't posted to for the tombstone's whole lifetime,
 * {@link SHARE_TTL_DAYS} days on the relay's clock, is paused the same way
 * (#339, `pauseOf`): another device holding the same share may have stopped
 * it, and the tombstone that said so may have lapsed. Keep sharing starts
 * its days again.
 *
 * On a device whose keys are locked with a passkey, a share's seed and keys
 * wait in the vault (#255), so nothing here posts, starts or stops a share
 * until it's unlocked: Share link and Stop sharing say `locked` and send
 * nothing, and a post's read of the share refuses.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import type { Seal } from '../crypto/seal';
import { newShareSeed, openShareRecord, shareChannelOf, signShareRecord } from '../crypto/share';
import { newSigningKeys } from '../crypto/sign';
import { normalizeAtomText } from '../engine/atomText';
import { DAY_MINUTES } from '../engine/rules';
import type { Relay, RelayRecord } from '../net/relay';
import { type Store, VaultLocked } from '../store/db';
import {
  type PersonalDocument,
  type PostedAt,
  resumedShare,
  type ShareMark,
  type ShareState,
  UNMEASURED,
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

/** {@link SHARE_TTL_DAYS} in relay minutes (#347). */
const TTL_MINUTES = SHARE_TTL_DAYS * DAY_MINUTES;

/** {@link REFRESH_AFTER_DAYS} in relay minutes (#347). */
const REFRESH_MINUTES = REFRESH_AFTER_DAYS * DAY_MINUTES;

/** A device millisecond's minute: what a launch compares with a post's relay minute, only to pick when to look (#347). */
const MINUTE_MS = 60_000;

/** What a link names: the share's seed and the public key whose copies count. */
export interface ShareLink {
  /** 32 random bytes; the share's mailbox id and seal key derive from them. */
  readonly seed: Uint8Array;
  /** The share's 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
}

/**
 * What sharing reaches: the device's personal Documents, its groups' relay
 * minutes (#347), the relay, the seal and the device clock.
 */
export interface ShareServices {
  readonly store: Pick<
    Store,
    'getPersonal' | 'listPersonal' | 'updateShare' | 'requireUnlocked' | 'listGroups'
  >;
  readonly relay: Pick<Relay, 'putBlob' | 'getBlobs'>;
  readonly seal: Seal;
  /**
   * The device clock in milliseconds. It only picks when a launch looks at a
   * share (#347): every decision to post is the relay's clock.
   */
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
  | { readonly kind: 'missing' }
  | { readonly kind: 'locked' };

/**
 * How one post went: posted; too large to share, or failed to reach the
 * relay, both leaving the share pending; stopped, when the mailbox already
 * held a tombstone; unshared, when there was nothing to post; paused, when
 * the share waits for the person ({@link pauseOf}), so nothing went; or
 * fresh, when a launch looked and the relay's clock said the share's
 * refresh isn't due yet (#347), so nothing went.
 */
export type PostOutcome =
  'posted' | 'too-large' | 'failed' | 'stopped' | 'unshared' | 'paused' | 'fresh';

/**
 * Why a post runs (#347): an edit to send, which goes unless the share is
 * idle; a launch's refresh, which goes only once the relay's clock says
 * {@link REFRESH_AFTER_DAYS} days, or for an edit; or the person's Keep
 * sharing, which goes whatever the share's days, since the person chose.
 */
type PostReason = 'edit' | 'refresh' | 'keep';

/**
 * Why nothing goes to a share's link until the person chooses: a restore
 * brought it back (#328), or this device hasn't posted to it for
 * {@link SHARE_TTL_DAYS} days (#339).
 */
export type SharePause = 'restored' | 'idle';

/**
 * How Keep sharing went (#328): as its post went, or locked, when the
 * device's keys are locked with a passkey (#255), so nothing was kept or sent.
 */
export type KeepOutcome = PostOutcome | 'locked';

/**
 * How Stop sharing went: stopped, or failed and changed nothing, or found the
 * device's keys locked (#255) and sent nothing.
 */
export type StopOutcome = 'stopped' | 'failed' | 'locked';

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

/** One copy the link's key signed, with the seq the relay gave its blob and the relay minute it arrived. */
interface FoundCopy {
  readonly seq: number;
  readonly received: number;
  readonly copy: ShareCopy;
}

/** A read of a share's mailbox (#347): every copy its key signed, and the relay's minute at the read. */
interface MailboxRead {
  readonly found: readonly FoundCopy[];
  readonly now: number;
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
  return records.flatMap(({ seq, received, data }) => {
    const record = seal.open(mailbox, key, data);
    const bytes = record && openShareRecord(record, link.publicKey);
    const copy = bytes && parseCopy(bytes);
    return copy ? [{ seq, received, copy }] : [];
  });
}

/** Every copy the link's key signed in its mailbox, reading every page, and the relay's minute (#347). */
async function readMailbox({ relay, seal }: ShareReader, link: ShareLink): Promise<MailboxRead> {
  const page = await relay.getBlobs(shareChannelOf(link.seed).mailbox, 0);
  return { found: copiesIn(seal, link, page.records), now: page.now };
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
  const { found } = await readMailbox(reader, link);
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
 * Posts `body` as the next copy after `found`, a read of the mailbox:
 * numbered one past the highest `n` there that the share's key signed, or
 * its own last `n`, whichever is higher. Returns the number it posted under.
 *
 * @throws {Error} when the relay can't be reached or refuses the post.
 */
async function putNext(
  services: ShareServices,
  share: ShareState,
  found: readonly FoundCopy[],
  body: CopyWords | { readonly stopped: true },
): Promise<number> {
  const n = found.reduce((highest, { copy }) => Math.max(highest, copy.n), share.n) + 1;
  const copy: ShareCopy = { v: COPY_VERSION, n, ...body };
  // `fitsShare` has checked the words at the largest n, so the record is at most 64,000 bytes.
  const record = signShareRecord(share, encodeCopy(copy));
  const { mailbox, key } = shareChannelOf(share.seed);
  await services.relay.putBlob(mailbox, services.seal.seal(mailbox, key, record), SHARE_TTL_DAYS);
  return n;
}

/**
 * Reads the mailbox, then posts `body` as the next copy ({@link putNext}).
 * Returns the number it posted under and the relay's minute at the read,
 * which stamps the post (#347), or `'stopped'` with no post when the mailbox
 * already holds a tombstone.
 *
 * @throws {Error} when the relay can't be reached or refuses the post.
 */
async function postNext(
  services: ShareServices,
  share: ShareState,
  body: CopyWords | { readonly stopped: true },
): Promise<{ readonly n: number; readonly at: number } | 'stopped'> {
  const read = await readMailbox(services, linkOf(share));
  if (hasStopped(read.found)) return 'stopped';
  return { n: await putNext(services, share, read.found, body), at: read.now };
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

/**
 * Whether this device's keys are locked with a passkey this session hasn't
 * used (#255): then a share's keys can't be read or kept, so nothing posts.
 */
async function isLocked(services: ShareServices): Promise<boolean> {
  try {
    await services.store.requireUnlocked();
    return false;
  } catch (error) {
    if (error instanceof VaultLocked) return true;
    throw error;
  }
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
 * `n`, stamped with `at`, the relay minute the read before it gave (#347),
 * and still pending only if the Document changed meanwhile.
 */
function postedAs(
  held: PersonalDocument,
  share: ShareState,
  posted: PersonalDocument,
  at: number,
): ShareState {
  const changed = held.title !== posted.title || held.text !== posted.text;
  return { ...share, postedAt: at, seenAt: at, pending: changed };
}

/**
 * When `share` was last posted on the relay's clock, as `found` measures it
 * (#347): its own `postedAt`, a relay minute or null for never; or, for an
 * unmeasured share, the relay's receipt of the copy it posted last, numbered
 * its `n`, the earliest if two devices raced to it. With that copy gone, the
 * relay let it lapse, so the share's last post is older than
 * {@link SHARE_TTL_DAYS} days by the read's `now`: then `now` less those days,
 * the latest minute it could have arrived at, which reads idle, as it is.
 */
function measuredPost(share: ShareState, { found, now }: MailboxRead): number | null {
  if (share.postedAt !== UNMEASURED) return share.postedAt;
  const own = found.filter(({ copy }) => copy.n === share.n).map(({ received }) => received);
  return own.length === 0 ? now - TTL_MINUTES : Math.min(...own);
}

/**
 * What the relay's clock says of posting `share` for `reason`, at the read
 * `read` (#347): idle once its last post, measured ({@link measuredPost}), is
 * {@link SHARE_TTL_DAYS} days old, since its link may have been stopped
 * elsewhere (#339); fresh for a refresh with no edit to send before
 * {@link REFRESH_AFTER_DAYS} days; else post. A share never posted has no
 * link anyone could open, so it posts. Keep sharing posts whatever the days.
 */
function verdictOn(
  share: ShareState,
  read: MailboxRead,
  reason: PostReason,
): 'post' | 'idle' | 'fresh' {
  const posted = measuredPost(share, read);
  if (reason === 'keep' || posted === null) return 'post';
  const age = read.now - posted;
  if (age >= TTL_MINUTES) return 'idle';
  return reason === 'refresh' && !share.pending && age < REFRESH_MINUTES ? 'fresh' : 'post';
}

/**
 * Keeps what a read of `share`'s mailbox that posted nothing found (#347):
 * the relay's minute, so a pause it showed still shows, and an unmeasured
 * share's measured post time, so it's measured once.
 */
async function noteRead(
  services: ShareServices,
  id: string,
  share: ShareState,
  read: MailboxRead,
): Promise<void> {
  const postedAt = measuredPost(share, read);
  await services.store.updateShare(id, (held) =>
    sameShare(held.share, share) ? { ...held.share, postedAt, seenAt: read.now } : held.share,
  );
}

/**
 * Posts the words of `document`, whose share is `share`, for `reason`, once
 * a read of the mailbox finds no tombstone and the relay's clock says to
 * ({@link verdictOn}, #347).
 */
async function postRead(
  services: ShareServices,
  document: PersonalDocument,
  share: ShareState,
  reason: PostReason,
): Promise<PostOutcome> {
  const { id } = document;
  const read = await readMailbox(services, linkOf(share)).catch(() => null);
  if (read === null) {
    await markPending(services, id, share);
    return 'failed';
  }
  if (hasStopped(read.found)) {
    await dropShare(services, id, share);
    return 'stopped';
  }
  const verdict = verdictOn(share, read, reason);
  if (verdict !== 'post') {
    await noteRead(services, id, share, read);
    return verdict === 'idle' ? 'paused' : 'fresh';
  }
  const n = await putNext(services, share, read.found, wordsOf(document)).catch(() => null);
  if (n === null) {
    await markPending(services, id, share);
    return 'failed';
  }
  await services.store.updateShare(id, (held) =>
    sameShare(held.share, share)
      ? postedAs(held, { ...held.share, n }, document, read.now)
      : held.share,
  );
  return 'posted';
}

/**
 * Posts the latest copy of Document `id`, if it is shared and not paused
 * ({@link pauseOf}), for `reason` ({@link PostReason}). Whether it goes is
 * the relay's clock, read in the same request that finds any tombstone
 * (#347): a share idle by then is paused with nothing sent, and a refresh
 * the relay says isn't due sends nothing. A Document that has grown too
 * large, or a relay that can't be reached, leaves the share pending for
 * `keepSharesAlive`; a tombstone already in the mailbox drops the share and
 * posts nothing.
 */
export function postCopy(
  services: ShareServices,
  id: string,
  reason: PostReason = 'edit',
): Promise<PostOutcome> {
  return inTurn(id, async () => {
    const document = await services.store.getPersonal(id);
    const share = document?.share;
    if (document === undefined || share === undefined) return 'unshared';
    if (reason !== 'keep' && pauseOf(share, await heardRelay(services)) !== null) return 'paused';
    if (!fitsShare(wordsOf(document))) {
      await markPending(services, id, share);
      return 'too-large';
    }
    return postRead(services, document, share, reason);
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
 * share, nothing is kept. A Document already shared keeps its link. While
 * the device's keys are locked (#255), nothing is posted or kept.
 */
export function startSharing(services: ShareServices, id: string): Promise<StartOutcome> {
  return inTurn(id, async (): Promise<StartOutcome> => {
    if (await isLocked(services)) return { kind: 'locked' };
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
      postedAt: null,
      pending: true,
    };
    // No one else holds a fresh seed, so its mailbox can't hold a tombstone.
    const posted = await postNext(services, fresh, words).catch(() => null);
    if (posted === null || posted === 'stopped') return { kind: 'failed' };
    const kept = await services.store.updateShare(
      id,
      (held) => held.share ?? postedAs(held, { ...fresh, n: posted.n }, document, posted.at),
    );
    return kept?.share === undefined
      ? { kind: 'missing' }
      : { kind: 'shared', link: linkOf(kept.share) };
  });
}

/**
 * When Keep sharing counts `share` as posted (#339, #347): the latest relay
 * minute the device has heard, `heard`, or the share's own read, whichever
 * is later, never earlier than its last post. Having heard nothing at all,
 * its time stays as it was.
 */
function keptAt(share: ShareState, heard: number | null): PostedAt {
  const latest = latestOf(heard, share.seenAt ?? null);
  if (latest === null) return share.postedAt;
  return typeof share.postedAt === 'number' ? Math.max(share.postedAt, latest) : latest;
}

/**
 * Keep sharing for Document `id`, once its share is paused ({@link pauseOf}):
 * records the person's choice, then posts the latest copy whatever its days,
 * which still reads the mailbox first, so a tombstone there drops the share
 * and nothing goes. The post is stamped with the relay's minute (#347). The
 * choice counts as a post towards the share's {@link SHARE_TTL_DAYS} days
 * (#339), at the latest relay minute the device has heard ({@link keptAt}),
 * so a post that fails leaves the share pending and the next launch sends
 * it, unless the relay's clock then says the share is idle again. A
 * Document that isn't shared is left alone. While the device's keys are
 * locked (#255), nothing is kept or sent, and the share stays paused.
 */
export async function keepSharing(services: ShareServices, id: string): Promise<KeepOutcome> {
  if (await isLocked(services)) return 'locked';
  const heard = await heardRelay(services);
  const kept = await services.store.updateShare(id, (held) =>
    held.share === undefined
      ? undefined
      : { ...resumedShare(held.share), postedAt: keptAt(held.share, heard) },
  );
  return kept?.share === undefined ? 'unshared' : postCopy(services, id, 'keep');
}

/**
 * Stop sharing for Document `id`: posts a tombstone, then drops the share.
 * Offline, or while the relay refuses it, nothing changes. A mailbox that
 * already holds a tombstone needs no second one. While the device's keys are
 * locked (#255), nothing is sent and nothing changes.
 */
export function stopSharing(services: ShareServices, id: string): Promise<StopOutcome> {
  return inTurn(id, async (): Promise<StopOutcome> => {
    if (await isLocked(services)) return 'locked';
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

/** The later of two relay minutes, either of which may be unknown (null). */
function latestOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

/**
 * The latest relay minute the device has heard (#347): the latest `relayNow`
 * among its groups and coalitions, each a reading of the relay's own clock
 * from a sync, or null before any synced. It lags the relay, never leads
 * it, and no change to the device clock moves it.
 */
export async function heardRelay(services: Pick<ShareServices, 'store'>): Promise<number | null> {
  const groups = await services.store.listGroups();
  return groups.reduce<number | null>((latest, group) => latestOf(latest, group.relayNow), null);
}

/**
 * Whether `share`'s link may still open at relay minute `relayNow`: its last
 * copy went out, or the person kept sharing (#339), less than
 * {@link SHARE_TTL_DAYS} days ago on the relay's clock (#347), so the relay
 * may still keep it. A share never posted has no link anyone could open.
 * One whose time is unmeasured, or with no relay minute to measure it by,
 * may: nothing says otherwise. The relay backup's merge asks it of a share
 * it can't tell from one this device stopped (#247).
 */
export function mayStillOpen(
  share: Pick<ShareState, 'postedAt'>,
  relayNow: number | null,
): boolean {
  const { postedAt } = share;
  if (postedAt === null) return false;
  if (postedAt === UNMEASURED || relayNow === null) return true;
  return relayNow - postedAt < TTL_MINUTES;
}

/**
 * Why `share` waits for the person, or null while posts may go to its link:
 * `'restored'` while a restore has it paused (#328), else `'idle'` once this
 * device's last post to it is {@link SHARE_TTL_DAYS} or more days old on the
 * relay's clock, so its link may no longer open ({@link mayStillOpen}; #339,
 * #347). A tombstone lasts only as long as the relay keeps it, so by then
 * another device holding the share may have stopped it with nothing left to
 * say so. The relay's clock is the later of `relayNow`, the latest minute
 * the device has heard ({@link heardRelay}), and the share's own last read
 * (`seenAt`), so a pause a read found shows even with no group to sync. A
 * share never posted has no link anyone could open, and an unmeasured one
 * is measured at its next read.
 */
export function pauseOf(share: ShareMark, relayNow: number | null): SharePause | null {
  if (share.paused === true) return 'restored';
  const heard = latestOf(relayNow, share.seenAt ?? null);
  return share.postedAt !== null && !mayStillOpen(share, heard) ? 'idle' : null;
}

/**
 * Whether a launch looks at `share` (#347), never while it waits for the
 * person ({@link pauseOf}): with an edit to post, never posted, unmeasured,
 * or last posted {@link REFRESH_AFTER_DAYS} or more days ago by the later of
 * `heard` and the device clock's `minute`. The device clock only picks when
 * to look: the read then decides on the relay's own minute whether a
 * refresh goes (`verdictOn`). A clock moved back looks later, so a share it
 * leaves to lapse pauses, the safe side; one moved forward looks early, and
 * the relay says not yet.
 */
function isDue(share: ShareState, heard: number | null, minute: number): boolean {
  if (pauseOf(share, heard) !== null) return false;
  const { postedAt } = share;
  if (share.pending || typeof postedAt !== 'number') return true;
  return Math.max(heard ?? postedAt, minute) - postedAt >= REFRESH_MINUTES;
}

/**
 * Posts the latest copy of every shared Document that is pending or due, one
 * after another, at app start, so a share that stays on outlives the relay's
 * 30-day retention: each one {@link isDue} picks is read, and its refresh
 * goes once the relay's clock says so (#347). A paused share ({@link pauseOf})
 * waits for the person. Returns each one looked at, and how its post went.
 */
export async function keepSharesAlive(
  services: ShareServices,
): Promise<(readonly [string, PostOutcome])[]> {
  const documents = await services.store.listPersonal();
  const heard = await heardRelay(services);
  const minute = Math.floor(services.now() / MINUTE_MS);
  const outcomes: (readonly [string, PostOutcome])[] = [];
  for (const { id, share } of documents) {
    if (share !== undefined && isDue(share, heard, minute)) {
      outcomes.push([id, await postCopy(services, id, 'refresh')]);
    }
  }
  return outcomes;
}
