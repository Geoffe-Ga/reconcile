import { messages } from './messages';
import { formatMinute, minuteIso, timeLeft } from './time';

/** Props for {@link Countdown}. */
export interface CountdownProps {
  /** The Proposal's deadline, in relay minutes. */
  readonly deadline: number;
  /** The relay minute of an early close, or null. */
  readonly closedAt: number | null;
  /** The relay's minute now, as this device estimates it. */
  readonly now: number;
}

/**
 * How long a vote has left, then the absolute date in a `<time>` element:
 * "Closes in 7 days · Mon 16 Nov, 2:05 pm", or "Voting closed" with when it
 * closed. The dot between them is drawn by CSS and hidden from screen readers.
 */
export function Countdown({ deadline, closedAt, now }: CountdownProps) {
  const ended = closedAt ?? (now >= deadline ? deadline : null);
  const when = ended ?? deadline;
  return (
    <span className="countdown">
      <span>
        {ended === null
          ? messages.countdown.closes(timeLeft(deadline - now))
          : messages.countdown.closed}
      </span>
      <time dateTime={minuteIso(when)}>{formatMinute(when)}</time>
    </span>
  );
}
