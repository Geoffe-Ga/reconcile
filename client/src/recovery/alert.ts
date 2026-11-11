/**
 * The person's side of a recovery (#118; ADR-0043 §2, ADR-0008, ADR-0075
 * §4): every device they still have hears of it, and any of them can stop it.
 *
 * - **Seeing it.** A contact's `recovery-alert` is sealed to the person's
 *   encryption key in the group where the contact holds their share, so any
 *   device holding that key opens it, a device restored from a backup file
 *   or linked included, and no other member's can. {@link recoveryAlerts}
 *   lists each one that opens here until its hold ends, 4,320 relay minutes
 *   after its receipt, and says whether this person has cancelled it.
 * - **Cancelling it.** {@link cancelRecovery} posts a `recovery-cancel` in
 *   each group with a pending alert, one per alert, naming the tag sealed in
 *   it. Only the person and that contact know the tag, so nobody else in the
 *   group can tell which alert, or which contact, a cancel answers. The
 *   contact's device stops on a cancel from the person's key alone
 *   (`holder.ts`), and the person's other devices read it as cancelled too.
 *
 * Opening a box costs an X25519 exchange, so each alert is opened once per
 * page and member, and only whether it opened and its tag are kept.
 */
import { openAlert } from '../crypto/recovery';
import { parseRecord, signEvent } from '../engine/event';
import type { GroupState, SealedAlert } from '../engine/fold';
import type { Group, Store } from '../store/db';
import { foldGroup } from '../store/expiry';
import type { Sync } from '../store/sync';
import { HOLD_MINUTES } from './holder';

/** One alert a device of the person's opened. */
export interface SeenAlert {
  /** The alert's event id. */
  readonly id: string;
  readonly groupId: string;
  /** The relay minute its hold ends, when the contact's device would send the share. */
  readonly completes: number;
  /** The tag sealed in it, which a cancel names. */
  readonly tag: string;
  /** Whether this person has cancelled it, sent or still queued. */
  readonly cancelled: boolean;
}

/** What Start and group home show: a recovery to cancel, or one cancelled, or nothing. */
export type AlertSummary =
  { readonly kind: 'pending'; readonly completes: number } | { readonly kind: 'cancelled' } | null;

/** What cancelling works with. */
export interface CancelServices {
  readonly store: Pick<Store, 'getGroup' | 'enqueueAll'>;
  readonly sync: Pick<Sync, 'syncOnce'>;
  /** The device clock in milliseconds. */
  readonly now: () => number;
}

/** The tag of each alert this page has tried, by member, group and event id, or null when it didn't open. */
const opened = new Map<string, string | null>();

/** The tag in `alert`, sealed to this device's membership of `group`, or null; tried once per page. */
function tagIn(group: Group, alert: SealedAlert, kxKey: Uint8Array): string | null {
  const key = `${group.me.author} ${group.groupId} ${alert.id}`;
  const known = opened.get(key);
  if (known !== undefined) return known;
  const place = { groupId: group.groupId, person: group.me.author, kxKey, box: alert.box };
  const tag = openAlert(place)?.tag ?? null;
  opened.set(key, tag);
  return tag;
}

/** The tags this member's cancels name in `group`: in the log, and still queued in the outbox. */
function cancelledTags(group: Group, state: GroupState): Set<string> {
  const me = group.me.author;
  const logged = state.recoveryCancels.filter(({ by }) => by === me).map(({ alert }) => alert);
  const queued = group.outbox.flatMap((bytes) => {
    const event = parseRecord(bytes)?.event;
    return event?.type === 'recovery-cancel' && event.author === me ? [event.body.alert] : [];
  });
  return new Set([...logged, ...queued]);
}

/** Whether `group` goes on for this device, so an alert there is one it can answer. */
function answerable(group: Group, state: GroupState): boolean {
  const present = state.members.some(({ author }) => author === group.me.author);
  return group.archived === undefined && group.leaving === undefined && present;
}

/**
 * What each group's alerts were last read from, by member and group: a key
 * of its log's length, seqs and receipts, its outbox and its state on this
 * device, and the alerts found. Every sync pass changes the store, most with
 * nothing new, so Start and every group home refold a group only once its
 * key moves.
 */
const lastRead = new Map<string, { readonly key: string; readonly alerts: SeenAlert[] }>();

/** What `group`'s alerts depend on, cheaply: no signature or fold is needed to compute it. */
function readKey(group: Group): string {
  const seqs = group.log.reduce((sum, record) => sum + record.seq, 0);
  const receipts = group.log.reduce((sum, record) => sum + record.received, 0);
  const outbox = group.outbox.reduce((sum, bytes) => sum + bytes.length, 0);
  const flags = `${String(group.archived !== undefined)} ${String(group.leaving !== undefined)}`;
  const counts = `${String(group.log.length)} ${String(group.outbox.length)} ${String(outbox)}`;
  return `${counts} ${String(seqs)} ${String(receipts)} ${flags}`;
}

/** The alerts in `group` that open for this device, ended or not: read again only when it changed. */
function alertsIn(group: Group): SeenAlert[] {
  const id = `${group.me.author} ${group.groupId}`;
  const key = readKey(group);
  const held = lastRead.get(id);
  if (held?.key === key) return held.alerts;
  const alerts = foldAlerts(group);
  lastRead.set(id, { key, alerts });
  return alerts;
}

/** The alerts in `group` that open for this device, ended or not, from its fold. */
function foldAlerts(group: Group): SeenAlert[] {
  const { kxKey } = group;
  if (kxKey === undefined) return [];
  const state = foldGroup(group);
  if (!answerable(group, state)) return [];
  const cancelled = cancelledTags(group, state);
  return state.recoveryAlerts.flatMap((alert) => {
    const tag = alert.by === group.me.author ? null : tagIn(group, alert, kxKey);
    if (tag === null) return [];
    const completes = alert.received + HOLD_MINUTES;
    return [
      { id: alert.id, groupId: group.groupId, completes, tag, cancelled: cancelled.has(tag) },
    ];
  });
}

/**
 * Every alert this device opens, group by group in the store's order, ended
 * or not: what a screen folds once per store change, then filters by the
 * clock with {@link stillRunning}.
 */
export function openedAlerts(groups: readonly Group[]): SeenAlert[] {
  return groups.flatMap(alertsIn);
}

/** The alerts whose hold hasn't ended by `relayNow(groupId)`, the relay's minute as this device estimates it there. */
export function stillRunning(
  alerts: readonly SeenAlert[],
  relayNow: (groupId: string) => number,
): SeenAlert[] {
  return alerts.filter(({ groupId, completes }) => relayNow(groupId) < completes);
}

/**
 * Every alert this device opens, group by group in the store's order, until
 * its hold ends by `relayNow(group)`, the relay's minute as this device
 * estimates it for that group.
 */
export function recoveryAlerts(
  groups: readonly Group[],
  relayNow: (group: Group) => number,
): SeenAlert[] {
  const byId = new Map(groups.map((group) => [group.groupId, group]));
  return stillRunning(openedAlerts(groups), (groupId) => {
    const group = byId.get(groupId);
    return group === undefined ? Infinity : relayNow(group);
  });
}

/**
 * What to show for `alerts`: the earliest a recovery could complete while
 * any is still to cancel, `cancelled` once every one is, or null for none.
 */
export function alertSummary(alerts: readonly SeenAlert[]): AlertSummary {
  if (alerts.length === 0) return null;
  const pending = alerts.filter(({ cancelled }) => !cancelled);
  if (pending.length === 0) return { kind: 'cancelled' };
  return { kind: 'pending', completes: Math.min(...pending.map(({ completes }) => completes)) };
}

/**
 * Cancel this recovery: one `recovery-cancel` per pending alert, naming its
 * tag, queued in its group, then a sync pass so they go. Alerts already
 * cancelled post nothing more.
 */
export async function cancelRecovery(
  services: CancelServices,
  alerts: readonly SeenAlert[],
): Promise<void> {
  const byGroup = new Map<string, string[]>();
  for (const { groupId, tag, cancelled } of alerts) {
    if (!cancelled) byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), tag]);
  }
  for (const [groupId, tags] of byGroup) {
    const group = await services.store.getGroup(groupId);
    if (group === undefined) continue;
    const records = tags.map(
      (alert) =>
        signEvent(group.signingKey, {
          type: 'recovery-cancel',
          group: groupId,
          ts: services.now(),
          body: { alert },
        }).record,
    );
    await services.store.enqueueAll(groupId, records);
  }
  await services.sync.syncOnce();
}
