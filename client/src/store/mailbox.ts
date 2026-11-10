/**
 * Where a group's blobs, push registrations and nudges go (#99): the one
 * seam for a group's mailbox at a relay minute.
 *
 * Today a group has one mailbox, derived from its secret (spec §3, M2-02).
 * #110 makes mailboxes weekly by changing only {@link mailboxAt}: push
 * registers every mailbox it gives over the next 30 days, so a closed phone
 * still wakes after the week turns, and each nudge goes to the mailbox of
 * its own minute.
 */
import { deriveMailboxId } from '../crypto/groupKeys';
import { DAY_MINUTES } from '../engine/rules';
import type { Group } from './db';

/** The mailbox of `group` at relay minute `minute`. */
export type MailboxAt = (group: Pick<Group, 'secret'>, minute: number) => string;

/** How far ahead a push registration reaches, in days: the relay keeps one 30 (#89). */
export const REGISTER_DAYS = 30;

/** The group's mailbox at a relay minute: today its one mailbox, whatever the minute. */
export const mailboxAt: MailboxAt = (group) => deriveMailboxId(group.secret);

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
