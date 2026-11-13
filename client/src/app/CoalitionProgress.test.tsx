import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CoalitionProgress as Progress } from '../engine/coalitionProgress';
import { axeViolations } from '../test/axe';
import { CoalitionProgress, NameList, ProgressLine } from './CoalitionProgress';
import { formatDay } from './format';
import { messages } from './messages';

/** A motion's progress, three groups by default, nobody in yet. */
function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    seats: 3,
    passed: 0,
    failed: 0,
    needed: 3,
    deciding: ['Riverside Tenants', 'Oak St Co-op', 'Elm Row'],
    groups: [],
    final: false,
    settles: 30_000_000,
    ...overrides,
  };
}

/** The progress line's text for `value`. */
function lineFor(value: Progress): string {
  const { container } = render(<ProgressLine progress={value} />);
  return container.textContent;
}

beforeEach(() => {
  document.title = 'Banks too · Reconcile';
});

describe('CoalitionProgress, for a motion from further up (#122)', () => {
  it('reads each coalition on its way, nearest first, then the one whose motion it is', async () => {
    const near = progress({
      seats: 2,
      passed: 1,
      needed: 2,
      mine: 'pass',
      deciding: ['Oak St Co-op'],
    });
    const top = progress({ seats: 2, needed: 2, deciding: ['Eastside Housing', 'Elm Row'] });
    render(
      <CoalitionProgress
        progress={top}
        steps={[{ name: 'Eastside Housing', progress: near }]}
        top="Metro Renters"
      />,
    );
    const section = screen.getByRole('region', { name: messages.coalitions.progressTitle });
    expect(section).toHaveTextContent(
      'In Eastside HousingYour group passed this. Waiting for 1 more group.' +
        'In Metro Renters0 of 2 groups have passed. Waiting for Eastside Housing and Elm Row.' +
        messages.coalitions.nestedLine,
    );
    expect(section).not.toHaveTextContent(messages.coalitions.motionLine);
    expect(screen.getByText('Metro Renters').tagName).toBe('BDI');
    expect(await axeViolations()).toEqual([]);
  });

  it('reads one line, with what crosses group lines, for a coalition’s own motion', () => {
    render(<CoalitionProgress progress={progress()} />);
    const section = screen.getByRole('region', { name: messages.coalitions.progressTitle });
    expect(section).toHaveTextContent(messages.coalitions.motionLine);
    expect(section).not.toHaveTextContent('In ');
  });
});

describe('ProgressLine', () => {
  it('says how many of up to 4 groups passed, naming the groups still deciding', () => {
    expect(lineFor(progress({ passed: 2, deciding: ['Oak St Co-op'] }))).toBe(
      '2 of 3 groups have passed. Waiting for Oak St Co-op.',
    );
    expect(lineFor(progress({ passed: 1, deciding: ['Oak St Co-op', 'Elm Row'] }))).toContain(
      '1 of 3 groups has passed. Waiting for Oak St Co-op and Elm Row.',
    );
    expect(lineFor(progress())).toContain(
      '0 of 3 groups have passed. Waiting for Riverside Tenants, Oak St Co-op and Elm Row.',
    );
  });

  it('puts each group’s name in its own bdi', () => {
    render(<ProgressLine progress={progress({ passed: 1, deciding: ['אלון', 'Elm Row'] })} />);
    expect(screen.getByText('אלון').tagName).toBe('BDI');
    expect(screen.getByText('Elm Row').tagName).toBe('BDI');
  });

  it('reads two-thirds from 5 groups: what it needs, how many passed, and how many didn’t', () => {
    const five = progress({ seats: 5, needed: 4, deciding: ['Pine Row'] });
    expect(lineFor({ ...five, passed: 3, failed: 1 })).toBe('Needs 4 of 5 · 3 passed, 1 didn’t');
    expect(lineFor({ ...five, passed: 2 })).toBe('Needs 4 of 5 · 2 passed');
  });

  it('names every group a motion needs, at any size, when it needs them all (#114)', () => {
    const every = progress({ seats: 5, needed: 5, passed: 4, deciding: ['Pine Row'] });
    expect(lineFor(every)).toBe('4 of 5 groups have passed. Waiting for Pine Row.');
  });

  it('says what the viewer’s own group reported, and how many more passes it waits for', () => {
    expect(lineFor(progress({ passed: 2, mine: 'pass', deciding: ['Oak St Co-op'] }))).toBe(
      'Your group passed this. Waiting for 1 more group.',
    );
    const five = progress({ seats: 5, needed: 4, passed: 2, failed: 1, mine: 'fail' });
    expect(lineFor(five)).toBe('Your group didn’t pass this. Waiting for 2 more groups.');
  });

  it('gives the coalition’s outcome sentence once it has decided', () => {
    expect(lineFor(progress({ outcome: 'fail', failed: 1 }))).toBe(messages.coalitions.failedEvery);
    const five = progress({ seats: 5, needed: 4, failed: 2, outcome: 'fail', final: true });
    expect(lineFor(five)).toBe('Fewer than two-thirds of the groups passed.');
    expect(lineFor(progress({ passed: 3, outcome: 'pass', final: true }))).toBe(
      'The coalition passed this.',
    );
  });

  it('says on what day a pass takes effect, while results can still change it (#250)', () => {
    const settles = 29_400_000;
    render(<ProgressLine progress={progress({ passed: 3, outcome: 'pass', settles })} />);
    const day = screen.getByText(formatDay(settles));
    expect(day.tagName).toBe('TIME');
    expect(day.parentElement).toHaveTextContent(
      `The coalition passed this. It takes effect on ${formatDay(settles)}.`,
    );
  });

  it('never counts people: only groups', () => {
    const lines = [
      progress({ passed: 2, deciding: ['Oak St Co-op'] }),
      progress({ seats: 5, needed: 4, passed: 3, failed: 1 }),
      progress({ passed: 2, mine: 'pass' }),
    ].map(lineFor);
    for (const line of lines) expect(line).not.toMatch(/\b(people|person|scored|vote[sd]?)\b/i);
  });
});

describe('ProgressLine’s room on a vote’s page (#407)', () => {
  const groups = ['Riverside Tenants', 'Oak St Co-op', 'Elm Row'].map((name) => ({
    name,
    result: null,
  }));

  /** The line `value` shows on a vote's page, and the room it keeps. */
  function roomFor(value: Progress) {
    const { container } = render(<ProgressLine progress={value} />);
    const line = container.querySelector('.coalition-progress-line');
    return { text: line?.textContent, room: line?.getAttribute('data-room'), line };
  }

  it('keeps the line every group still waiting takes, so one fewer moves nothing below it', () => {
    const later = roomFor(progress({ passed: 1, deciding: ['Oak St Co-op', 'Elm Row'], groups }));
    expect(later.text).toBe('1 of 3 groups has passed. Waiting for Oak St Co-op and Elm Row.');
    expect(later.room).toBe(
      '0 of 3 groups have passed. Waiting for Riverside Tenants, Oak St Co-op and Elm Row.',
    );
    expect(later.line).toHaveClass('steady');
  });

  it('keeps the longest a two-thirds motion can say: its own group’s fail, at 5 groups', () => {
    const five = progress({ seats: 5, needed: 4, passed: 1, deciding: ['Pine Row'], groups });
    expect(roomFor(five).room).toBe('Your group didn’t pass this. Waiting for 4 more groups.');
  });

  it('keeps a pass’s day until it is final, and an outcome’s own sentence', () => {
    const day = formatDay(30_000_000);
    expect(roomFor(progress({ outcome: 'pass', passed: 3, groups })).room).toBe(
      `${messages.coalitions.takesEffect} ${day}.`,
    );
    const fail = progress({ outcome: 'fail', failed: 1, groups });
    expect(roomFor(fail).room).toBe(messages.coalitions.failedEvery);
  });

  it('keeps no room inline, in a card’s link', () => {
    const { container } = render(<ProgressLine progress={progress({ groups })} inline />);
    expect(container.querySelector('[data-room]')).toBeNull();
  });
});

describe('NameList', () => {
  it('joins one, two and three names', () => {
    const joined = (names: string[]) => render(<NameList names={names} />).container.textContent;
    expect(joined(['A'])).toBe('A');
    expect(joined(['A', 'B'])).toBe('A and B');
    expect(joined(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('CoalitionProgress', () => {
  it('heads the line “Across the coalition”, says what crosses, and passes axe', async () => {
    render(
      <main>
        <h1>Banks too</h1>
        <CoalitionProgress progress={progress({ passed: 2, deciding: ['Oak St Co-op'] })} />
      </main>,
    );
    const block = screen.getByRole('region', { name: 'Across the coalition' });
    expect(block).toHaveTextContent('2 of 3 groups have passed. Waiting for Oak St Co-op.');
    expect(block).toHaveTextContent(messages.coalitions.motionLine);
    expect(await axeViolations()).toEqual([]);
  });
});
