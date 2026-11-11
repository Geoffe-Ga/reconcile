/**
 * What a device does about its group's key (#98; ADR-0072 item 11, ADR-0074),
 * apart from the relay: the sync loop (`sync.ts`) asks these and does the
 * posting.
 *
 * - **Freeze.** While a key change is due, or the group's key has changed
 *   past the one this device holds, the outbox sends only `key-rotate` and
 *   `leave`, so nothing new lands where the next key wouldn't cover it.
 * - **Duty.** A current member whose device holds the group's current key,
 *   and isn't leaving, may write the key change: a fresh secret, its commit,
 *   and a wrap to each current member with an encryption key. The first valid
 *   one in relay order wins, so devices that race lose nothing. A read-only
 *   archive (#108) never does: a dissolve ends key changes, and the loop sends
 *   nothing for it.
 * - **Switch.** Once the fold has a canonical key change past this device's
 *   epoch, and this member's wrap opens to the secret its commit names, the
 *   device moves to the new epoch: its secret, a cursor at the key change's
 *   seq, and its own records that reached any of the old epoch's weekly
 *   mailboxes after the key changed, to post again in the new one's.
 * - **No wrap.** Otherwise the device stays where it is, and the group says
 *   why: this membership left on another device, or this device missed the
 *   new key.
 * - **kx.** A current member with no encryption key in the fold, as a device
 *   that joined before #98 has, posts one once, unless the group is leaving
 *   or a read-only archive.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { epochCommit, newEpochSecret, unwrapEpochSecret, wrapEpochSecret } from '../crypto/epoch';
import { parseRecord, signEvent } from '../engine/event';
import { type GroupState, keyHolders, type LogRecord, type Rotation } from '../engine/fold';
import type { EpochAdvance, Group } from './db';
import { foldGroup } from './expiry';
import { placedInLog } from './logOrder';

/** Why a device can't read what its group writes now (#98), or null when it can. */
export type KeyChange = 'left' | 'missed';

/** The epoch of the secret a device holds for `group`. */
export function epochOf(group: Pick<Group, 'epoch'>): number {
  return group.epoch ?? 0;
}

/** Whether `me` is a current member in `state`. */
function isMember(state: GroupState, me: string): boolean {
  return state.members.some((member) => member.author === me);
}

/**
 * Whether the outbox holds back everything but `key-rotate` and `leave`: a key
 * change is due, or the group has one this device hasn't taken up.
 */
export function isFrozen(state: GroupState, group: Pick<Group, 'epoch'>): boolean {
  return state.rotationDue || state.epoch > epochOf(group);
}

/** Whether a queued record may go while the outbox is frozen: a `key-rotate` or a `leave`. */
export function passesFreeze(bytes: Uint8Array): boolean {
  const type = parseRecord(bytes)?.event.type;
  return type === 'key-rotate' || type === 'leave';
}

/**
 * Whether this device should write the key change `state` has due now: not
 * while it is leaving, nor for a read-only archive, which sends nothing (#108).
 */
export function hasDuty(group: Group, state: GroupState): boolean {
  return (
    state.rotationDue &&
    state.group !== null &&
    state.epoch === epochOf(group) &&
    group.leaving === undefined &&
    group.archived === undefined &&
    isMember(state, group.me.author)
  );
}

/**
 * The signed `key-rotate` for `state`'s next epoch, signed `ts`: a fresh
 * secret, its commit, and a wrap for each current member with an encryption
 * key. The secret is wiped once wrapped, so this device takes it up as every
 * other does, from its own wrap.
 *
 * @throws {Error} when the group has no genesis yet.
 */
export function keyRotateRecord(group: Group, state: GroupState, ts: number): Uint8Array {
  const groupId = state.group;
  if (groupId === null) throw new Error('A key change needs a founded group.');
  const epoch = state.epoch + 1;
  const secret = newEpochSecret();
  try {
    const commit = epochCommit(groupId, epoch, secret);
    const wraps = Object.fromEntries(
      keyHolders(state).map(({ author: member, kx }) => {
        const wrap = wrapEpochSecret({
          groupId,
          epoch,
          member,
          commit,
          kx: fromBase64url(kx),
          secret,
        });
        return [member, wrap];
      }),
    );
    const body = { epoch, commit, wraps };
    return signEvent(group.signingKey, { type: 'key-rotate', group: groupId, ts, body }).record;
  } finally {
    secret.fill(0);
  }
}

/** The canonical key change into the epoch after the one `group` holds, if the fold has one. */
function nextRotation(group: Group, state: GroupState): Rotation | undefined {
  return state.rotations.find((rotation) => rotation.epoch === epochOf(group) + 1);
}

/** The secret this member's wrap in `rotation` opens to, when it matches the commit. */
function unwrapped(group: Group, groupId: string, rotation: Rotation): Uint8Array | null {
  const { author } = group.me;
  const wrap = Object.hasOwn(rotation.wraps, author) ? rotation.wraps[author] : undefined;
  if (wrap === undefined || group.kxKey === undefined) return null;
  const { epoch, commit } = rotation;
  return unwrapEpochSecret({ groupId, epoch, member: author, commit, wrap, kxKey: group.kxKey });
}

/**
 * This member's records in `log` that were read from epoch `epoch`'s mailboxes
 * after the key change at `seq`, oldest first, each event once: the fold
 * ignores them there, so they go again to the new mailbox. A late `key-rotate`
 * is left out, since it lost.
 */
function lateRecords(
  log: readonly LogRecord[],
  epoch: number,
  seq: number,
  me: string,
): Uint8Array[] {
  const ids = new Set<string>();
  return log.flatMap((record) => {
    if ((record.epoch ?? 0) !== epoch || record.seq <= seq) return [];
    const parsed = parseRecord(record.bytes);
    if (parsed === null || parsed.event.author !== me || parsed.event.type === 'key-rotate')
      return [];
    if (ids.has(parsed.id)) return [];
    ids.add(parsed.id);
    return [record.bytes];
  });
}

/**
 * The move to the next epoch that `group`'s log, with `records` read after it
 * put in relay order as the store puts them (`logOrder.ts`, #110), calls
 * for, or null: none when the fold has no key change past the device's
 * epoch, or this member's wrap doesn't open to the secret its commit names.
 */
export function advanceFor(
  group: Group,
  records: readonly LogRecord[],
  relayNow: number,
): EpochAdvance | null {
  const log = placedInLog(group.log, records);
  const state = foldGroup({ ...group, log, relayNow });
  const rotation = nextRotation(group, state);
  if (rotation === undefined || state.group === null) return null;
  const secret = unwrapped(group, state.group, rotation);
  if (secret === null) return null;
  const repost = lateRecords(log, epochOf(group), rotation.seq, group.me.author);
  return { epoch: rotation.epoch, secret, cursor: rotation.seq, repost };
}

/**
 * Whether `secret` is epoch `epoch`'s, as `state` has it: any secret at epoch
 * 0, which no key change commits to, and otherwise the one the canonical key
 * change into `epoch` commits to (#98). An invite's secret is checked so.
 */
export function secretFits(state: GroupState, epoch: number, secret: Uint8Array): boolean {
  if (epoch === 0) return true;
  const rotation = state.rotations.find((r) => r.epoch === epoch);
  if (rotation === undefined || state.group === null || secret.length !== 32) return false;
  return epochCommit(state.group, epoch, secret) === rotation.commit;
}

/**
 * The move to epoch `epoch` that an invite carrying its `secret` allows
 * (#98), or null: none unless `epoch` is past the one `group` holds and its
 * canonical key change commits to `secret`. Like a move by sync, it posts
 * again this member's records that reached the old mailbox after the key
 * change that left the device behind.
 */
export function adoptionFor(group: Group, epoch: number, secret: Uint8Array): EpochAdvance | null {
  if (epoch <= epochOf(group)) return null;
  const state = foldGroup(group);
  const rotation = state.rotations.find((r) => r.epoch === epoch);
  if (rotation === undefined || !secretFits(state, epoch, secret)) return null;
  // Key changes are numbered from 1 in order, so this is the one into the device's next epoch.
  const left = state.rotations[epochOf(group)] ?? rotation;
  const repost = lateRecords(group.log, epochOf(group), left.seq, group.me.author);
  return { epoch, secret, cursor: rotation.seq, repost };
}

/**
 * Why this device can't read what `group` writes now, or null when it can:
 * `left` once this membership has left, on another device, and the key has
 * changed past it; `missed` when the key changed and this device has no wrap
 * that opens.
 */
export function keyChangeOf(
  group: Pick<Group, 'epoch' | 'me'>,
  state: GroupState,
): KeyChange | null {
  if (state.epoch <= epochOf(group)) return null;
  const left = state.former.some((member) => member.author === group.me.author);
  return left ? 'left' : 'missed';
}

/**
 * Whether this device should post its member's encryption key: they are a
 * current member with none in the fold, no `kx` waits in the outbox, and the
 * group is neither leaving nor a read-only archive, which takes nothing new
 * (#108).
 */
export function needsKx(group: Group, state: GroupState): boolean {
  const mine = state.members.find((member) => member.author === group.me.author);
  if (mine === undefined || mine.kx !== null) return false;
  if (group.leaving !== undefined || group.archived !== undefined) return false;
  return !group.outbox.some((bytes) => parseRecord(bytes)?.event.type === 'kx');
}

/** The signed `kx` giving this member the encryption key `kxKey`, signed `ts`. */
export function kxRecord(group: Group, groupId: string, kxKey: Uint8Array, ts: number): Uint8Array {
  const kx = base64url(kxPublicKeyOf(kxKey));
  return signEvent(group.signingKey, { type: 'kx', group: groupId, ts, body: { kx } }).record;
}
