import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tally } from './tally';

/** Builds a list of `count` copies of `score`. */
function many(count: number, score: number): number[] {
  return Array.from({ length: count }, () => score);
}

describe('tally: the consent floor (ADR-0002)', () => {
  it('passes at an average of exactly 2.0', () => {
    const result = tally({ eligible: 3, versions: [{ id: 'v1', scores: [2, 2, 2] }] });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('fails just below an average of 2.0', () => {
    const result = tally({ eligible: 3, versions: [{ id: 'v1', scores: [2, 2, 1] }] });
    expect(result).toEqual({ kind: 'fail' });
  });

  it('fails at exactly 10% zeros', () => {
    const scores = [0, ...many(9, 4)];
    expect(tally({ eligible: 10, versions: [{ id: 'v1', scores }] })).toEqual({ kind: 'fail' });
  });

  it('passes just under 10% zeros', () => {
    const scores = [0, ...many(10, 4)];
    expect(tally({ eligible: 11, versions: [{ id: 'v1', scores }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
  });
});

describe('tally: quorum per version (ADR-0073)', () => {
  it('lapses with no versions or no scorers', () => {
    expect(tally({ eligible: 4, versions: [] })).toEqual({ kind: 'lapse' });
    expect(tally({ eligible: 4, versions: [{ id: 'v1', scores: [] }] })).toEqual({
      kind: 'lapse',
    });
  });

  it('never counts a version nobody scored as at quorum, even with no one eligible', () => {
    expect(tally({ eligible: 0, versions: [{ id: 'v1', scores: [] }] })).toEqual({
      kind: 'lapse',
    });
  });

  it('needs every member of a group smaller than 3', () => {
    expect(tally({ eligible: 2, versions: [{ id: 'v1', scores: [4] }] })).toEqual({
      kind: 'lapse',
    });
    expect(tally({ eligible: 2, versions: [{ id: 'v1', scores: [2, 3] }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
    expect(tally({ eligible: 1, versions: [{ id: 'v1', scores: [3] }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
  });

  it('needs 3 scorers in a group of 3 to 10', () => {
    expect(tally({ eligible: 3, versions: [{ id: 'v1', scores: [4, 4] }] })).toEqual({
      kind: 'lapse',
    });
    expect(tally({ eligible: 10, versions: [{ id: 'v1', scores: many(2, 4) }] })).toEqual({
      kind: 'lapse',
    });
    expect(tally({ eligible: 10, versions: [{ id: 'v1', scores: many(3, 4) }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
  });

  it.each([
    { eligible: 11, lapses: 3, meets: 4 },
    { eligible: 15, lapses: 4, meets: 5 },
    { eligible: 30, lapses: 8, meets: 9 },
  ])(
    'needs 30% of $eligible eligible: $lapses lapse, $meets meet',
    ({ eligible, lapses, meets }) => {
      expect(tally({ eligible, versions: [{ id: 'v1', scores: many(lapses, 4) }] })).toEqual({
        kind: 'lapse',
      });
      expect(tally({ eligible, versions: [{ id: 'v1', scores: many(meets, 4) }] })).toEqual({
        kind: 'pass',
        version: 'v1',
      });
    },
  );

  it('matches min(eligible, max(3, ceil(0.3 x eligible))) for every group size', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 300 })
          .chain((eligible) =>
            fc.tuple(fc.constant(eligible), fc.integer({ min: 0, max: eligible })),
          ),
        ([eligible, n]) => {
          const needed = Math.min(eligible, Math.max(3, Math.ceil((3 * eligible) / 10)));
          const expected = n >= 1 && n >= needed ? 'pass' : 'lapse';
          const result = tally({ eligible, versions: [{ id: 'v1', scores: many(n, 4) }] });
          expect(result.kind).toBe(expected);
        },
      ),
    );
  });

  it('fails when a version at quorum fails and no other version is at quorum', () => {
    const result = tally({
      eligible: 10,
      versions: [
        { id: 'v1', scores: many(10, 1) },
        { id: 'late', scores: [4, 4] },
      ],
    });
    expect(result).toEqual({ kind: 'fail' });
  });
});

describe('tally: choosing among passing versions (ADR-0004)', () => {
  it('picks the higher average, compared without division', () => {
    const result = tally({
      eligible: 3,
      versions: [
        { id: 'v1', scores: [3, 3, 3] },
        { id: 'v2', scores: [4, 3, 4] },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v2' });
  });

  it('picks the higher average over the higher total', () => {
    // v1: 12 / 3 = 4.0; v2: 15 / 5 = 3.0.
    const result = tally({
      eligible: 5,
      versions: [
        { id: 'v1', scores: [4, 4, 4] },
        { id: 'v2', scores: [3, 3, 3, 3, 3] },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('compares averages that differ by less than one', () => {
    // v1: 7 / 3 = 2.33; v2: 12 / 5 = 2.4.
    const result = tally({
      eligible: 5,
      versions: [
        { id: 'v1', scores: [3, 2, 2] },
        { id: 'v2', scores: [3, 3, 2, 2, 2] },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v2' });
  });

  it('breaks an equal average by fewer zeros', () => {
    const withZero = [0, ...many(3, 4), ...many(16, 3)];
    const withoutZero = many(20, 3);
    const result = tally({
      eligible: 20,
      versions: [
        { id: 'v1', scores: withZero },
        { id: 'v2', scores: withoutZero },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v2' });
  });

  it('lets the higher average win even with more zeros: zeros only break ties', () => {
    // v1: 40 / 11 = 3.64 with one 0; v2: 33 / 11 = 3.0 with none.
    const result = tally({
      eligible: 11,
      versions: [
        { id: 'v1', scores: [0, ...many(10, 4)] },
        { id: 'v2', scores: many(11, 3) },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('keeps an earlier version with fewer zeros over a later one with the same average', () => {
    const result = tally({
      eligible: 20,
      versions: [
        { id: 'v1', scores: many(20, 3) },
        { id: 'v2', scores: [0, ...many(3, 4), ...many(16, 3)] },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('counts zeros, not their share, when breaking a tie', () => {
    // Both average 3.0. v1 has 1 zero in 11 (9.1%), v2 has 2 in 36 (5.6%).
    const v1 = [0, ...many(3, 4), ...many(7, 3)];
    const v2 = [0, 0, ...many(6, 4), ...many(28, 3)];
    const result = tally({
      eligible: 36,
      versions: [
        { id: 'v2', scores: v2 },
        { id: 'v1', scores: v1 },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('gives a three-way tie to the earliest version', () => {
    const result = tally({
      eligible: 3,
      versions: [
        { id: 'first', scores: [3, 2, 4] },
        { id: 'second', scores: [4, 3, 2] },
        { id: 'third', scores: [2, 4, 3] },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'first' });
  });

  it('never lets a version below quorum win', () => {
    const result = tally({
      eligible: 10,
      versions: [
        { id: 'v1', scores: many(10, 2) },
        { id: 'late', scores: [4, 4] },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });
});

describe('tally: properties', () => {
  const score = fc.integer({ min: 0, max: 4 });

  it('matches the consent floor computed with real numbers', () => {
    fc.assert(
      fc.property(fc.array(score, { minLength: 1, maxLength: 60 }), (scores) => {
        const n = scores.length;
        const sum = scores.reduce((total, s) => total + s, 0);
        const zeros = scores.filter((s) => s === 0).length;
        const passes = sum / n >= 2 && zeros / n < 0.1;
        const result = tally({ eligible: n, versions: [{ id: 'v1', scores }] });
        expect(result.kind).toBe(passes ? 'pass' : 'fail');
      }),
    );
  });

  it('does not depend on the order of a version’s scores', () => {
    fc.assert(
      fc.property(
        fc
          .array(score, { minLength: 1, maxLength: 30 })
          .chain((scores) =>
            fc.tuple(
              fc.constant(scores),
              fc.shuffledSubarray(scores, { minLength: scores.length }),
            ),
          ),
        fc.integer({ min: 1, max: 40 }),
        ([scores, shuffled], eligible) => {
          const a = tally({ eligible, versions: [{ id: 'v1', scores }] });
          const b = tally({ eligible, versions: [{ id: 'v1', scores: shuffled }] });
          expect(b).toEqual(a);
        },
      ),
    );
  });
});
