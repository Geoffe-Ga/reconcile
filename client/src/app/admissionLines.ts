/**
 * A newcomer's way to a vote in words (#101; ADR-0014, ADR-0021): their
 * progress on the People list, and their own line on when their vote
 * arrives. The engine decides who holds rights and when
 * (src/engine/admission.ts); this file only words it, with dates in the
 * device's time zone. src/app/Newcomer.tsx sets these lines on screen.
 */
import { type Admission, admissionOf } from '../engine/admission';
import type { GroupState } from '../engine/fold';
import { formatDay } from './format';
import { messages } from './messages';
import { formatMinute } from './time';

/**
 * A newcomer's progress in a line, such as "New · 1 of 2 vouches · wait ends
 * Sun 22 Nov": their vouches so far, then when they can vote once they have
 * every vouch they need, or else when their wait ends, while it runs.
 */
export function progressLine(admission: Admission, at: number): string {
  const { admission: words } = messages;
  const { vouchedBy, needed, waitEnd, rightsAt } = admission;
  const parts = [words.newcomer, words.vouches(vouchedBy.length, needed)];
  if (rightsAt !== null) parts.push(words.canVoteFrom(formatDay(rightsAt)));
  else if (at < waitEnd) parts.push(words.waitEnds(formatDay(waitEnd)));
  return parts.join(` ${words.separator} `);
}

/**
 * The newcomer's own line, such as "You can vote on Proposals that open after
 * <date>, once 2 people vouch for you.", or null for anyone who holds rights.
 */
export function waitingLine(state: GroupState, me: string): string | null {
  const admission = admissionOf(state, me);
  if (admission === null) return null;
  const { admission: words } = messages;
  const { needed, waitEnd, rightsAt } = admission;
  if (rightsAt !== null) return words.voteAfter(formatMinute(rightsAt));
  return state.at < waitEnd
    ? words.voteAfterOnce(formatMinute(waitEnd), needed)
    : words.voteOnce(needed);
}
