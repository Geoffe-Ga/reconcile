/**
 * What Create group, Copy invite link, Join and Leave do (spec §7 and §8), apart
 * from any screen.
 *
 * Create group and Join each sign one event with the engine, keep its record
 * in the store's outbox, and ask the sync loop to send it at once. Each makes
 * a fresh signing keypair and a fresh encryption keypair for that one group
 * (ADR-0009, #98), kept only with its records; the event carries the
 * encryption key's public half, `kx`, which the group's new secrets are
 * wrapped to when its key changes.
 * Create group also makes the group secret, which the mailbox id and seal key
 * derive from (spec §3). Copy invite link posts a sealed envelope holding the
 * secret and the whole log to a short-lived invite mailbox (#73), so a joiner
 * sees everything the group has decided, even what the relay has purged.
 * Folded state still comes only from relay records, so a new group shows once
 * its genesis is back from the relay.
 */
import { kxPublicKeyOf, newKxKey } from '../crypto/box';
import { newGroupSecret } from '../crypto/groupKeys';
import { inviteChannelOf, newInviteSeed, signInviteToken } from '../crypto/invite';
import { MAX_RECORD_BYTES } from '../crypto/record';
import type { Seal } from '../crypto/seal';
import { newSigningKeys } from '../crypto/sign';
import { genesisAtoms } from '../engine/atomText';
import type { Level } from '../engine/capabilities';
import { atomsOf } from '../engine/documents';
import { base64url, type InviteToken, signEvent } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { displayName } from '../engine/names';
import { DEFAULT_RULES } from '../engine/rules';
import {
  type CarriedCoalition,
  type Envelope,
  INVITE_TTL_DAYS,
  type InvitePreview,
  openEnvelope,
  sealEnvelope,
} from '../invite/envelope';
import type { Relay } from '../net/relay';
import { carriedCoalitions, keepCarried } from '../store/coalitions';
import type { Me, Store } from '../store/db';
import { adoptionFor, epochOf, keyFits, secretFits } from '../store/epochs';
import { eventIdOf } from '../store/eventId';
import { foldGroup } from '../store/expiry';
import type { Sync } from '../store/sync';
import { inviteLink } from './invite';
import { plainText } from './text/markdown';

/** What the actions work with. */
export interface Services {
  /** The device's groups. */
  readonly store: Store;
  /** The sync loop, run once after each new event. */
  readonly sync: Pick<Sync, 'syncOnce'>;
  /** The relay, which Join reads before the group is on the device. */
  readonly relay: Relay;
  /** The seal for blobs: `xchachaSeal` in the app. */
  readonly seal: Seal;
  /** The device clock in milliseconds: an event's display-only `ts`. */
  readonly now: () => number;
}

/** One Document Create group founds (#92): its title, trimmed, and its text as typed. */
export interface FoundingEntry {
  readonly title: string;
  readonly text: string;
}

/** Create group's entries: names trimmed, the chat link null when blank, and its Documents in order. */
export interface CreateGroupValues {
  readonly groupName: string;
  readonly yourName: string;
  readonly chat: string | null;
  readonly documents: readonly FoundingEntry[];
}

/** A created group's id, or why it wasn't created. */
export type CreateResult =
  { readonly outcome: 'created'; readonly groupId: string } | { readonly outcome: 'too-large' };

/**
 * Founds a group: a fresh secret and keys, a signed genesis carrying each
 * Document's title and sections (split at blank lines, each normalized as
 * Atom text), in order (#92), and the founding rules, and the group kept
 * under the genesis id, which is the group id (spec §4). Every group is
 * founded with `DEFAULT_RULES` (ADR-0074). A genesis whose record is over
 * 64,000 bytes, every Document counted, is refused before anything is kept.
 */
export async function createGroup(
  services: Services,
  values: CreateGroupValues,
): Promise<CreateResult> {
  const secret = newGroupSecret();
  const keys = newSigningKeys();
  const kxKey = newKxKey();
  const { groupName: name, yourName: founder, chat } = values;
  const documents = values.documents.map(({ title, text }) => ({
    title,
    atoms: genesisAtoms(text),
  }));
  const body = {
    name,
    founder,
    documents,
    ...(chat === null ? {} : { chat }),
    rules: DEFAULT_RULES,
    kx: base64url(kxPublicKeyOf(kxKey)),
  };
  const genesis = signEvent(keys.secretKey, {
    type: 'genesis',
    group: '',
    ts: services.now(),
    body,
  });
  if (genesis.record.length > MAX_RECORD_BYTES) return { outcome: 'too-large' };
  const groupId = genesis.id;
  const me = { author: base64url(keys.publicKey), name: founder };
  await services.store.addGroup({ groupId, secret, signingKey: keys.secretKey, kxKey, me });
  await services.store.enqueue(groupId, genesis.record);
  void services.sync.syncOnce();
  return { outcome: 'created', groupId };
}

/** An opened invite: the group it admits to, its preview, and the history it carries. */
export interface FoundGroup {
  /** The group id: the id of the first valid genesis among the entries. */
  readonly groupId: string;
  /** What the Join screen shows, as plain text. */
  readonly preview: InvitePreview;
  /** The group secret the envelope carried, kept on Join. */
  readonly secret: Uint8Array;
  /** That secret's epoch (#98), checked against its key change's commit. */
  readonly epoch: number;
  /** The inviter's token, which the join carries. */
  readonly token: InviteToken;
  /** The Proposals whose ballots the inviter's device has cleared (#111), kept on Join. */
  readonly cleared: readonly string[];
  /** The log of each coalition the group reaches (#279), which Join keeps where the group reaches it. */
  readonly coalitions: readonly CarriedCoalition[];
  /**
   * The envelope's entries, the highest seq among them, and the invite GET's
   * relay time and instance: what Join keeps, so the Document shows at once.
   */
  readonly page: {
    readonly records: readonly LogRecord[];
    readonly cursor: number;
    readonly relayNow: number;
    readonly instance: string;
  };
}

/** What opening an invite found. */
export type InviteLookup =
  | { readonly kind: 'found'; readonly group: FoundGroup }
  | { readonly kind: 'joined'; readonly groupId: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'offline' };

/**
 * What the invite's preview shows of a group: its name, the inviter's, and
 * its first Document's title and first section (#92).
 */
function previewOf(state: GroupState, me: Me): InvitePreview {
  const [first] = state.documents;
  const opening = first === undefined ? undefined : atomsOf(state, first.id)[0];
  return {
    groupName: state.name,
    inviterName: displayName(state, me.author) ?? me.name,
    documentTitle: first?.title ?? '',
    excerpt: plainText(opening?.text ?? ''),
  };
}

/**
 * Copy invite link's work (spec §7): a fresh seed, then the envelope (the
 * group secret, a preview, this member's token and the relay-accepted log,
 * never the outbox, then the log of each coalition the group reaches, #279)
 * sealed under the invite key and posted to the invite
 * mailbox, kept {@link INVITE_TTL_DAYS} day. Returns the link only once every
 * PUT has succeeded; otherwise it rejects, and no link exists to copy. A copy
 * this device keeps read-only makes none: a dissolved group's (#108), whose
 * link would carry a group that has ended, a removed member's (#115), and a
 * restored copy that hasn't heard from its group (#231), since a member who
 * opens a link counts it as word from a copy that takes new things.
 *
 * @throws {Error} when the device isn't in the group, keeps it read-only, or
 *   the relay can't be reached.
 */
export async function makeInvite(
  services: Services,
  groupId: string,
  origin: string,
): Promise<string> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  if (group.archived !== undefined) throw new Error('This group is read-only on this device.');
  const seed = newInviteSeed();
  const channel = inviteChannelOf(seed);
  const sig = base64url(signInviteToken(group.signingKey, groupId));
  const cleared = group.cleared ?? [];
  const blobs = sealEnvelope(services.seal, channel, {
    groupSecret: group.secret,
    epoch: epochOf(group),
    preview: previewOf(foldGroup(group), group.me),
    token: { by: group.me.author, sig },
    entries: group.log,
    cleared,
    coalitions: await carriedCoalitions(services.store, group),
  });
  for (const blob of blobs) {
    await services.relay.putBlob(channel.mailbox, blob, INVITE_TTL_DAYS);
  }
  return inviteLink(origin, seed);
}

/** The highest seq among `records`, or 0 for none. */
function highestSeq(records: readonly LogRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.seq), 0);
}

/**
 * Merges an invite's entries into a group this device is already in (#73),
 * then takes up the invite's secret when its epoch is later than the one the
 * device holds and its key change's commit names it (#98): how a device that
 * missed a new key gets back in. A restored copy that hadn't heard from its
 * group goes live (#231): someone in the group made the link. Last, the logs
 * of the coalitions it carries merge in too, or come as new entries, where
 * the group reaches them (#279): how a device that was away while one formed
 * catches up, read at `read`.
 */
async function mergeInvite(
  services: Services,
  groupId: string,
  envelope: Envelope,
  read: { readonly now: number; readonly instance: string },
) {
  const { store } = services;
  await store.mergeLog(groupId, envelope.entries, eventIdOf);
  const group = await store.getGroup(groupId);
  const advance = group && adoptionFor(group, envelope.epoch, envelope.groupSecret);
  if (advance) await store.adoptEpoch(groupId, advance);
  const at = { relayNow: read.now, instance: read.instance, lastSyncAt: services.now() };
  await keepCarried(store, groupId, envelope.coalitions, at);
}

/**
 * Opens the invite the seed names: reads every blob in its mailbox, opens
 * the envelope, and folds its entries in memory to find the group. Only the
 * invite mailbox id goes to the relay. Nothing is stored for a newcomer,
 * while a device already in the group merges in the entries it lacks (#73),
 * and takes up a later key the invite carries (#98). An empty mailbox (an
 * expired link), a missing chunk, a blob that won't open, entries holding no
 * genesis, or a secret its epoch's key change doesn't commit to all read as
 * `missing`, and so, for a newcomer, does a key change with a wrap its secret
 * doesn't make (#372).
 */
export async function lookupInvite(services: Services, seed: Uint8Array): Promise<InviteLookup> {
  const channel = inviteChannelOf(seed);
  let page;
  try {
    page = await services.relay.getBlobs(channel.mailbox, 0);
  } catch {
    return { kind: 'offline' };
  }
  const blobs = page.records.map((record) => record.data);
  const envelope = openEnvelope(services.seal, channel, blobs);
  const state = envelope === null ? null : fold(envelope.entries, page.now, [], envelope.cleared);
  const groupId = state?.group ?? null;
  if (envelope === null || state === null || groupId === null) return { kind: 'missing' };
  if (!secretFits(state, envelope.epoch, envelope.groupSecret)) return { kind: 'missing' };
  if ((await services.store.getGroup(groupId)) !== undefined) {
    await mergeInvite(services, groupId, envelope, page);
    return { kind: 'joined', groupId };
  }
  return newcomerFinds(state, envelope, { groupId, now: page.now, instance: page.instance });
}

/**
 * What a newcomer finds from an invite's `envelope`, its entries folded as
 * `state`: the group, read from the relay at `now` on `instance`, unless the
 * key change into the invite's epoch has a wrap its secret doesn't make, which
 * every member's device refuses (#224), so the newcomer would be stuck where
 * the group recovers (#372): then `missing`, as a damaged link.
 */
function newcomerFinds(
  state: GroupState,
  envelope: Envelope,
  read: { readonly groupId: string; readonly now: number; readonly instance: string },
): InviteLookup {
  if (!keyFits(state, envelope.epoch, envelope.groupSecret)) return { kind: 'missing' };
  const { preview, groupSecret: secret, epoch, token, entries, cleared, coalitions } = envelope;
  const { groupId, now, instance } = read;
  const cursor = highestSeq(entries);
  return {
    kind: 'found',
    group: {
      groupId,
      preview,
      secret,
      epoch,
      token,
      cleared,
      coalitions,
      page: { records: entries, cursor, relayNow: now, instance },
    },
  };
}

/**
 * Joins under `name`, at the involvement level the person chose, with a fresh
 * keypair for this group: keeps the group with the invite's secret and its
 * whole history, read through the same dedupe sync uses, with the cursor at
 * its highest seq, so the Document shows at once. It keeps the Proposals the
 * inviter has cleared as its own `cleared` (#111), so it folds their outcomes
 * from their results, and each coalition the invite carries that the group
 * reaches, with its whole log (#279), so one older than the relay's 30 days
 * shows too. Then queues the signed `join`, carrying the inviter's token, and
 * sends it.
 */
export async function joinGroup(
  services: Services,
  found: FoundGroup,
  name: string,
  level: Level,
): Promise<string> {
  const { groupId, secret, epoch, token, cleared, page } = found;
  const keys = newSigningKeys();
  const kxKey = newKxKey();
  const kx = base64url(kxPublicKeyOf(kxKey));
  const join = signEvent(keys.secretKey, {
    type: 'join',
    group: groupId,
    ts: services.now(),
    body: { name, level, token: { by: token.by, sig: token.sig }, kx },
  });
  const me = { author: base64url(keys.publicKey), name };
  const signingKey = keys.secretKey;
  const kept = cleared.length === 0 ? {} : { cleared: [...cleared] };
  await services.store.addGroup({ groupId, secret, signingKey, kxKey, epoch, me, ...kept });
  const pull = { ...page, records: [...page.records], lastSyncAt: services.now() };
  await services.store.applyPull(groupId, pull, eventIdOf);
  const read = { relayNow: page.relayNow, instance: page.instance, lastSyncAt: pull.lastSyncAt };
  await keepCarried(services.store, groupId, found.coalitions, read);
  await services.store.enqueue(groupId, join.record);
  void services.sync.syncOnce();
  return groupId;
}

/**
 * Leaves `groupId` (#77; ADR-0010): signs this member's `leave`, queues it
 * after anything already queued and marks the group as leaving, in one store
 * change, then sends it. Nothing more is queued for the group, and once the
 * relay returns a seq for the leave, the sync loop deletes the group from this
 * device. Offline, it waits in the outbox across reloads.
 */
export async function leaveGroup(services: Services, groupId: string): Promise<void> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  const leave = signEvent(group.signingKey, {
    type: 'leave',
    group: groupId,
    ts: services.now(),
    body: {},
  });
  await services.store.markLeaving(groupId, leave.record);
  void services.sync.syncOnce();
}
