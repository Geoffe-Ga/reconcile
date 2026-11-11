/**
 * What a device does about its group's key (#98; ADR-0072 item 11, ADR-0074),
 * apart from the relay: the sync loop (`sync.ts`) asks these and does the
 * posting.
 *
 * - **Freeze.** While a key change is due, or the group's key has changed
 *   past the one this device holds, the outbox sends only `key-rotate`,
 *   `leave`, `unwrap-failed` and `key-taken`, so nothing new lands where the
 *   next key wouldn't cover it.
 * - **Duty.** A current member whose device holds the group's current key,
 *   who isn't leaving, and none of whose key changes was refused (#224), may
 *   write the key change: a fresh secret, its commit, and a wrap to each
 *   current member with an encryption key, each made from the secret
 *   (`crypto/epoch.ts`), for the epoch the fold says comes next. The first
 *   valid one in relay order wins, so devices that race lose nothing. A
 *   read-only archive (#108) never does: a dissolve ends key changes, and the
 *   loop sends nothing for it.
 * - **Check** (#224). Before it takes a key change up, the device opens its
 *   own wrap and makes every other wrap again from the secret. It takes the
 *   key up only when all of them match, so no device moves on while any
 *   member is left without the new key. When its wrap doesn't open, or any
 *   other isn't the secret's, it posts an `unwrap-failed` naming the key
 *   change to the old epoch's mailbox, and the fold refuses it. A device whose
 *   own key isn't the one the group holds for it can't judge, and says
 *   nothing.
 * - **Switch.** Once the fold has a key change past this device's epoch that
 *   checks out, the device moves to its epoch: its secret, a cursor at the key
 *   change's seq, and its own records that reached any of the old epoch's
 *   weekly mailboxes after the key changed, to post again in the new one's.
 *   A key change the fold refused but that checks out here, as one a false
 *   `unwrap-failed` named, it takes up too, posting a `key-taken` to the new
 *   epoch's mailbox first, so the fold keeps it.
 * - **Stranded leaves** (#225). A leave that reached the old epoch's mailbox
 *   after the key change, from someone still a member, ends no membership
 *   there, and devices that took the key up never read it. So a device that
 *   read one posts it again, as signed, to the new epoch's mailbox when it
 *   moves, whoever wrote it, and the membership ends where it lands there. A
 *   device that is leaving does the same for its own leave (`sync.ts`).
 * - **No wrap.** Otherwise the device stays where it is, and the group says
 *   why: this membership left on another device, or this device missed the
 *   new key.
 * - **kx.** A current member with no encryption key in the fold, as a device
 *   that joined before #98 has, posts one once, unless the group is leaving
 *   or a read-only archive.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import {
  epochCommit,
  newEpochSecret,
  unwrapEpochSecret,
  wrapEpochSecret,
  wrapsHold,
} from '../crypto/epoch';
import { parseRecord, signEvent } from '../engine/event';
import { type GroupState, keyHolders, type LogRecord, type Rotation } from '../engine/fold';
import { type EpochAdvance, type Group, sameBytes } from './db';
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

/** The event types a frozen outbox still sends (#98, #224). */
const PASSES_FREEZE: ReadonlySet<string> = new Set([
  'key-rotate',
  'leave',
  'unwrap-failed',
  'key-taken',
]);

/**
 * Whether a queued record may go while the outbox is frozen: a `key-rotate`,
 * a `leave`, or an `unwrap-failed` or `key-taken` (#224).
 */
export function passesFreeze(bytes: Uint8Array): boolean {
  return PASSES_FREEZE.has(parseRecord(bytes)?.event.type ?? '');
}

/** Whether a key change `author` wrote was refused (#224): then they may write no other. */
function wasRefused(state: GroupState, author: string): boolean {
  return state.refused.some((rotation) => rotation.by === author);
}

/**
 * Whether this device should write the key change `state` has due now: not
 * while it is leaving, nor for a read-only archive, which sends nothing
 * (#108), nor once a key change its member wrote was refused (#224).
 */
export function hasDuty(group: Group, state: GroupState): boolean {
  if (!state.rotationDue || state.group === null || state.epoch !== epochOf(group)) return false;
  if (group.leaving !== undefined || group.archived !== undefined) return false;
  const { author } = group.me;
  return isMember(state, author) && !wasRefused(state, author);
}

/**
 * The signed `key-rotate` for `state`'s next epoch, signed `ts`: a fresh
 * secret, its commit, and a wrap for each current member with an encryption
 * key, made from the secret (#224). The secret is wiped once wrapped, so this
 * device takes it up as every other does, from its own wrap. The next epoch
 * is the fold's `nextEpoch`, past any a refused key change spent.
 *
 * @throws {Error} when the group has no genesis yet.
 */
export function keyRotateRecord(group: Group, state: GroupState, ts: number): Uint8Array {
  const groupId = state.group;
  if (groupId === null) throw new Error('A key change needs a founded group.');
  const epoch = state.nextEpoch;
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

/**
 * What this device finds a key change to be (#224): `take` with its secret,
 * when its own wrap opens and every wrap is the one that secret makes; `refuse`
 * when its own wrap doesn't open, or any wrap isn't the secret's; `missing`
 * when it can't judge, having no wrap, no encryption key, or a key that isn't
 * the one the group holds for it.
 */
type Verdict =
  | { readonly kind: 'take'; readonly secret: Uint8Array }
  | { readonly kind: 'refuse' }
  | { readonly kind: 'missing' };

/** The encryption key, base64url, this device would open its wraps with, or null without one. */
function ownKx(group: Group): string | null {
  return group.kxKey === undefined ? null : base64url(kxPublicKeyOf(group.kxKey));
}

/** This device's {@link Verdict} on `rotation`, in group `groupId`. */
function judge(group: Group, groupId: string, rotation: Rotation): Verdict {
  const { author } = group.me;
  const wrap = Object.hasOwn(rotation.wraps, author) ? rotation.wraps[author] : undefined;
  const mine = Object.hasOwn(rotation.keys, author) ? rotation.keys[author] : undefined;
  if (wrap === undefined || group.kxKey === undefined || ownKx(group) !== mine) {
    return { kind: 'missing' };
  }
  const { epoch, commit, keys, wraps } = rotation;
  const kxKey = group.kxKey;
  const secret = unwrapEpochSecret({ groupId, epoch, member: author, commit, wrap, kxKey });
  if (secret === null) return { kind: 'refuse' };
  if (wrapsHold({ groupId, epoch, commit, secret, keys, wraps })) return { kind: 'take', secret };
  secret.fill(0);
  return { kind: 'refuse' };
}

/** The event types that never go again to a new epoch: a key change and what is said about one. */
const KEY_EVENTS: ReadonlySet<string> = new Set(['key-rotate', 'unwrap-failed', 'key-taken']);

/** Whether an event of `type` that reached the old mailbox late goes again to the new one. */
function reposts(type: string): boolean {
  return !KEY_EVENTS.has(type);
}

/**
 * This member's records in `log` that were read from epoch `epoch`'s mailboxes
 * after the key change at `seq`, oldest first, each event once: the fold
 * ignores them there, so they go again to the new mailbox. A late `key-rotate`
 * is left out, since it lost, and so is an `unwrap-failed` or a `key-taken`
 * (#224), which only ever counts where it was posted.
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
    if (parsed === null || parsed.event.author !== me || !reposts(parsed.event.type)) return [];
    if (ids.has(parsed.id)) return [];
    ids.add(parsed.id);
    return [record.bytes];
  });
}

/**
 * The records in `log` of each leave `state` names stranded (#225), one per
 * event, oldest first: a device that moves posts them again to the new
 * epoch's mailbox, whoever wrote them.
 */
function strandedRecords(log: readonly LogRecord[], state: GroupState): Uint8Array[] {
  const ids = new Set(state.strandedLeaves.map((leave) => leave.id));
  return log.flatMap((record) => {
    const id = parseRecord(record.bytes)?.id;
    if (id === undefined || !ids.delete(id)) return [];
    return [record.bytes];
  });
}

/** `records` with each record's bytes once, in their first place. */
function distinct(records: readonly Uint8Array[]): Uint8Array[] {
  return records.filter((bytes, i) => records.findIndex((other) => sameBytes(other, bytes)) === i);
}

/** What a sync pull leads this device to do about its group's key (#98, #224). */
export type KeyStep =
  /** Move to a key change's epoch: its secret, cursor and records to post there. */
  | { readonly kind: 'move'; readonly advance: EpochAdvance }
  /** Queue this `unwrap-failed`, signed, for the old epoch's mailbox. */
  | { readonly kind: 'refuse'; readonly record: Uint8Array };

/**
 * The key changes past this device's epoch, canonical or refused, in relay
 * order: what it may move to, the first that checks out.
 */
function candidates(group: Group, state: GroupState): Rotation[] {
  const past = (rotation: Rotation): boolean => rotation.epoch > epochOf(group);
  return [...state.refused.filter(past), ...state.rotations.filter(past)].sort(
    (a, b) => a.seq - b.seq,
  );
}

/**
 * Whether this member's `unwrap-failed` naming `rotation` waits in the outbox.
 * Once it is in the log the fold refuses the key change, and it is passed over.
 */
function queuedRefusal(group: Group, rotation: Rotation): boolean {
  return group.outbox.some((bytes) => {
    const event = parseRecord(bytes)?.event;
    return (
      event?.type === 'unwrap-failed' &&
      event.author === group.me.author &&
      event.body.rotation === rotation.id
    );
  });
}

/** What {@link keyStepFor} works from: the log in relay order, its fold, the group's id, and the time to sign at. */
interface Context {
  readonly log: readonly LogRecord[];
  readonly state: GroupState;
  readonly groupId: string;
  readonly ts: number;
}

/**
 * The move into `rotation` with its `secret`, posting a `key-taken` first when
 * the fold refused it, then this member's late records, then every stranded
 * leave (#225).
 */
function moveInto(group: Group, context: Context, rotation: Rotation, secret: Uint8Array): KeyStep {
  const { log, state } = context;
  const late = lateRecords(log, epochOf(group), rotation.seq, group.me.author);
  const refused = state.refused.some((r) => r.id === rotation.id);
  const taken = refused ? [keyCheckRecord(group, context, 'key-taken', rotation)] : [];
  const advance = {
    epoch: rotation.epoch,
    secret,
    cursor: rotation.seq,
    repost: distinct([...taken, ...late, ...strandedRecords(log, state)]),
  };
  return { kind: 'move', advance };
}

/**
 * What `group`'s log, with `records` read after it put in relay order as the
 * store puts them (`logOrder.ts`, #110), calls for, signed `ts`, or null:
 *
 * - **move** into the first key change past the device's epoch, canonical or
 *   refused, that checks out here (#224), posting a `key-taken` first when
 *   the fold refused it;
 * - **refuse** the canonical one, when it doesn't check out here and this
 *   member hasn't said so yet, with an `unwrap-failed` naming it;
 * - nothing, when there is no key change past the device's epoch, or the
 *   device can't judge the canonical one, or its word that it doesn't open
 *   already waits in the outbox.
 *
 * A refused key change that doesn't check out here is passed over.
 */
export function keyStepFor(
  group: Group,
  records: readonly LogRecord[],
  relayNow: number,
  ts: number,
): KeyStep | null {
  const log = placedInLog(group.log, records);
  const state = foldGroup({ ...group, log, relayNow });
  const groupId = state.group;
  if (groupId === null) return null;
  const context = { log, state, groupId, ts };
  for (const rotation of candidates(group, state)) {
    const verdict = judge(group, groupId, rotation);
    if (verdict.kind === 'take') return moveInto(group, context, rotation, verdict.secret);
    if (state.refused.includes(rotation)) continue;
    if (verdict.kind === 'missing' || queuedRefusal(group, rotation)) return null;
    return { kind: 'refuse', record: keyCheckRecord(group, context, 'unwrap-failed', rotation) };
  }
  return null;
}

/** This member's `unwrap-failed` or `key-taken` naming `rotation`, signed at `context`'s time (#224). */
function keyCheckRecord(
  group: Group,
  { groupId, ts }: Context,
  type: 'unwrap-failed' | 'key-taken',
  rotation: Rotation,
): Uint8Array {
  const body = { rotation: rotation.id };
  return signEvent(group.signingKey, { type, group: groupId, ts, body }).record;
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
 * change that left the device behind, and every stranded leave (#225).
 */
export function adoptionFor(group: Group, epoch: number, secret: Uint8Array): EpochAdvance | null {
  if (epoch <= epochOf(group)) return null;
  const state = foldGroup(group);
  const rotation = state.rotations.find((r) => r.epoch === epoch);
  if (rotation === undefined || state.group === null || !secretFits(state, epoch, secret)) {
    return null;
  }
  // Every wrap must be this secret's, as a switch checks (#224).
  const { commit, keys, wraps } = rotation;
  if (!wrapsHold({ groupId: state.group, epoch, commit, secret, keys, wraps })) return null;
  // The first canonical key change past the device's epoch is the one that left it behind.
  const left = state.rotations.find((r) => r.epoch > epochOf(group)) ?? rotation;
  const late = lateRecords(group.log, epochOf(group), left.seq, group.me.author);
  const repost = distinct([...late, ...strandedRecords(group.log, state)]);
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
