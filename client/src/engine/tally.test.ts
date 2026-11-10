import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Bar, DEFAULT_RULES } from './rules';
import { tally, tallyDetail, type TallyInput } from './tally';

const ORDINARY = DEFAULT_RULES.bars.ordinary;
const ENTRENCHED = DEFAULT_RULES.bars.entrenched;
const REMOVAL = DEFAULT_RULES.bars.removal;

/**
 * Tallies at the ordinary bar, M1-03's consent floor, and checks the outcome carries that bar.
 * Returns the outcome without it, so M1-03's expectations read as they did.
 */
function ordinary(input: Omit<TallyInput, 'bar'>) {
  const { bar, ...outcome } = tally({ ...input, bar: ORDINARY });
  expect(bar).toEqual(ORDINARY);
  return outcome;
}

/** Builds a list of `count` copies of `score`. */
function many(count: number, score: number): number[] {
  return Array.from({ length: count }, () => score);
}

describe('tally: the consent floor (ADR-0002)', () => {
  it('passes at an average of exactly 2.0', () => {
    const result = ordinary({ eligible: 3, versions: [{ id: 'v1', scores: [2, 2, 2] }] });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('fails just below an average of 2.0', () => {
    const result = ordinary({ eligible: 3, versions: [{ id: 'v1', scores: [2, 2, 1] }] });
    expect(result).toEqual({ kind: 'fail' });
  });

  it('fails at exactly 10% zeros', () => {
    const scores = [0, ...many(9, 4)];
    expect(ordinary({ eligible: 10, versions: [{ id: 'v1', scores }] })).toEqual({ kind: 'fail' });
  });

  it('passes just under 10% zeros', () => {
    const scores = [0, ...many(10, 4)];
    expect(ordinary({ eligible: 11, versions: [{ id: 'v1', scores }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
  });
});

describe('tally: the entrenched bar (ADR-0015 §2)', () => {
  /** Tallies one version at the entrenched bar. */
  function entrenched(eligible: number, scores: number[]) {
    return tally({ eligible, versions: [{ id: 'v1', scores }], bar: ENTRENCHED });
  }

  it('passes at an average of exactly 3.0', () => {
    expect(entrenched(4, [3, 3, 3, 3])).toEqual({ kind: 'pass', version: 'v1', bar: ENTRENCHED });
  });

  it('fails just below an average of 3.0', () => {
    // 59 / 20 = 2.95.
    expect(entrenched(20, [2, ...many(19, 3)])).toEqual({ kind: 'fail', bar: ENTRENCHED });
  });

  it('fails at exactly 5% zeros: one 0 among 20 scorers', () => {
    expect(entrenched(20, [0, ...many(19, 4)])).toEqual({ kind: 'fail', bar: ENTRENCHED });
  });

  it('passes just under 5% zeros: one 0 among 21 scorers (100 < 105)', () => {
    expect(entrenched(21, [0, ...many(20, 4)])).toEqual({
      kind: 'pass',
      version: 'v1',
      bar: ENTRENCHED,
    });
  });

  it('fails an average of exactly 2.5 that the ordinary bar passes', () => {
    const scores = [2, 3, 2, 3];
    expect(entrenched(4, scores)).toEqual({ kind: 'fail', bar: ENTRENCHED });
    expect(ordinary({ eligible: 4, versions: [{ id: 'v1', scores }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
  });

  it('lapses below quorum, whatever the scores', () => {
    expect(entrenched(10, [4, 4])).toEqual({ kind: 'lapse', bar: ENTRENCHED });
  });

  it('keeps quorum and the winner order: the best version that clears the bar wins', () => {
    // v1 averages 3.7 with one 0 in 15 (6.7%): it clears the ordinary bar, not the entrenched one.
    const versions = [
      { id: 'v1', scores: [0, ...many(14, 4)] },
      { id: 'v2', scores: many(15, 3) },
    ];
    expect(tally({ eligible: 15, versions, bar: ENTRENCHED })).toEqual({
      kind: 'pass',
      version: 'v2',
      bar: ENTRENCHED,
    });
    expect(ordinary({ eligible: 15, versions })).toEqual({ kind: 'pass', version: 'v1' });
  });
});

describe('tally: the bar it was given', () => {
  const custom: Bar = { avgAtLeast: 1, zerosUnderPercent: 50 };

  it('passes and fails at the bar it is given, not a fixed one', () => {
    // Average 1.5 with 2 zeros in 4 (50%): fails at under 50%; 1 zero in 3 (33%) passes.
    expect(
      tally({ eligible: 4, versions: [{ id: 'v1', scores: [0, 0, 3, 3] }], bar: custom }),
    ).toEqual({ kind: 'fail', bar: custom });
    expect(
      tally({ eligible: 3, versions: [{ id: 'v1', scores: [0, 1, 2] }], bar: custom }),
    ).toEqual({
      kind: 'pass',
      version: 'v1',
      bar: custom,
    });
  });

  it('carries the bar it used in a pass, a fail and a lapse', () => {
    for (const bar of [ORDINARY, ENTRENCHED, custom]) {
      expect(tally({ eligible: 3, versions: [{ id: 'v1', scores: [4, 4, 4] }], bar })).toEqual({
        kind: 'pass',
        version: 'v1',
        bar,
      });
      expect(tally({ eligible: 3, versions: [{ id: 'v1', scores: [0, 0, 0] }], bar })).toEqual({
        kind: 'fail',
        bar,
      });
      expect(tally({ eligible: 3, versions: [], bar })).toEqual({ kind: 'lapse', bar });
    }
  });
});

describe('tally: removal’s bar, where a single 0 never blocks (ADR-0075 §3, #115)', () => {
  /** The outcome kind of one version scored `scores` at removal’s bar, with everyone scoring. */
  function removal(scores: readonly number[]): string {
    return tally({ eligible: scores.length, versions: [{ id: 'v1', scores }], bar: REMOVAL }).kind;
  }

  it('passes at an average of exactly 3.0 and fails just under it', () => {
    expect(removal(many(100, 3))).toBe('pass');
    expect(removal([2, ...many(99, 3)])).toBe('fail');
    expect(removal([0, 4, 4, 4])).toBe('pass');
    expect(removal([0, 3, 4, 4])).toBe('fail');
  });

  it('passes with one 0 in 10, and fails with two', () => {
    expect(removal([0, ...many(9, 4)])).toBe('pass');
    expect(removal([0, 0, ...many(8, 4)])).toBe('fail');
  });

  it('passes 20 scorers with one 0, which the entrenched bar fails at exactly 5%', () => {
    const scores = [0, ...many(19, 4)];
    expect(removal(scores)).toBe('pass');
    const entrenched = tally({ eligible: 20, versions: [{ id: 'v1', scores }], bar: ENTRENCHED });
    expect(entrenched.kind).toBe('fail');
  });

  it('fails two 0s among 40 scorers (exactly 5%) and passes them among 41', () => {
    expect(removal([0, 0, ...many(38, 4)])).toBe('fail');
    expect(removal([0, 0, ...many(39, 4)])).toBe('pass');
  });

  it('still needs the average with one 0: one 0 and three 3s average 2.25', () => {
    expect(removal([0, 3, 3, 3])).toBe('fail');
  });

  it('flags the zeros met for one 0 at any share, and the average on its own', () => {
    const [version] = tallyDetail({
      eligible: 2,
      versions: [{ id: 'v1', scores: [0, 4] }],
      bar: REMOVAL,
    }).versions;
    expect(version).toMatchObject({ zeros: 1, zerosMet: true, averageMet: false, passes: false });
  });

  it('forgives no 0 at a bar that names no allowance, and before anyone scores', () => {
    const [none] = tallyDetail({
      eligible: 3,
      versions: [{ id: 'v1', scores: [] }],
      bar: REMOVAL,
    }).versions;
    expect(none).toMatchObject({ zerosMet: false, passes: false });
    const strict: Bar = { avgAtLeast: 0, zerosUnderPercent: 0 };
    expect(tally({ eligible: 1, versions: [{ id: 'v1', scores: [4] }], bar: strict }).kind).toBe(
      'fail',
    );
  });

  it('matches `sum ≥ 3·n` and (`zeros ≤ 1` or `20·zeros < n`) computed with real numbers', () => {
    const score = fc.integer({ min: 0, max: 4 });
    fc.assert(
      fc.property(fc.array(score, { minLength: 1, maxLength: 60 }), (scores) => {
        const n = scores.length;
        const sum = scores.reduce((total, s) => total + s, 0);
        const zeros = scores.filter((s) => s === 0).length;
        const passes = sum / n >= 3 && (zeros <= 1 || zeros / n < 0.05);
        expect(removal(scores)).toBe(passes ? 'pass' : 'fail');
      }),
    );
  });

  it('passes whatever the entrenched bar passes, so it is never harder', () => {
    const score = fc.integer({ min: 0, max: 4 });
    fc.assert(
      fc.property(fc.array(score, { minLength: 1, maxLength: 60 }), (scores) => {
        const input = { eligible: scores.length, versions: [{ id: 'v1', scores }] };
        if (tally({ ...input, bar: ENTRENCHED }).kind === 'pass')
          expect(removal(scores)).toBe('pass');
      }),
    );
  });
});

describe('tally: quorum per version (ADR-0073)', () => {
  it('lapses with no versions or no scorers', () => {
    expect(ordinary({ eligible: 4, versions: [] })).toEqual({ kind: 'lapse' });
    expect(ordinary({ eligible: 4, versions: [{ id: 'v1', scores: [] }] })).toEqual({
      kind: 'lapse',
    });
  });

  it('never counts a version nobody scored as at quorum, even with no one eligible', () => {
    expect(ordinary({ eligible: 0, versions: [{ id: 'v1', scores: [] }] })).toEqual({
      kind: 'lapse',
    });
  });

  it('needs every member of a group smaller than 3', () => {
    expect(ordinary({ eligible: 2, versions: [{ id: 'v1', scores: [4] }] })).toEqual({
      kind: 'lapse',
    });
    expect(ordinary({ eligible: 2, versions: [{ id: 'v1', scores: [2, 3] }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
    expect(ordinary({ eligible: 1, versions: [{ id: 'v1', scores: [3] }] })).toEqual({
      kind: 'pass',
      version: 'v1',
    });
  });

  it('needs 3 scorers in a group of 3 to 10', () => {
    expect(ordinary({ eligible: 3, versions: [{ id: 'v1', scores: [4, 4] }] })).toEqual({
      kind: 'lapse',
    });
    expect(ordinary({ eligible: 10, versions: [{ id: 'v1', scores: many(2, 4) }] })).toEqual({
      kind: 'lapse',
    });
    expect(ordinary({ eligible: 10, versions: [{ id: 'v1', scores: many(3, 4) }] })).toEqual({
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
      expect(ordinary({ eligible, versions: [{ id: 'v1', scores: many(lapses, 4) }] })).toEqual({
        kind: 'lapse',
      });
      expect(ordinary({ eligible, versions: [{ id: 'v1', scores: many(meets, 4) }] })).toEqual({
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
          const result = ordinary({ eligible, versions: [{ id: 'v1', scores: many(n, 4) }] });
          expect(result.kind).toBe(expected);
        },
      ),
    );
  });

  it('fails when a version at quorum fails and no other version is at quorum', () => {
    const result = ordinary({
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
    const result = ordinary({
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
    const result = ordinary({
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
    const result = ordinary({
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
    const result = ordinary({
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
    const result = ordinary({
      eligible: 11,
      versions: [
        { id: 'v1', scores: [0, ...many(10, 4)] },
        { id: 'v2', scores: many(11, 3) },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('keeps an earlier version with fewer zeros over a later one with the same average', () => {
    const result = ordinary({
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
    const result = ordinary({
      eligible: 36,
      versions: [
        { id: 'v2', scores: v2 },
        { id: 'v1', scores: v1 },
      ],
    });
    expect(result).toEqual({ kind: 'pass', version: 'v1' });
  });

  it('gives a three-way tie to the earliest version', () => {
    const result = ordinary({
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
    const result = ordinary({
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
        const result = ordinary({ eligible: n, versions: [{ id: 'v1', scores }] });
        expect(result.kind).toBe(passes ? 'pass' : 'fail');
      }),
    );
  });

  it('matches any whole-number bar computed with real numbers', () => {
    const bar = fc.record({
      avgAtLeast: fc.integer({ min: 0, max: 4 }),
      zerosUnderPercent: fc.integer({ min: 0, max: 100 }),
    });
    fc.assert(
      fc.property(fc.array(score, { minLength: 1, maxLength: 60 }), bar, (scores, given) => {
        const n = scores.length;
        const sum = scores.reduce((total, s) => total + s, 0);
        const zeros = scores.filter((s) => s === 0).length;
        const passes = sum / n >= given.avgAtLeast && (100 * zeros) / n < given.zerosUnderPercent;
        const result = tally({ eligible: n, versions: [{ id: 'v1', scores }], bar: given });
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
          const a = ordinary({ eligible, versions: [{ id: 'v1', scores }] });
          const b = ordinary({ eligible, versions: [{ id: 'v1', scores: shuffled }] });
          expect(b).toEqual(a);
        },
      ),
    );
  });
});

describe('tallyDetail: what the consent meter reads (#74)', () => {
  it('carries the bar it tallied at, beside the outcome that carries it too', () => {
    const detail = tallyDetail({ eligible: 3, versions: [], bar: ENTRENCHED });
    expect(detail.bar).toBe(ENTRENCHED);
    expect(detail.outcome).toEqual({ kind: 'lapse', bar: ENTRENCHED });
  });

  it('flags each condition at the bar it is given', () => {
    // An average of exactly 2.5 with no zeros meets the ordinary bar and misses the entrenched one.
    const input = { eligible: 4, versions: [{ id: 'v1', scores: [3, 2, 3, 2] }] };
    const [ordinaryVersion] = tallyDetail({ ...input, bar: ORDINARY }).versions;
    const [entrenchedVersion] = tallyDetail({ ...input, bar: ENTRENCHED }).versions;
    expect(ordinaryVersion).toMatchObject({ averageMet: true, zerosMet: true, passes: true });
    expect(entrenchedVersion).toMatchObject({ averageMet: false, zerosMet: true, passes: false });
    const zeros = { eligible: 20, versions: [{ id: 'v1', scores: [0, ...many(19, 4)] }] };
    expect(tallyDetail({ ...zeros, bar: ORDINARY }).versions[0]?.zerosMet).toBe(true);
    expect(tallyDetail({ ...zeros, bar: ENTRENCHED }).versions[0]?.zerosMet).toBe(false);
  });

  it('gives each version its scorers, sum, zeros and quorum, and its pass flags, in ballot order', () => {
    const detail = tallyDetail({
      bar: ORDINARY,
      eligible: 12,
      versions: [
        { id: 'v1', scores: [4, 4, 0, 3] },
        { id: 'v2', scores: [2, 1] },
      ],
    });
    expect(detail.versions).toEqual([
      {
        id: 'v1',
        scorers: 4,
        sum: 11,
        zeros: 1,
        quorum: 4,
        atQuorum: true,
        averageMet: true,
        zerosMet: false,
        passes: false,
      },
      {
        id: 'v2',
        scorers: 2,
        sum: 3,
        zeros: 0,
        quorum: 4,
        atQuorum: false,
        averageMet: false,
        zerosMet: true,
        passes: false,
      },
    ]);
    expect(detail.outcome).toEqual({ kind: 'fail', bar: ORDINARY });
  });

  it('meets the average at exactly 2.0 and misses the zeros at exactly 10%', () => {
    const [atTwo] = tallyDetail({
      bar: ORDINARY,
      eligible: 3,
      versions: [{ id: 'v1', scores: [2, 2, 2] }],
    }).versions;
    expect(atTwo).toMatchObject({ averageMet: true, zerosMet: true, passes: true });
    const [atTen] = tallyDetail({
      bar: ORDINARY,
      eligible: 10,
      versions: [{ id: 'v1', scores: [0, ...many(9, 4)] }],
    }).versions;
    expect(atTen).toMatchObject({ averageMet: true, zerosMet: false, passes: false });
  });

  it('meets neither condition before anyone has scored', () => {
    const [none] = tallyDetail({
      eligible: 5,
      versions: [{ id: 'v1', scores: [] }],
      bar: ORDINARY,
    }).versions;
    expect(none).toMatchObject({
      scorers: 0,
      sum: 0,
      zeros: 0,
      quorum: 3,
      atQuorum: false,
      averageMet: false,
      zerosMet: false,
      passes: false,
    });
  });

  it.each([
    { eligible: 0, quorum: 1 },
    { eligible: 1, quorum: 1 },
    { eligible: 2, quorum: 2 },
    { eligible: 3, quorum: 3 },
    { eligible: 10, quorum: 3 },
    { eligible: 11, quorum: 4 },
    { eligible: 15, quorum: 5 },
    { eligible: 30, quorum: 9 },
    { eligible: 31, quorum: 10 },
  ])('needs $quorum scorers at $eligible eligible', ({ eligible, quorum }) => {
    const [version] = tallyDetail({
      eligible,
      versions: [{ id: 'v1', scores: [] }],
      bar: ORDINARY,
    }).versions;
    expect(version?.quorum).toBe(quorum);
  });

  it('is at quorum exactly when its scorers reach the quorum it reports', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 120 }), (e, n) => {
        const [version] = tallyDetail({
          eligible: e,
          versions: [{ id: 'v1', scores: many(n, 4) }],
          bar: ORDINARY,
        }).versions;
        const needed = Math.max(1, Math.min(e, Math.max(3, Math.ceil((3 * e) / 10))));
        expect(version?.quorum).toBe(needed);
        expect(version?.atQuorum).toBe(n >= needed);
      }),
    );
  });

  it('gives tally()’s outcome, which passes exactly when a version passes all three', () => {
    const score = fc.integer({ min: 0, max: 4 });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.array(score, { maxLength: 30 }), { minLength: 1, maxLength: 3 }),
        (eligible, lists) => {
          const input = {
            eligible,
            versions: lists.map((scores, i) => ({ id: `v${String(i)}`, scores })),
            bar: ORDINARY,
          };
          const detail = tallyDetail(input);
          expect(detail.outcome).toEqual(tally(input));
          const anyPasses = detail.versions.some((version) => version.passes);
          expect(detail.outcome.kind === 'pass').toBe(anyPasses);
          for (const version of detail.versions) {
            const average = version.scorers > 0 ? version.sum / version.scorers : 0;
            expect(version.averageMet).toBe(version.scorers > 0 && average >= 2);
            expect(version.zerosMet).toBe(
              version.scorers > 0 && version.zeros / version.scorers < 0.1,
            );
            expect(version.passes).toBe(version.atQuorum && version.averageMet && version.zerosMet);
          }
        },
      ),
    );
  });
});
