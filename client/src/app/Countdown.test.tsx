import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Countdown } from './Countdown';
import { formatMinute, minuteIso } from './time';

const DEADLINE = 29_010_080;

function timeElement(container: HTMLElement): HTMLTimeElement {
  const time = container.querySelector('time');
  if (time === null) throw new Error('Expected a <time> element.');
  return time;
}

describe('Countdown', () => {
  it('counts down to the deadline, with the absolute date in a <time>', () => {
    const { container } = render(
      <Countdown deadline={DEADLINE} closedAt={null} now={DEADLINE - 10_080} />,
    );
    expect(container).toHaveTextContent(`Closes in 7 days${formatMinute(DEADLINE)}`);
    const time = timeElement(container);
    expect(time).toHaveAttribute('datetime', minuteIso(DEADLINE));
    expect(time).toHaveTextContent(formatMinute(DEADLINE));
  });

  it('reads the hours and minutes left near the end', () => {
    const { rerender } = render(
      <Countdown deadline={DEADLINE} closedAt={null} now={DEADLINE - 180} />,
    );
    expect(screen.getByText('Closes in 3 hours')).toBeVisible();
    rerender(<Countdown deadline={DEADLINE} closedAt={null} now={DEADLINE - 1} />);
    expect(screen.getByText('Closes in 1 minute')).toBeVisible();
  });

  it('says voting closed once the deadline has passed', () => {
    const { container } = render(<Countdown deadline={DEADLINE} closedAt={null} now={DEADLINE} />);
    expect(screen.getByText('Voting closed')).toBeVisible();
    expect(timeElement(container)).toHaveAttribute('datetime', minuteIso(DEADLINE));
  });

  it('shows when an early close happened, not the deadline', () => {
    const closedAt = DEADLINE - 5_000;
    const { container } = render(
      <Countdown deadline={DEADLINE} closedAt={closedAt} now={DEADLINE - 4_000} />,
    );
    expect(screen.getByText('Voting closed')).toBeVisible();
    expect(timeElement(container)).toHaveAttribute('datetime', minuteIso(closedAt));
    expect(timeElement(container)).toHaveTextContent(formatMinute(closedAt));
  });
});
