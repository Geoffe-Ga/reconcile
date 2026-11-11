/**
 * A removal on this device (#115; docs/spec/phase-1-spec.md §7, Removal;
 * ADR-0016, ADR-0049).
 *
 * After each pass that brought something new, the sync loop calls
 * {@link settleRemoval}. Once a `remove` naming this device's own member has
 * folded, the group becomes a read-only archive (`markArchived`, reason
 * `removed`): its outbox goes, and no request names its mailbox again. By
 * then the group's key is changing past this device (#98), so it couldn't
 * read anything new anyway; it keeps what it already has (ADR-0016). Its push
 * registration is forgotten first, as a leave's is (#99), so nothing posted to
 * the old mailbox wakes this phone. Until then, a device whose member may post
 * it, and that folds a removal's final pass with no `remove` yet, queues one;
 * the fold takes the first, and the key changes once.
 */
import { parseRecord, signEvent } from '../engine/event';
import { mayRemove, removalDue, removedFrom } from '../engine/removal';
import type { Group, Store } from './db';
import { foldGroup } from './expiry';

/** True when this member's own `remove` of `proposal` already waits in the outbox. */
function removeQueued(group: Group, proposal: string): boolean {
  return group.outbox.some((bytes) => {
    const event = parseRecord(bytes)?.event;
    return event?.type === 'remove' && event.body.proposal === proposal;
  });
}

/**
 * Settles a removal for one group after a pass (#115): archives it once a
 * `remove` naming this device's member has folded, calling `forget` with the
 * group first so its push registration goes (#99); or else, when a removal's
 * pass is final and waits for its `remove`, queues this member's, unless one
 * is queued already, the group is leaving, or the fold wouldn't take one from
 * this member (the one it removes, suspended, or not a member). `clock` is the
 * device clock in ms, for the event's `ts`. A read-only archive is left alone.
 */
export async function settleRemoval(
  store: Store,
  groupId: string,
  clock: () => number,
  forget: (group: Group) => void = () => undefined,
): Promise<void> {
  const group = await store.getGroup(groupId);
  if (group === undefined || group.archived !== undefined) return;
  // As the screens fold it: a removal whose ballots this device cleared keeps its pass (#111).
  const state = foldGroup(group);
  const me = group.me.author;
  if (removedFrom(state, me) !== undefined) {
    forget(group);
    await store.markArchived(groupId, 'removed');
    return;
  }
  const due = removalDue(state);
  if (due === null || group.leaving !== undefined || removeQueued(group, due)) return;
  if (!mayRemove(state, me, due)) return;
  const remove = signEvent(group.signingKey, {
    type: 'remove',
    group: groupId,
    ts: clock(),
    body: { proposal: due },
  });
  await store.enqueue(groupId, remove.record);
}
