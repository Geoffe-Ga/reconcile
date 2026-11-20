/**
 * The wakes a device schedules for a group's open votes (#99, #284; ADR-0012,
 * ADR-0074 "closing soon").
 *
 * A new Proposal and an early close wake the group when they're sent
 * (`wake.ts`). The two moments no one sends anything for, a vote's last day
 * and its result at the deadline, are nudges: relay minutes a device asks the
 * relay, once, to wake the group's mailbox at: the mailbox of the week the
 * Proposal was received in (#110). For the group's own Proposals only the
 * proposer's device asks, so a group gets each nudge once. A coalition's
 * motion (#100) has no proposer in the group, so every device it is open to
 * asks (#284), and the relay keeps one nudge per mailbox and minute. Its
 * minutes shift by the group's own offset (`crypto/nudgeOffset.ts`), since
 * the motion has one deadline in every seated group, and unshifted nudges
 * would line their mailboxes up on the same minutes. A nudge for a vote that
 * then closes early still fires: one extra wake, carrying nothing, is fine
 * (cancelling it is deferred).
 *
 * A reconcile or coalition vote takes one more (#250; the founder's decision
 * of 2026-11-19): a reminder 3 days before it closes, since a group that
 * doesn't vote counts as not passing. Like every nudge it carries nothing
 * (ADR-0012): the wake reaches every device of the group alike, and only the
 * app, on a device whose member hasn't scored the vote, shows "If you don't
 * vote by <date>, you won't be counted." ({@link reminds}). It takes the same
 * shift as the vote's other nudges, a coalition motion's group offset (#284).
 */
import type { GroupState, Proposal } from './fold';
import { DAY_MINUTES } from './rules';

/** How long before a reconcile or coalition vote closes its reminder comes: 3 days (#250). */
export const REMINDER_MINUTES = 3 * DAY_MINUTES;

/** Whether `proposal` takes the reminder: a group's reconcile vote or a coalition's motion (#250). */
function takesReminder(proposal: Pick<Proposal, 'target'>): boolean {
  return proposal.target.kind === 'reconcile' || proposal.target.kind === 'motion';
}

/**
 * Whether the app reminds `me` of `proposal` at relay minute `now` (#250):
 * a reconcile or coalition vote still open, in whose eligible set they are
 * and which they haven't scored, from {@link REMINDER_MINUTES} before its
 * deadline until it.
 */
export function reminds(
  proposal: Pick<Proposal, 'target' | 'final' | 'deadline' | 'eligible' | 'ballots'>,
  me: string,
  now: number,
): boolean {
  if (!takesReminder(proposal) || proposal.final || !proposal.eligible.includes(me)) return false;
  if (proposal.ballots.some((ballot) => ballot.voter === me)) return false;
  return now >= proposal.deadline - REMINDER_MINUTES && now < proposal.deadline;
}

/**
 * One wake to schedule: a Proposal of mine, the relay minute it was received
 * in, whose week's mailbox the wake goes to (#110), and the relay minute to
 * wake its group at.
 */
export interface Nudge {
  readonly proposal: string;
  readonly opened: number;
  readonly minute: number;
}

/**
 * The whole minutes a group shifts its nudges for a coalition's motion by,
 * given the motion's id: HKDF of the group's secret (`crypto/nudgeOffset.ts`).
 */
export type NudgeOffsetOf = (motion: string) => number;

/**
 * Two nudges for each open vote `me`'s device schedules, in relay order: a
 * day before its deadline (closing soon) and at its deadline (its result,
 * when no ballot closes it early), with a reconcile or coalition vote's
 * reminder before them, 3 days before its deadline, when it opened before
 * then (#250). Those are `me`'s own open Proposals, and,
 * given the group's `offsetOf`, each open coalition motion `me` may vote on,
 * at those minutes plus the group's offset for it: both nudges take the same
 * offset, and a motion's final pass in its coalition, which no group's vote
 * settles, takes none (#284). None for anyone else's Proposal, or for one
 * that has closed, and none once the group has dissolved (#108): a Proposal
 * still open then never closes, and nothing more goes to the group's mailbox.
 */
export function nudgesFor(state: GroupState, me: string, offsetOf?: NudgeOffsetOf): Nudge[] {
  if (state.dissolved !== null) return [];
  return state.proposals
    .filter((p) => !p.final)
    .flatMap((p) => {
      const shift = shiftFor(p, me, offsetOf);
      if (shift === null) return [];
      const at = (before: number) => ({
        proposal: p.id,
        opened: p.received,
        minute: p.deadline - before + shift,
      });
      const reminder = takesReminder(p) && p.deadline - REMINDER_MINUTES > p.received;
      return [...(reminder ? [at(REMINDER_MINUTES)] : []), at(DAY_MINUTES), at(0)];
    });
}

/**
 * The minutes `me`'s device shifts its nudges for the open Proposal `p` by,
 * or null when it nudges none: 0 for `me`'s own; the group's offset for a
 * coalition's motion open to `me`, and null without one, so no device ever
 * nudges at a motion's own minutes.
 */
function shiftFor(p: Proposal, me: string, offsetOf: NudgeOffsetOf | undefined): number | null {
  if (p.target.kind === 'motion') {
    return offsetOf !== undefined && p.eligible.includes(me) ? offsetOf(p.id) : null;
  }
  return p.author === me ? 0 : null;
}

/** The name a device records a nudge under once it is posted: its Proposal and minute. */
export function nudgeKey(nudge: Pick<Nudge, 'proposal' | 'minute'>): string {
  return `${nudge.proposal}@${String(nudge.minute)}`;
}
