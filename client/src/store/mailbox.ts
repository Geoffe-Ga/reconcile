/**
 * Where a group's blobs, push registrations and nudges go (#99): the one
 * seam for a group's mailbox at a relay minute, and the weeks a sync pass
 * reads (#110).
 *
 * Mailboxes rotate weekly (#110; ADR-0019, ADR-0074): a group's mailbox at a
 * relay minute is its current secret's id for that minute's week
 * (`crypto/groupKeys.ts`), so the relay sees an unrelated id each week. Push
 * registers every mailbox {@link mailboxAt} gives over the next 30 days, so a
 * closed phone still wakes after the week turns, and each nudge goes to the
 * mailbox of the week its Proposal was received in (./push.ts).
 *
 * A sync pass reads this week's mailbox and last week's, so a record that
 * reached last week's just as the week turned is still read; a device whose
 * last sync fell in an earlier week reads each week since, once, back to the
 * last {@link CATCH_UP_WEEKS}. The relay keeps a blob 30 days (ADR-0057), so
 * nothing older is left to read. Weeks come from the relay's minutes only.
 */
import { deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { DAY_MINUTES } from '../engine/rules';
import type { Group } from './db';

/** The mailbox of `group` at relay minute `minute`. */
export type MailboxAt = (group: Pick<Group, 'secret'>, minute: number) => string;

/** How far ahead a push registration reaches, in days: the relay keeps one 30 (#89). */
export const REGISTER_DAYS = 30;

/**
 * The most weeks a pass reads, this one included, and the weeks whose
 * cursors a group keeps: a blob lives 30 days (ADR-0057), which 5 weeks cover.
 */
export const CATCH_UP_WEEKS = 5;

/** The group's mailbox at a relay minute: its current secret's id for the minute's week (#110). */
export const mailboxAt: MailboxAt = (group, minute) =>
  deriveWeekMailboxId(group.secret, weekOf(minute));

/**
 * Every mailbox `at` gives `group` from relay minute `minute` to
 * {@link REGISTER_DAYS} days on, asked once a day, each named once, in order.
 */
export function mailboxesFrom(
  group: Pick<Group, 'secret'>,
  minute: number,
  at: MailboxAt = mailboxAt,
): string[] {
  const days = Array.from({ length: REGISTER_DAYS + 1 }, (_, day) => minute + day * DAY_MINUTES);
  return [...new Set(days.map((day) => at(group, day)))];
}

/** The weeks from `from` to `to`, ascending. */
function weeksBetween(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, n) => from + n);
}

/** The earliest week whose mailbox a pass in week `week` may read, or keep a cursor for. */
function oldest(week: number): number {
  return Math.max(week - CATCH_UP_WEEKS + 1, 0);
}

/**
 * The weeks a pass in relay week `week` reads, ascending: last week and this
 * one, and when the device last synced (`last`, the week of its last relay
 * minute) before last week, each week since then, back to the last
 * {@link CATCH_UP_WEEKS}. A device that has never synced, or whose last sync
 * is later than the relay's week, reads last week and this one.
 */
export function pollWeeks(last: number | null, week: number): number[] {
  const since = last === null ? week - 1 : Math.min(last, week - 1);
  return weeksBetween(Math.max(since, oldest(week)), week);
}

/** The weeks whose cursors a group keeps in relay week `week`: the last {@link CATCH_UP_WEEKS}. */
export function keptWeeks(week: number): number[] {
  return weeksBetween(oldest(week), week);
}
