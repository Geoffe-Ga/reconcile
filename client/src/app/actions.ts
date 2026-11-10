/**
 * What Create group, Join and Leave do (spec §7 and §8), apart from any screen.
 *
 * Each action signs one event with the engine, keeps its record in the
 * store's outbox, and asks the sync loop to send it at once. Create group and
 * Join each make a fresh keypair for that one group (ADR-0009), kept only with
 * its records. Create group also makes the group secret, which the mailbox
 * id and seal key derive from (spec §3). Folded state still comes only from
 * relay records, so a new group shows once its genesis is back from the relay.
 */
import { newGroupSecret } from '../crypto/groupKeys';
import { MAX_RECORD_BYTES } from '../crypto/record';
import type { Seal } from '../crypto/seal';
import { newSigningKeys } from '../crypto/sign';
import { genesisAtoms } from '../engine/atomText';
import type { Level } from '../engine/capabilities';
import { base64url, signEvent } from '../engine/event';
import { fold, type LogRecord } from '../engine/fold';
import { DEFAULT_RULES } from '../engine/rules';
import type { Relay } from '../net/relay';
import type { Store } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { channelOf, openRecords, type Sync } from '../store/sync';
import type { Invite } from './invite';

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

/** What an invite's mailbox held: the group's genesis details and the records read. */
export interface FoundGroup {
  readonly groupId: string;
  readonly name: string;
  readonly title: string;
  /** The opened records and the relay's cursor, time and instance, kept on Join. */
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
 * Reads the mailbox the invite's secret derives, and folds it to find the
 * group. Only the mailbox id goes to the relay; the secret stays on the device.
 */
export async function lookupInvite(services: Services, invite: Invite): Promise<InviteLookup> {
  const channel = channelOf(invite.secret);
  let page;
  try {
    page = await services.relay.getBlobs(channel.mailbox, 0);
  } catch {
    return { kind: 'offline' };
  }
  const records = openRecords(services.seal, channel, page.records);
  const state = fold(records, page.now);
  if (state.group === null) return { kind: 'missing' };
  const groupId = state.group;
  if ((await services.store.getGroup(groupId)) !== undefined) return { kind: 'joined', groupId };
  const cursor = page.records.at(-1)?.seq ?? 0;
  return {
    kind: 'found',
    group: {
      groupId,
      name: state.name,
      title: state.title,
      page: { records, cursor, relayNow: page.now, instance: page.instance },
    },
  };
}

/**
 * Joins under `name`, at the involvement level the person chose, with a fresh
 * keypair for this group: keeps the group with the records the invite read, so
 * its Document shows at once, then queues the signed `join` and sends it.
 */
export async function joinGroup(
  services: Services,
  invite: Invite,
  found: FoundGroup,
  name: string,
  level: Level,
): Promise<string> {
  const { groupId, page } = found;
  const keys = newSigningKeys();
  const join = signEvent(keys.secretKey, {
    type: 'join',
    group: groupId,
    ts: services.now(),
    body: { name, level },
  });
  const { secret } = invite;
  const me = { author: base64url(keys.publicKey), name };
  await services.store.addGroup({ groupId, secret, signingKey: keys.secretKey, me });
  const pull = { ...page, records: [...page.records], lastSyncAt: services.now() };
  await services.store.applyPull(groupId, pull, eventIdOf);
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
