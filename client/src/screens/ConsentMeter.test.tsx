import { cleanup, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { type Bar, DEFAULT_RULES } from '../engine/rules';
import { tally, tallyDetail } from '../engine/tally';
import { axeViolations } from '../test/axe';
import { ConsentMeter } from './ConsentMeter';

afterEach(cleanup);

document.title = 'Proposal · Reconcile';

const { ordinary: ORDINARY, entrenched: ENTRENCHED } = DEFAULT_RULES.bars;

/** The meter for one version scored `scores` among `eligible`, as the engine tallies it at `bar`. */
function meterFor(scores: readonly number[], eligible: number, bar: Bar = ORDINARY) {
  const detail = tallyDetail({ eligible, versions: [{ id: 'v1', scores }], bar });
  const [version] = detail.versions;
  if (version === undefined) throw new Error('Expected a version.');
  const view = render(
    <main>
      <h1>Proposal</h1>
      <ConsentMeter number={1} tally={version} bar={detail.bar} eligible={eligible} />
    </main>,
  );
  const group = screen.getByRole('group', { name: 'How version 1 stands so far' });
  return { detail, version, group, unmount: view.unmount };
}

const meters = (group: HTMLElement) => within(group).getAllByRole('meter');

function many(count: number, score: number): number[] {
  return Array.from({ length: count }, () => score);
}

describe('ConsentMeter', () => {
  it('shows two bars, each named for its line and read in words, and a quorum line', async () => {
    const { group } = meterFor([4, 3, 3, 0, 2], 12);
    const [average, zeros] = meters(group);
    expect(average).toHaveAccessibleName('Average · needs 2.0');
    expect(average).toHaveAttribute('aria-valuetext', '2.4 · Passes');
    expect(zeros).toHaveAccessibleName('Zeros · under 10%');
    expect(zeros).toHaveAttribute('aria-valuetext', '20% · Too many zeros: 1 of 5');
    expect(group).toHaveTextContent('2.4 · Passes');
    expect(group).toHaveTextContent('20% · Too many zeros: 1 of 5');
    expect(group).toHaveTextContent('Scored by 5 · needs 4');
    expect(await axeViolations()).toEqual([]);
  });

  it('reads an exact average of 1.96 as 1.9 and short by 0.1, never 2.0', () => {
    const scores = [...many(24, 2), 1];
    const { group } = meterFor(scores, 25);
    const [average] = meters(group);
    expect(average).toHaveAttribute('aria-valuetext', '1.9 · Short by 0.1');
    expect(group).toHaveTextContent('1.9 · Short by 0.1');
    expect(group).not.toHaveTextContent('2.0 ·');
  });

  it('says so before anyone has scored, with both lines still drawn', () => {
    const { group } = meterFor([], 6);
    const [average, zeros] = meters(group);
    expect(average).toHaveAttribute('aria-valuetext', 'No scores yet');
    expect(zeros).toHaveAttribute('aria-valuetext', 'No scores yet');
    // On screen it says so once, under the bars, rather than three times over.
    expect(group.textContent).toBe('So farAverage · needs 2.0Zeros · under 10%No scores yet');
    expect(group.querySelectorAll('.meter-line')).toHaveLength(2);
  });

  it('keeps each reading’s widest room in its bar’s head, before and after the first score (#407)', () => {
    const rooms = (group: HTMLElement) =>
      Array.from(group.querySelectorAll('.meter-reading')).map((reading) => [
        reading.textContent,
        reading.getAttribute('data-room'),
      ]);
    const before = meterFor([], 4);
    expect(rooms(before.group)).toEqual([
      ['', '0.0 · Short by 2.0'],
      ['', '100% · Too many zeros: 4 of 4'],
    ]);
    before.unmount();
    const after = meterFor([4, 0], 4, ENTRENCHED);
    expect(rooms(after.group)).toEqual([
      ['2.0 · Short by 1.0', '0.0 · Short by 3.0'],
      ['50% · Too many zeros: 1 of 2', '100% · Too many zeros: 4 of 4'],
    ]);
  });

  it('keeps the zeros reading’s room for everyone the ballot counts, so 99 scorers or 100 take the same (#417)', () => {
    const zeroRoom = (scorers: number) => {
      const meter = meterFor([0, ...many(scorers - 1, 4)], 120);
      const [, zeros] = Array.from(meter.group.querySelectorAll('.meter-reading'));
      const room = zeros?.getAttribute('data-room');
      meter.unmount();
      return room;
    };
    expect([zeroRoom(99), zeroRoom(100)]).toEqual([
      '100% · Too many zeros: 120 of 120',
      '100% · Too many zeros: 120 of 120',
    ]);
  });

  it('draws the lines and fills from the engine’s bar, as CSSOM styles', () => {
    const { group } = meterFor([4, 4, 2, 2], 4);
    const [average, zeros] = Array.from(group.querySelectorAll<HTMLElement>('.meter-track'));
    expect(average?.querySelector<HTMLElement>('.meter-line')?.style.left).toBe('50%');
    expect(average?.querySelector<HTMLElement>('.meter-fill')?.style.width).toBe('75%');
    expect(zeros?.querySelector<HTMLElement>('.meter-line')?.style.left).toBe('10%');
    expect(zeros?.querySelector<HTMLElement>('.meter-fill')?.style.width).toBe('0%');
  });

  it('draws an entrenched Proposal’s own lines: 3.0, and under 5% zeros (#94)', () => {
    const { group } = meterFor([0, ...many(19, 4)], 20, ENTRENCHED);
    const [average, zeros] = meters(group);
    expect(average).toHaveAccessibleName('Average · needs 3.0');
    expect(average).toHaveAttribute('aria-valuetext', '3.8 · Passes');
    expect(zeros).toHaveAccessibleName('Zeros · under 5%');
    expect(zeros).toHaveAttribute('aria-valuetext', '5% · Too many zeros: 1 of 20');
    expect(group).toHaveTextContent('Too many zeros: 1 of 20');
    const [averageTrack, zeroTrack] = Array.from(
      group.querySelectorAll<HTMLElement>('.meter-track'),
    );
    expect(averageTrack?.querySelector<HTMLElement>('.meter-line')?.style.left).toBe('75%');
    expect(zeroTrack?.querySelector<HTMLElement>('.meter-line')?.style.left).toBe('5%');
  });

  it('says how far short an entrenched version falls of its own line', () => {
    const { group } = meterFor([3, 3, 2, 2], 4, ENTRENCHED);
    const [average] = meters(group);
    expect(average).toHaveAttribute('aria-valuetext', '2.5 · Short by 0.5');
  });

  // Each run renders the meter, so give fast-check room on a busy machine, as properties.test.ts does.
  it('agrees with tally() for any ballots, in words alone', { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 40 }),
        (eligible, scores) => {
          const { version, group, unmount } = meterFor(scores, eligible);
          // Only the words: no class, color or width is read here.
          const [average, zeros] = meters(group).map(
            (meter) => meter.getAttribute('aria-valuetext') ?? '',
          );
          const text = group.textContent;
          const n = scores.length;
          const sum = scores.reduce((total, score) => total + score, 0);
          const outcome = tally({ eligible, versions: [{ id: 'v1', scores }], bar: ORDINARY });
          const reads = {
            average: average?.endsWith('Passes') ?? false,
            zeros: zeros?.endsWith('Passes') ?? false,
            quorum: n >= version.quorum,
          };
          expect(reads.average).toBe(version.averageMet);
          expect(reads.zeros).toBe(version.zerosMet);
          expect(reads.average && reads.zeros && reads.quorum).toBe(outcome.kind === 'pass');
          if (n === 0) {
            expect(text).toContain('No scores yet');
          } else {
            const shown = Number(average?.split(' · ')[0]);
            expect(shown >= 2).toBe(sum >= 2 * n);
            expect(text).toContain(`Scored by ${String(n)} · needs ${String(version.quorum)}`);
          }
          unmount();
        },
      ),
      { numRuns: 60 },
    );
  });
});
