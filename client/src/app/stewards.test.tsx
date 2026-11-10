import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DAY_MINUTES } from '../engine/rules';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { messages } from './messages';
import { motionFor } from './stewardLines';
import { MotionTitle, Named, SuspendedNote } from './stewards';
import { formatMinute } from './time';

describe('Named', () => {
  it('sets the name in <bdi> between the words around it', () => {
    const { container } = render(
      <p>
        <Named parts={messages.stewards.makeSteward(2)} name="Kim" />
      </p>,
    );
    expect(container).toHaveTextContent('Make Kim steward (seat 2)');
    expect(container.querySelector('bdi')).toHaveTextContent('Kim');
  });

  it('keeps punctuation right after the name, and needs no words after it', () => {
    const { container, rerender } = render(
      <p>
        <Named parts={messages.stewards.dialogTitle} name="Kim" />
      </p>,
    );
    expect(container.textContent).toBe('Suspend Kim?');
    rerender(
      <p>
        <Named parts={{ before: 'Hello' }} name="Kim" />
      </p>,
    );
    expect(container.textContent).toBe('Hello Kim');
  });
});

describe('motionFor and MotionTitle', () => {
  it('names an election’s nominee and a recall’s steward', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const state = log.state();
    const elect = motionFor(state, { seat: 1, member: authorOf('ben'), holder: authorOf('ana') });
    const recall = motionFor(state, { seat: 1, member: null, holder: authorOf('ana') });
    expect(elect).toEqual({ kind: 'elect', seat: 1, name: 'Ben' });
    expect(recall).toEqual({ kind: 'recall', seat: 1, name: 'Ana' });
    const { container, rerender } = render(<MotionTitle motion={elect} />);
    expect(container.textContent).toBe('Make Ben steward (seat 1)');
    rerender(<MotionTitle motion={recall} />);
    expect(container.textContent).toBe('Recall Ana as steward');
  });
});

describe('SuspendedNote', () => {
  it('tells the suspended person until when, and what they can still do', () => {
    const log = groupLog({ members: ['Kim'] });
    log.suspend('Ana', 'Kim', 'Threats.');
    const until = START_MINUTE + 7 * DAY_MINUTES;
    render(<SuspendedNote state={log.state()} me={authorOf('kim')} />);
    expect(screen.getByText(messages.stewards.youAreSuspended(formatMinute(until)))).toBeVisible();
  });

  it('shows nothing to anyone else, or once the suspension has ended', () => {
    const log = groupLog({ members: ['Kim'] });
    log.suspend('Ana', 'Kim');
    const until = START_MINUTE + 7 * DAY_MINUTES;
    const { container, rerender } = render(
      <SuspendedNote state={log.state()} me={authorOf('ana')} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<SuspendedNote state={log.state(until)} me={authorOf('kim')} />);
    expect(container).toBeEmptyDOMElement();
  });
});
