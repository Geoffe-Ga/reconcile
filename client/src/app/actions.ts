/**
 * What Create group, Copy invite link and Join do (spec §7 and §8), apart from
 * any screen.
 *
 * Create group and Join each sign one event with the engine, keep its record
 * in the store's outbox, and ask the sync loop to send it at once. Each makes
 * a fresh keypair for that one group (ADR-0009), kept only with its records.
 * Create group also makes the group secret, which the mailbox id and seal key
 * derive from (spec §3). Copy invite link posts a sealed envelope holding the
 * secret and the whole log to a short-lived invite mailbox (#73), so a joiner
 * sees everything the group has decided, even what the relay has purged.
 * Folded state still comes only from relay records, so a new group shows once
 * its genesis is back from the relay.
 */
import { newGroupSecret } from '../crypto/groupKeys';
import { inviteChannelOf, newInviteSeed, signInviteToken } from '../crypto/invite';
import { MAX_RECORD_BYTES } from '../crypto/record';
import type { Seal } from '../crypto/seal';
import { newSigningKeys } from '../crypto/sign';
import { genesisAtoms } from '../engine/atomText';
import type { Level } from '../engine/capabilities';
import { base64url, type InviteToken, signEvent } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { displayName } from '../engine/names';
import { DEFAULT_RULES } from '../engine/rules';
import {
  INVITE_TTL_DAYS,
  type InvitePreview,
  openEnvelope,
  sealEnvelope,
} from '../invite/envelope';
import type { Relay } from '../net/relay';
import type { Me, Store } from '../store/db';
import { eventIdOf } from '../store/eventId';
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

/** Create group's entries: names and title trimmed, the chat link null when blank. */
export interface CreateGroupValues {
  readonly groupName: string;
  readonly yourName: string;
  readonly chat: string | null;
  readonly title: string;
  readonly text: string;
}

/** A created group's id, or why it wasn't created. */
export type CreateResult =
  { readonly outcome: 'created'; readonly groupId: string } | { readonly outcome: 'too-large' };

/**
 * Founds a group: a fresh secret and keys, a signed genesis carrying the
 * Document's sections (split at blank lines, each normalized as Atom text)
 * and the founding rules, and the group kept under the genesis id, which is
 * the group id (spec §4). Every group is founded with `DEFAULT_RULES`
 * (ADR-0074). A genesis whose record is over 64,000 bytes is refused before
 * anything is kept.
 */
export async function createGroup(
  services: Services,
  values: CreateGroupValues,
): Promise<CreateResult> {
  const secret = newGroupSecret();
  const keys = newSigningKeys();
  const { groupName: name, yourName: founder, chat, title, text } = values;
  const body = {
    name,
    founder,
    title,
    atoms: genesisAtoms(text),
    ...(chat === null ? {} : { chat }),
    rules: DEFAULT_RULES,
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
  await services.store.addGroup({ groupId, secret, signingKey: keys.secretKey, me });
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
  /** The inviter's token, which the join carries. */
  readonly token: InviteToken;
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

/** What the invite's preview shows of a group: its name, the inviter's, the title and the first section. */
function previewOf(state: GroupState, me: Me): InvitePreview {
  return {
    groupName: state.name,
    inviterName: displayName(state, me.author) ?? me.name,
    documentTitle: state.title,
    excerpt: plainText(state.atoms[0]?.text ?? ''),
  };
}

/**
 * Copy invite link's work (spec §7): a fresh seed, then the envelope (the
 * group secret, a preview, this member's token and the relay-accepted log,
 * never the outbox) sealed under the invite key and posted to the invite
 * mailbox, kept {@link INVITE_TTL_DAYS} day. Returns the link only once every
 * PUT has succeeded; otherwise it rejects, and no link exists to copy.
 *
 * @throws {Error} when the device isn't in the group or the relay can't be reached.
 */
export async function makeInvite(
  services: Services,
  groupId: string,
  origin: string,
): Promise<string> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) throw new Error('No such group on this device.');
  const seed = newInviteSeed();
  const channel = inviteChannelOf(seed);
  const sig = base64url(signInviteToken(group.signingKey, groupId));
  const blobs = sealEnvelope(services.seal, channel, {
    groupSecret: group.secret,
    preview: previewOf(fold(group.log, group.relayNow), group.me),
    token: { by: group.me.author, sig },
    entries: group.log,
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
 * Opens the invite the seed names: reads every blob in its mailbox, opens
 * the envelope, and folds its entries in memory to find the group. Only the
 * invite mailbox id goes to the relay. Nothing is stored for a newcomer,
 * while a device already in the group merges in the entries it lacks (#73).
 * An empty mailbox (an expired link), a missing chunk, a blob that won't
 * open, or entries holding no genesis all read as `missing`.
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
  const groupId = envelope === null ? null : fold(envelope.entries, page.now).group;
  if (envelope === null || groupId === null) return { kind: 'missing' };
  if ((await services.store.getGroup(groupId)) !== undefined) {
    await services.store.mergeLog(groupId, envelope.entries, eventIdOf);
    return { kind: 'joined', groupId };
  }
  const { preview, groupSecret: secret, token, entries } = envelope;
  const cursor = highestSeq(entries);
  return {
    kind: 'found',
    group: {
      groupId,
      preview,
      secret,
      token,
      page: { records: entries, cursor, relayNow: page.now, instance: page.instance },
    },
  };
}

/**
 * Joins under `name`, at the involvement level the person chose, with a fresh
 * keypair for this group: keeps the group with the invite's secret and its
 * whole history, read through the same dedupe sync uses, with the cursor at
 * its highest seq, so the Document shows at once. Then queues the signed
 * `join`, carrying the inviter's token, and sends it.
 */
export async function joinGroup(
  services: Services,
  found: FoundGroup,
  name: string,
  level: Level,
): Promise<string> {
  const { groupId, secret, token, page } = found;
  const keys = newSigningKeys();
  const join = signEvent(keys.secretKey, {
    type: 'join',
    group: groupId,
    ts: services.now(),
    body: { name, level, token: { by: token.by, sig: token.sig } },
  });
  const me = { author: base64url(keys.publicKey), name };
  await services.store.addGroup({ groupId, secret, signingKey: keys.secretKey, me });
  const pull = { ...page, records: [...page.records], lastSyncAt: services.now() };
  await services.store.applyPull(groupId, pull, eventIdOf);
  await services.store.enqueue(groupId, join.record);
  void services.sync.syncOnce();
  return groupId;
}
