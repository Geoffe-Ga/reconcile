/**
 * A recovery contact's side of recovering with contacts (#118; ADR-0043 §2,
 * ADR-0008, ADR-0075 §4).
 *
 * - **Approving.** Settings › Help someone recover takes the code the person
 *   sent and asks whose share it is for. The contact calls them or meets
 *   them, and types the six digits they read out; {@link approveRecovery}
 *   goes on only when those match the code's check (`crypto/recovery.ts`),
 *   so a code swapped on its way never gets a share. The contact also types
 *   the second number the new device shows, which isn't in the code (#398):
 *   it goes inside the release, and the new device drops a release without
 *   it, so someone holding only the code can't plant shares. It posts a
 *   `recovery-alert` in the share's group, sealed to the person's encryption
 *   key, with a fresh tag inside, and keeps a hold beside it, in one store
 *   change.
 * - **Holding.** The hold ends at the alert's relay `received` + 4,320
 *   minutes (72 hours), on this device, in relay time (ADR-0075 §4).
 * - **Releasing.** After each complete sync pass (`afterEveryPass`), so with
 *   a fresh read of the group, each hold whose time has come is checked for a
 *   `recovery-cancel` naming its tag from the share's owner, the person, and
 *   from no one else. With none, and while the share this device holds for
 *   them is still the one approved, the device seals the share to the new
 *   device, seals that under the request mailbox's key, so it is one
 *   1,024-byte blob, and PUTs it there for 7 days. A cancel, or a share from
 *   a later choice of contacts, stops the hold and nothing goes. A pass that
 *   fails runs none of this, and a PUT that fails is tried again after the
 *   next complete pass.
 * - **Sending again.** A stopped hold drops its code and second number at
 *   once. A sent one keeps them while the relay keeps the release, 7 days in
 *   relay time, so a contact who typed the number wrong can send it again
 *   with the right one ({@link resendRelease}); then the pass drops them.
 *
 * Contacts who collude can skip all of this by putting their shares
 * together themselves: an accepted pilot risk (ADR-0075 §4). What the wait
 * stops is someone passing themselves off as the person to honest contacts.
 */
import { fromBase64url } from '../crypto/base64url';
import {
  newAlertTag,
  parseRecoveryCode,
  recoveryChannel,
  recoveryCheck,
  sealAlert,
  sealRelease,
} from '../crypto/recovery';
import type { Seal } from '../crypto/seal';
import { signEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { displayName } from '../engine/names';
import type { Relay } from '../net/relay';
import type { Group, HoldEnd, RecoveryHold, Store } from '../store/db';
import { foldGroup } from '../store/expiry';
import { afterSyncPass, openHeldShare } from '../store/recovery';
import type { Sync } from '../store/sync';

/** How long a contact holds a share after the relay receives their alert: 72 hours, in minutes. */
export const HOLD_MINUTES = 4320;

/** How long the relay keeps a released share: 7 days. */
export const RELEASE_TTL_DAYS = 7;

/** Relay minutes in a day. */
const MINUTES_PER_DAY = 1440;

/** Thrown when the number the person read out isn't the code's check: nothing is approved. */
export class CheckMismatch extends Error {
  constructor() {
    super('That number doesn’t match the code.');
    this.name = 'CheckMismatch';
  }
}

/** Thrown when the second number typed isn't six digits (#398): nothing is approved or sent. */
export class SecondNumberInvalid extends Error {
  constructor() {
    super('The second number is six digits.');
    this.name = 'SecondNumberInvalid';
  }
}

/**
 * What a contact approves: the code, whose share (their key in the group),
 * the number read out, and the second number the new device shows (#398).
 */
export interface Approval {
  readonly code: string;
  readonly groupId: string;
  readonly person: string;
  readonly check: string;
  readonly number: string;
}

/** What approving works with. */
export interface ApproveServices {
  readonly store: Pick<Store, 'getGroup' | 'holdShare'>;
  readonly sync: Pick<Sync, 'syncOnce'>;
  /** The device clock in milliseconds. */
  readonly now: () => number;
}

/** What releasing works with. */
export interface ReleaseServices {
  readonly store: Pick<Store, 'listGroups' | 'endHold' | 'forgetHoldCode'>;
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly seal: Seal;
  /** The device clock in milliseconds, for when a hold ended. */
  readonly now: () => number;
}

/**
 * Where a hold stands, as Help someone recover says it: waiting for the
 * relay to take the alert (`soon`), holding until a relay minute, `ready` to
 * go on the next complete sync pass, `sent`, or `stopped` by a cancel, which
 * it reads as soon as this device has seen one.
 */
export type HoldStatus =
  | { readonly kind: 'soon' | 'ready' | 'sent' | 'stopped' }
  | { readonly kind: 'holding'; readonly until: number };

/** What sending a release again works with (#398). */
export interface ResendServices {
  readonly store: Pick<Store, 'getGroup' | 'setHoldNumber'>;
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly seal: Seal;
}

/** One hold as Help someone recover shows it. */
export interface HoldView {
  /** The alert's event id. */
  readonly alert: string;
  readonly groupId: string;
  /** The person's name in the group. */
  readonly name: string;
  readonly status: HoldStatus;
  /** The second number typed, while the hold keeps it (#398). */
  readonly number: string | null;
  /** Whether the share can go again with a corrected second number (#398). */
  readonly resend: boolean;
}

/** `typed` as six digits, with the spaces it was read out in taken out (#398). */
function secondNumber(typed: string): string {
  const number = typed.replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(number)) throw new SecondNumberInvalid();
  return number;
}

/** The person's encryption key in `state`, or null when they have none or have gone. */
function kxOf(state: GroupState, person: string): string | null {
  return state.members.find(({ author }) => author === person)?.kx ?? null;
}

/**
 * Approves a recovery (#118): checks the number read out against the code,
 * then queues a `recovery-alert` to the person in the share's group and
 * keeps the hold beside it, with the second number (#398), and runs a sync
 * pass so the alert goes.
 *
 * @throws {RangeError} when `code` holds no recovery code.
 * @throws {CheckMismatch} when the number isn't the code's check.
 * @throws {SecondNumberInvalid} when the second number isn't six digits.
 * @throws {Error} when this device holds no share for `person` in the
 *   group; nothing is queued or kept for any of these.
 */
export async function approveRecovery(
  services: ApproveServices,
  { code, groupId, person, check, number: typed }: Approval,
): Promise<void> {
  const parsed = parseRecoveryCode(code);
  if (parsed === null) throw new RangeError('That isn’t a recovery code.');
  if (check.replace(/\s/g, '') !== recoveryCheck(parsed.code)) throw new CheckMismatch();
  const number = secondNumber(typed);
  const group = await services.store.getGroup(groupId);
  const share = group === undefined ? null : openHeldShare(group, person);
  const kx = group === undefined ? null : kxOf(foldGroup(group), person);
  if (group === undefined || share === null || kx === null) {
    throw new Error('This device holds no share for them.');
  }
  const { split } = share;
  share.share.fill(0);
  const tag = newAlertTag();
  const box = sealAlert({ groupId, person, kx: fromBase64url(kx) }, { split, tag });
  const draft = {
    type: 'recovery-alert',
    group: groupId,
    ts: services.now(),
    body: { box },
  } as const;
  const { record, id } = signEvent(group.signingKey, draft);
  const hold = {
    alert: id,
    person,
    split,
    tag,
    code: parsed.code,
    number,
    approvedAt: services.now(),
  };
  await services.store.holdShare(groupId, record, hold);
  await services.sync.syncOnce();
}

/** Whether the person whose share `hold` is has cancelled it: their key, naming its tag. */
function isCancelled(state: GroupState, hold: RecoveryHold): boolean {
  return state.recoveryCancels.some(({ by, alert }) => by === hold.person && alert === hold.tag);
}

/** The relay minute `hold` ends at, or null until the relay has its alert. */
function holdEnd(state: GroupState, hold: RecoveryHold): number | null {
  const alert = state.recoveryAlerts.find(({ id }) => id === hold.alert);
  return alert === undefined ? null : alert.received + HOLD_MINUTES;
}

/**
 * Puts the share `hold` approved, sealed to the new device with `number`
 * inside (#398), in the request mailbox: `sent` once the relay has it,
 * `stopped` when there is no share to send (the person chose again, or
 * left) or no second number (a hold approved before #398), or null when the
 * PUT failed.
 */
async function release(
  services: Pick<ReleaseServices, 'relay' | 'seal'>,
  group: Group,
  hold: RecoveryHold,
  number = hold.number,
): Promise<HoldEnd['kind'] | null> {
  const code = parseRecoveryCode(hold.code ?? '');
  const share = openHeldShare(group, hold.person);
  if (code === null || number === undefined || share?.split !== hold.split) {
    share?.share.fill(0);
    return 'stopped';
  }
  const { mailbox, key } = recoveryChannel(code.seed);
  let blob: Uint8Array<ArrayBuffer>;
  try {
    blob = services.seal.seal(mailbox, key, sealRelease(code.publicKey, mailbox, share, number));
  } finally {
    share.share.fill(0);
    key.fill(0);
  }
  return services.relay.putBlob(mailbox, blob, RELEASE_TTL_DAYS).then(
    () => 'sent' as const,
    () => null,
  );
}

/**
 * What becomes of `hold` after this pass: stopped by a cancel, released once
 * its time has come by the group's relay minute, or null to wait.
 */
async function settle(
  services: ReleaseServices,
  group: Group & { readonly relayNow: number },
  state: GroupState,
  hold: RecoveryHold,
): Promise<HoldEnd['kind'] | null> {
  const until = holdEnd(state, hold);
  if (until === null) return null;
  if (isCancelled(state, hold)) return 'stopped';
  return group.relayNow < until ? null : release(services, group, hold);
}

/** Whether `group` has synced, so its relay minute can end a hold. */
function hasSynced(group: Group): group is Group & { readonly relayNow: number } {
  return group.relayNow !== null;
}

/** The relay minute a sent `hold`'s release leaves the relay, so it can't go again (#398). */
function resendEnd(state: GroupState, hold: RecoveryHold): number | null {
  const until = holdEnd(state, hold);
  return until === null ? null : until + RELEASE_TTL_DAYS * MINUTES_PER_DAY;
}

/**
 * Whether `hold` was sent and may go again with a corrected second number
 * at `relayNow` (#398): it keeps its code, the person hasn't cancelled, and
 * the relay still keeps its release.
 */
function canResend(state: GroupState, hold: RecoveryHold, relayNow: number): boolean {
  if (hold.ended?.kind !== 'sent' || hold.code === undefined) return false;
  const until = resendEnd(state, hold);
  return until !== null && relayNow < until && !isCancelled(state, hold);
}

/** Settles each of `group`'s open holds after a pass, and forgets the code of each sent one that can't go again. */
async function settleGroup(
  services: ReleaseServices,
  group: Group & { readonly relayNow: number },
): Promise<void> {
  const state = foldGroup(group);
  for (const hold of group.recoveryHolds ?? []) {
    if (hold.ended === undefined) {
      const kind = await settle(services, group, state, hold);
      if (kind !== null) {
        await services.store.endHold(group.groupId, hold.alert, { kind, at: services.now() });
      }
    } else if (hold.code !== undefined && !canResend(state, hold, group.relayNow)) {
      await services.store.forgetHoldCode(group.groupId, hold.alert);
    }
  }
}

/**
 * After a complete sync pass: for each hold still open on this device, stops
 * it on a cancel from the person, or releases its share once 4,320 relay
 * minutes have passed since the relay received its alert. A sent hold
 * forgets its code and second number once the relay no longer keeps its
 * release, or the person cancels (#398).
 */
export async function releaseHeldShares(services: ReleaseServices): Promise<void> {
  for (const group of await services.store.listGroups()) {
    if ((group.recoveryHolds ?? []).length === 0 || !hasSynced(group)) continue;
    await settleGroup(services, group);
  }
}

/**
 * Sends the share of the sent hold of `alert` again, with a corrected second
 * `number` (#398), and keeps that number on the hold. The relay keeps both
 * releases; the new device drops the one with the wrong number.
 *
 * @throws {SecondNumberInvalid} when `number` isn't six digits.
 * @throws {Error} when the hold can't go again (it isn't sent, has forgotten
 *   its code, was cancelled, or its share is gone), or the relay didn't take it.
 */
export async function resendRelease(
  services: ResendServices,
  { groupId, alert, number: typed }: { groupId: string; alert: string; number: string },
): Promise<void> {
  const number = secondNumber(typed);
  const group = await services.store.getGroup(groupId);
  const hold = group?.recoveryHolds?.find((held) => held.alert === alert);
  if (group === undefined || hold === undefined || !hasSynced(group)) {
    throw new Error('This share can’t go again.');
  }
  if (!canResend(foldGroup(group), hold, group.relayNow)) {
    throw new Error('This share can’t go again.');
  }
  const kind = await release(services, group, hold, number);
  if (kind !== 'sent') throw new Error('This share didn’t go again.');
  await services.store.setHoldNumber(groupId, alert, number);
}

/**
 * What the app runs after each complete sync pass (`createSync`'s
 * `afterPass`): any held shares due to go or stop (#118) first, since they
 * are small and time matters, then the relay backup's refresh and the
 * overwrite of retired backup ids (`afterSyncPass`, #97, #109). A failure
 * releasing leaves the rest to run.
 */
export async function afterEveryPass(
  services: ReleaseServices & Parameters<typeof afterSyncPass>[0],
): Promise<void> {
  await releaseHeldShares(services).catch(() => undefined);
  await afterSyncPass(services);
}

/** Where `hold` stands in `state` by `relayNow`, the group's relay minute as this device estimates it. */
function statusOf(state: GroupState, hold: RecoveryHold, relayNow: number): HoldStatus {
  if (hold.ended !== undefined) return { kind: hold.ended.kind };
  if (isCancelled(state, hold)) return { kind: 'stopped' };
  const until = holdEnd(state, hold);
  if (until === null) return { kind: 'soon' };
  return relayNow < until ? { kind: 'holding', until } : { kind: 'ready' };
}

/**
 * Every hold on this device, group by group in the store's order, oldest
 * first, as Help someone recover shows them, each read at `relayNow(group)`.
 */
export function holdViews(
  groups: readonly Group[],
  relayNow: (group: Group) => number,
): HoldView[] {
  return groups.flatMap((group) => {
    const holds = group.recoveryHolds ?? [];
    if (holds.length === 0) return [];
    const state = foldGroup(group);
    const now = relayNow(group);
    return holds.map((hold) => ({
      alert: hold.alert,
      groupId: group.groupId,
      name: displayName(state, hold.person) ?? '',
      status: statusOf(state, hold, now),
      number: hold.number ?? null,
      resend: canResend(state, hold, now),
    }));
  });
}
