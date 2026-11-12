/**
 * Stewards and suspensions in words (#102; ADR-0016, ADR-0049): what a
 * steward ballot decides, and the suspended person's own line. The engine
 * decides who holds a seat and who is suspended (src/engine/stewards.ts);
 * this file only words it. src/app/stewards.tsx sets these lines on screen.
 */
import type { GroupState } from '../engine/fold';
import { displayName } from '../engine/names';
import { activeSuspension, type SeatNumber, type Suspension } from '../engine/stewards';
import { messages } from './messages';
import { formatMinute } from './time';

/** What a steward ballot decides: electing someone to a seat, or recalling its steward. */
export interface Motion {
  readonly kind: 'elect' | 'recall';
  readonly seat: SeatNumber;
  /** The nominee's name, or the name of the steward a recall would remove. */
  readonly name: string;
}

/** The motion for a steward change: its nominee, or for a recall (no nominee) the seat's steward. */
export function motionFor(
  state: Pick<GroupState, 'members' | 'former'>,
  change: {
    readonly seat: SeatNumber;
    readonly member: string | null;
    readonly holder: string | null;
  },
): Motion {
  const person = change.member ?? change.holder ?? '';
  const name = displayName(state, person) ?? '';
  return { kind: change.member === null ? 'recall' : 'elect', seat: change.seat, name };
}

/**
 * "A steward suspended you until <date>. …" while `me`'s suspension runs, else
 * null. A removal vote that extends it (ADR-0059, #115) is named: it ends
 * when that vote closes, at the latest on the date shown.
 */
export function suspendedLine(state: GroupState, me: string): string | null {
  const suspension = activeSuspension(state, me);
  if (suspension === undefined) return null;
  const until = formatMinute(suspension.until);
  const { stewards } = messages;
  return suspension.removal === null
    ? stewards.youAreSuspended(until)
    : stewards.youAreSuspendedUntilVote(until);
}

/** "Suspended until <date>." on a person's row, naming a removal vote that extends it (ADR-0059). */
export function suspensionRowLine(suspension: Pick<Suspension, 'until' | 'removal'>): string {
  const until = formatMinute(suspension.until);
  const { stewards } = messages;
  return suspension.removal === null
    ? stewards.suspendedUntil(until)
    : stewards.suspendedUntilVote(until);
}
