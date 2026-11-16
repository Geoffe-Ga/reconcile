/**
 * What making a follow link, Follow and Unfollow do (spec §4 Coalitions,
 * "Following"; ADR-0003, ADR-0021, ADR-0053, ADR-0075 §5; #124), apart from
 * any screen.
 *
 * Making a follow link posts an M2-03 envelope to a fresh follow mailbox: the
 * coalition secret, a preview, and the coalition's log, never `inner` or a
 * seat secret (`coalition/follow.ts`). Follow keeps the coalition as an entry
 * on this device, marked `following`, and imports the log through sync's
 * verify, dedupe and fold path; the sync loop then reads its mailboxes as it
 * reads any coalition's. A follower posts nothing: no join, no result, no
 * key change, so neither the coalition's log nor the relay records that
 * they follow, and followers never see each other (ADR-0075 §5). Unfollow
 * purges the entry, as Leave purges a group, and posts nothing either.
 */
import { deriveCoalitionEntryId } from '../crypto/card';
import { followChannelOf, newFollowSeed } from '../crypto/follow';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import {
  type Follow,
  FOLLOW_TTL_DAYS,
  type FollowPreview,
  followLink,
  openFollow,
  sealFollow,
} from '../coalition/follow';
import { newEntry } from '../store/coalitions';
import { isCoalitionEntry } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { foldGroup } from '../store/expiry';
import type { Services } from './actions';
import { plainText } from './text/markdown';

/**
 * What a coalition's follow link previews (#124): its name, its member
 * groups' names in seat order, and its first section as plain text.
 */
export function previewOf(state: GroupState): FollowPreview {
  return {
    name: state.name,
    groups: (state.coalition?.seats ?? []).map((seat) => seat.name),
    excerpt: plainText(state.atoms[0]?.text ?? ''),
  };
}

/** Whether a coalition's state may be shared to followers or followed: it has formed. */
function isFormed(state: GroupState): boolean {
  return state.group !== null && state.coalition?.status === 'formed';
}

/**
 * Making a follow link (#124): a fresh seed, then the envelope (the
 * coalition secret, a preview and the coalition's relay-accepted log, never
 * its outbox) sealed under the follow key and posted to the follow mailbox,
 * kept {@link FOLLOW_TTL_DAYS} day. Returns the link only once every PUT has
 * succeeded; otherwise it rejects, and no link exists to copy.
 *
 * @throws {Error} when the device holds no such formed coalition, or the relay can't be reached.
 */
export async function shareFollowLink(
  services: Services,
  entryId: string,
  origin: string,
): Promise<string> {
  const entry = await services.store.getGroup(entryId);
  const state = entry === undefined ? null : foldGroup(entry);
  if (entry === undefined || state === null || !isFormed(state)) {
    throw new Error('No formed coalition by that id on this device.');
  }
  const seed = newFollowSeed();
  const channel = followChannelOf(seed);
  const follow: Follow = { secret: entry.secret, preview: previewOf(state), entries: entry.log };
  for (const blob of sealFollow(services.seal, channel, follow)) {
    await services.relay.putBlob(channel.mailbox, blob, FOLLOW_TTL_DAYS);
  }
  return followLink(origin, seed);
}

/**
 * An opened follow link (#124): the coalition's genesis id and entry id, its
 * preview, its secret, and its log as the link carried it, with where the
 * relay stood when it was read.
 */
export interface FoundFollow {
  readonly coalitionId: string;
  readonly entryId: string;
  readonly preview: FollowPreview;
  readonly secret: Uint8Array;
  readonly page: {
    readonly records: readonly LogRecord[];
    readonly cursor: number;
    readonly relayNow: number;
    readonly instance: string;
  };
}

/**
 * What opening a follow link found: the coalition to follow; one this
 * device already reads, which takes in what the link carried (`held`); an
 * expired or damaged link; or no relay.
 */
export type FollowLookup =
  | { readonly kind: 'found'; readonly found: FoundFollow }
  | { readonly kind: 'held'; readonly coalitionId: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'offline' };

/** The highest seq among `records`, or 0 for none. */
function highestSeq(records: readonly LogRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.seq), 0);
}

/** The relay's answer for `mailbox`, or null when it can't be reached. */
async function readMailbox(services: Services, mailbox: string) {
  try {
    return await services.relay.getBlobs(mailbox, 0);
  } catch {
    return null;
  }
}

/**
 * Opens the follow link the seed names (#124): reads its mailbox, opens the
 * envelope, and folds its log in memory. Only the follow mailbox id goes to
 * the relay, and nothing is stored for someone new, while a device that
 * already reads the coalition merges in the records it lacks. An empty
 * mailbox (an expired link), a damaged one, or a log that isn't a formed
 * coalition's reads as `missing`.
 */
export async function lookupFollow(services: Services, seed: Uint8Array): Promise<FollowLookup> {
  const channel = followChannelOf(seed);
  const page = await readMailbox(services, channel.mailbox);
  if (page === null) return { kind: 'offline' };
  const follow = openFollow(
    services.seal,
    channel,
    page.records.map((record) => record.data),
  );
  const state = follow === null ? null : fold(follow.entries, page.now);
  const coalitionId = state?.group ?? null;
  if (follow === null || state === null || coalitionId === null || !isFormed(state)) {
    return { kind: 'missing' };
  }
  const entryId = deriveCoalitionEntryId(follow.secret);
  if ((await services.store.getGroup(entryId)) !== undefined) {
    await services.store.mergeLog(entryId, follow.entries, eventIdOf);
    return { kind: 'held', coalitionId };
  }
  const { secret, preview, entries } = follow;
  const records = [...entries];
  const { now: relayNow, instance } = page;
  const cursor = highestSeq(records);
  const found = {
    coalitionId,
    entryId,
    preview,
    secret,
    page: { records, cursor, relayNow, instance },
  };
  return { kind: 'found', found };
}

/**
 * Follow (#124): keeps the coalition as an entry marked `following`, with
 * the link's log read through the same dedupe sync uses and the cursor at
 * its highest seq, so the coalition shows at once, then asks the sync loop
 * to read on. It queues nothing: a follower never writes to the coalition.
 * Returns the coalition's genesis id.
 */
export async function followCoalition(services: Services, found: FoundFollow): Promise<string> {
  const { store } = services;
  const entry = newEntry(found.secret, { following: true });
  await store.addGroup(entry);
  const pull = { ...found.page, records: [...found.page.records], lastSyncAt: services.now() };
  await store.applyPull(entry.groupId, pull, eventIdOf);
  void services.sync.syncOnce();
  return found.coalitionId;
}

/**
 * Unfollow (#124): purges a followed coalition's entry from this device, its
 * secret, keys, log and sync state, as the sync loop purges a group once its
 * leave is in (#77). It posts nothing, so the coalition carries on for its
 * groups as before, and nothing anywhere says this device read it.
 *
 * @throws {Error} when the entry isn't a followed coalition on this device.
 */
export async function unfollow(services: Services, entryId: string): Promise<void> {
  const entry = await services.store.getGroup(entryId);
  if (entry === undefined || !isCoalitionEntry(entry) || entry.following !== true) {
    throw new Error('No followed coalition by that id on this device.');
  }
  await services.store.purgeGroup(entryId);
}
