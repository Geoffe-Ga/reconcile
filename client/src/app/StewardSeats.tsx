import { Link } from 'react-aria-components';

import { can, votingRightsCount } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { displayName } from '../engine/names';
import {
  electionsDue,
  mayProposeSteward,
  type Seat,
  seatAt,
  SEATS,
  type SeatNumber,
} from '../engine/stewards';
import { messages } from './messages';
import { routeHref } from './router';
import { formatMinute } from './time';

/** Props for {@link StewardSeats}. */
export interface StewardSeatsProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** Whether this device's leave waits for the relay (#77): then it offers no Proposal. */
  readonly leaving?: boolean;
}

/** "A steward election is due for seat N.", with Propose a steward for someone who may propose. */
function Due({
  state,
  seat,
  proposes,
}: {
  state: GroupState;
  seat: SeatNumber;
  proposes: boolean;
}) {
  const route = { name: 'steward', groupId: state.group ?? '', seat, recall: false } as const;
  return (
    <div className="due-note">
      <p>{messages.stewards.due(seat)}</p>
      {proposes ? (
        <Link
          className="button button-secondary"
          href={routeHref(route)}
          aria-label={messages.stewards.proposeFor(seat)}
        >
          {messages.stewards.propose}
        </Link>
      ) : null}
    </div>
  );
}

/** The line under a holder's name: the founder's hold, or when the term ends or ended. */
function termLine(state: GroupState, termEnd: number | null): string {
  const { stewards } = messages;
  if (termEnd === null) return stewards.founderHold;
  const date = formatMinute(termEnd);
  return state.at < termEnd ? stewards.termEnds(date) : stewards.termEnded(date);
}

/** An empty seat: "Empty", or for seat 2 below its size, when it opens. */
function emptyLine(state: GroupState, seat: SeatNumber): string {
  const { secondSeatAt } = state.rules.stewards;
  return seat === 2 && votingRightsCount(state) < secondSeatAt
    ? messages.stewards.secondSeat(secondSeatAt)
    : messages.stewards.empty;
}

/** One seat: who holds it and their term, with Propose recall when this member may propose one. */
function SeatRow({ state, me, seat, leaving }: StewardSeatsProps & { readonly seat: Seat }) {
  const { holder } = seat;
  const label = <span className="seat-label">{messages.stewards.seat(seat.seat)}</span>;
  if (holder === null) {
    return (
      <li className="seat">
        {label}
        <span className="seat-term">{emptyLine(state, seat.seat)}</span>
      </li>
    );
  }
  const name = displayName(state, holder) ?? '';
  const recall =
    leaving !== true && mayProposeSteward(state, me, { seat: seat.seat, member: null });
  const route = {
    name: 'steward',
    groupId: state.group ?? '',
    seat: seat.seat,
    recall: true,
  } as const;
  return (
    <li className="seat">
      {label}
      <bdi className="seat-holder">{name}</bdi>
      <span className="seat-term">{termLine(state, seat.termEnd)}</span>
      {recall ? (
        <Link
          className="button button-quiet"
          href={routeHref(route)}
          aria-label={messages.stewards.recallLabel(name)}
        >
          {messages.stewards.recall}
        </Link>
      ) : null}
    </li>
  );
}

/**
 * The Stewards section on Group home (ADR-0049, #102): the line for each seat
 * whose election is due, with Propose a steward; each seat with its holder
 * and term, with Propose recall; and what a steward can do. Every level sees
 * it; only someone who may propose, and isn't leaving, gets the links, and
 * only where the fold would accept the Proposal.
 */
export function StewardSeats({ state, me, leaving = false }: StewardSeatsProps) {
  const proposes = !leaving && can(state, me, 'propose');
  return (
    <div className="stack">
      {electionsDue(state).map((seat) => (
        <Due key={seat} state={state} seat={seat} proposes={proposes} />
      ))}
      <ul className="seats">
        {SEATS.map((seat) => (
          <SeatRow key={seat} state={state} me={me} seat={seatAt(state, seat)} leaving={leaving} />
        ))}
      </ul>
      <p className="caption">{messages.stewards.about(state.rules.suspensionDays)}</p>
    </div>
  );
}
