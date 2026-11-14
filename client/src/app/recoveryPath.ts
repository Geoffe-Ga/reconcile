/**
 * Whether this device's groups have a way back if its passkey ever stops
 * unlocking them (#389; ADR-0030's 2026-11-14 amendment). Keys are sealed
 * under a passkey only once one exists, since a passkey's PRF output can
 * change under an OS update or from another device, where no user-agent
 * check can see it (`platform/prfPolicy.ts` catches only the known cases).
 *
 * - **Recovery contacts** in force: a plan this device chose that isn't
 *   superseded and still has `t` contacts in shared groups (`recoveryStatus`,
 *   #109), or the backup key of contacts chosen on another of the person's
 *   devices, which its split names (#272). The relay backup they open is
 *   refreshed with every group the device takes on later.
 * - **A backup file**: every group a backup keeps (`backedUpGroups`: founded
 *   here, not leaving or read-only) is marked saved. The mark is set only
 *   when a file holding that group was saved through the share sheet or a
 *   download (`saveBackup`), or when the group came back from a file, so a
 *   file with every such group's keys left this device. What the device
 *   can't know is whether the person still has the file or remembers its
 *   passphrase. A group joined after the file has no mark, so the device
 *   asks again until a new file holds it.
 *
 * A device with no group a backup would keep has nothing to lose yet, and no
 * backup to make: `empty`.
 */
import type { Group, RecoveryPlan, RelayBackupState, Store } from '../store/db';
import { recoveryStatus } from '../store/recovery';
import { backedUpGroups } from '../store/snapshot';

/** The device's way back, if any: contacts, a backup file, none, or nothing to lose yet. */
export type RecoveryPath = 'contacts' | 'backup' | 'none' | 'empty';

/** What the way back is read from. */
export interface RecoveryFacts {
  readonly groups: readonly Group[];
  readonly plan: RecoveryPlan | undefined;
  readonly relayBackup: Pick<RelayBackupState, 'key' | 'split'> | undefined;
}

/** Whether recovery contacts can bring the groups back: a plan in force, or one chosen elsewhere (#272). */
function contactsInForce({ groups, plan, relayBackup }: RecoveryFacts): boolean {
  const status = recoveryStatus(plan, groups);
  if (status !== null) return !status.chooseAgain;
  return relayBackup?.split !== undefined;
}

/** The way back `facts` give, contacts first, since they keep up with every later group. */
export function recoveryPathOf(facts: RecoveryFacts): RecoveryPath {
  if (contactsInForce(facts)) return 'contacts';
  const kept = new Set(backedUpGroups(facts.groups).map(({ groupId }) => groupId));
  if (kept.size === 0) return 'empty';
  const saved = facts.groups.every(
    ({ groupId, backup }) => !kept.has(groupId) || backup === 'saved',
  );
  return saved ? 'backup' : 'none';
}

/** Whether `path` is a way back, so keys may be sealed under a passkey. */
export function hasRecoveryPath(path: RecoveryPath): boolean {
  return path === 'contacts' || path === 'backup';
}

/**
 * The way back the store's groups, plan and relay backup give now.
 *
 * @throws {VaultLocked} on a device whose keys are locked and not yet unlocked this session.
 */
export async function readRecoveryPath(
  store: Pick<Store, 'listGroups' | 'getRecoveryPlan' | 'getRelayBackup'>,
): Promise<RecoveryPath> {
  const [groups, plan, relayBackup] = await Promise.all([
    store.listGroups(),
    store.getRecoveryPlan(),
    store.getRelayBackup(),
  ]);
  return recoveryPathOf({ groups, plan, relayBackup });
}
