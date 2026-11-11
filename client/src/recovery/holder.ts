/**
 * A recovery contact's side of recovering with contacts (#118; ADR-0043 §2,
 * ADR-0008, ADR-0075 §4).
 *
 * - **Approving.** Settings › Help someone recover takes the code the person
 *   sent and asks whose share it is for. The contact calls them or meets
 *   them, and types the six digits they read out; {@link approveRecovery}
 *   goes on only when those match the code's check (`crypto/recovery.ts`),
 *   so a code swapped on its way never gets a share. It posts a
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
 *   next complete pass. Each hold drops its code once it ends.
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

/** Thrown when the number the person read out isn't the code's check: nothing is approved. */
export class CheckMismatch extends Error {
  constructor() {
    super('That number doesn’t match the code.');
    this.name = 'CheckMismatch';
  }
}

/** What a contact approves: the code, whose share (their key in the group), and the number read out. */
export interface Approval {
  readonly code: string;
  readonly groupId: string;
  readonly person: string;
  readonly check: string;
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
  readonly store: Pick<Store, 'listGroups' | 'endHold'>;
  readonly relay: Pick<Relay, 'putBlob'>;
  readonly seal: Seal;
  /** The device clock in milliseconds, for when a hold ended. */
  readonly now: () => number;
}

/** One hold as Help someone recover shows it. */
export interface HoldView {
  /** The alert's event id. */
  readonly alert: string;
  readonly groupId: string;
  /** The person's name in the group. */
  readonly name: string;
  /** The relay minute the hold ends, or null until the relay has the alert. */
  readonly until: number | null;
  /** How it ended, or null while it holds: stopped as soon as this device sees a cancel. */
  readonly ended: HoldEnd['kind'] | null;
}

/** The person's encryption key in `state`, or null when they have none or have gone. */
function kxOf(state: GroupState, person: string): string | null {
  return state.members.find(({ author }) => author === person)?.kx ?? null;
}

/**
 * Approves a recovery (#118): checks the number read out against the code,
 * then queues a `recovery-alert` to the person in the share's group and
 * keeps the hold beside it, and runs a sync pass so the alert goes.
 *
 * @throws {RangeError} when `code` holds no recovery code.
 * @throws {CheckMismatch} when the number isn't the code's check.
 * @throws {Error} when this device holds no share for `person` in the
 *   group; nothing is queued or kept for any of these.
 */
export async function approveRecovery(
  services: ApproveServices,
  { code, groupId, person, check }: Approval,
): Promise<void> {
  const parsed = parseRecoveryCode(code);
  if (parsed === null) throw new RangeError('That isn’t a recovery code.');
  if (check.replace(/\s/g, '') !== recoveryCheck(parsed.code)) throw new CheckMismatch();
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
  const hold = { alert: id, person, split, tag, code: parsed.code, approvedAt: services.now() };
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
 * Puts the share `hold` approved, sealed to the new device, in the request
 * mailbox: `sent` once the relay has it, `stopped` when there is no share to
 * send (the person chose again, or left), or null when the PUT failed.
 */
async function release(
  services: ReleaseServices,
  group: Group,
  hold: RecoveryHold,
): Promise<HoldEnd['kind'] | null> {
  const code = parseRecoveryCode(hold.code ?? '');
  const share = openHeldShare(group, hold.person);
  if (code === null || share?.split !== hold.split) {
    share?.share.fill(0);
    return 'stopped';
  }
  const { mailbox, key } = recoveryChannel(code.seed);
  let blob: Uint8Array<ArrayBuffer>;
  try {
    blob = services.seal.seal(mailbox, key, sealRelease(code.publicKey, mailbox, share));
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

/**
 * After a complete sync pass: for each hold still open on this device, stops
 * it on a cancel from the person, or releases its share once 4,320 relay
 * minutes have passed since the relay received its alert.
 */
export async function releaseHeldShares(services: ReleaseServices): Promise<void> {
  for (const group of await services.store.listGroups()) {
    const open = (group.recoveryHolds ?? []).filter(({ ended }) => ended === undefined);
    if (open.length === 0 || !hasSynced(group)) continue;
    const state = foldGroup(group);
    for (const hold of open) {
      const kind = await settle(services, group, state, hold);
      if (kind !== null) {
        await services.store.endHold(group.groupId, hold.alert, { kind, at: services.now() });
      }
    }
  }
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

/** Every hold on this device, group by group in the store's order, oldest first, as Help someone recover shows them. */
export function holdViews(groups: readonly Group[]): HoldView[] {
  return groups.flatMap((group) => {
    const holds = group.recoveryHolds ?? [];
    if (holds.length === 0) return [];
    const state = foldGroup(group);
    return holds.map((hold) => ({
      alert: hold.alert,
      groupId: group.groupId,
      name: displayName(state, hold.person) ?? '',
      until: holdEnd(state, hold),
      ended: hold.ended?.kind ?? (isCancelled(state, hold) ? 'stopped' : null),
    }));
  });
}
