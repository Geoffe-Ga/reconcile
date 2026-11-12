/**
 * A test's way to take entries out of a group's outbox as the sync loop does
 * once the relay has them (#343, #349): only through the pull that saves what
 * a pass read, here one that read nothing new and keeps the group's sync state.
 */
import type { Store } from '../store/db';
import { eventIdOf } from '../store/eventId';

/**
 * Drops `sent` from `groupId`'s outbox on `store`, in one pull that reads
 * nothing and leaves the group's relay minute, instance and last sync as they
 * are. The group must have synced once, so it has them.
 */
export async function relayTook(
  store: Store,
  groupId: string,
  sent: readonly Uint8Array[],
): Promise<void> {
  const group = await store.getGroup(groupId);
  const { relayNow = null, instance = null, lastSyncAt = null } = group ?? {};
  if (relayNow === null || instance === null || lastSyncAt === null) {
    throw new Error('Expected a group that has synced.');
  }
  await store.applyPull(groupId, { records: [], relayNow, instance, lastSyncAt, sent }, eventIdOf);
}
