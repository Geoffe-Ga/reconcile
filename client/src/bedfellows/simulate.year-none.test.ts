/**
 * A year of the stretch for readers who mark nothing (#481; ADR-0080 §8),
 * over the whole corpus with the stand-in models, seed 1. It asserts what is
 * true of the stand-ins and says where it isn't what #481 hoped: a reader's
 * candidate set on the corpus shelf is small and nearly all middle or
 * strange, so a weekly view of 10 shows most of it from the first week, and
 * the dial has little to stretch (ADR-0080 §4's and §6's amendments). The
 * founder's bar is met by the real model over ten seeds (§8); this holds the
 * stand-ins' one seed to it as well.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { corpusYear, FIRST_MONTH, LAST_QUARTER, must, weeksMean } from '../test/simulatedYear';
import { loadCorpus } from './corpus';
import type { WeekReport } from './simulate';

describe('a year with the stand-in models over the corpus: a reader who marks nothing (#481)', () => {
  let year: WeekReport[] = [];

  beforeAll(async () => {
    year = await corpusYear(loadCorpus(), 'none');
  }, 180_000);

  it('meets more groups and subjects as the year goes on', () => {
    expect(must(year.at(-1)).groupsSoFar).toBeGreaterThan(must(year[0]).groupsSoFar);
    expect(must(year.at(-1)).subjectsSoFar).toBeGreaterThan(must(year[0]).subjectsSoFar);
  });

  it('fails #481’s example, as the PR reports: the week’s view doesn’t widen and hostility doesn’t fall', () => {
    // The example expects week 52 to show more groups than week 1, and no
    // greater a hostile share. Neither holds: a view of 10 holds most of a
    // reader's candidate set from the first week, and the stretch moves it
    // from middle toward strange entries, where the hostile ones mostly sit.
    const [first, last] = [must(year[0]), must(year.at(-1))];

    expect(last.distinctGroups).toBeLessThanOrEqual(first.distinctGroups);
    expect(last.topGroupShare).toBeGreaterThanOrEqual(first.topGroupShare);
    expect(last.hostileShare).toBeGreaterThan(first.hostileShare);
  });

  it('verifies nothing, as the stand-in judge never agrees: precision has nothing to judge', () => {
    expect(year.every((w) => w.verified === 0 && w.verifiedPrecision === null)).toBe(true);
  });

  it('keeps the hostile share between 4% and 7% every week, with the check off', () => {
    expect(year.every((w) => w.hostileShare >= 0.04 && w.hostileShare <= 0.07)).toBe(true);
  });

  it('keeps the hostile share flat by the founder’s bar: the last quarter within 0.5 points of weeks 1 to 4', () => {
    // The founder's bar (2026-11-19) is set on the real model's ten-seed
    // means (ADR-0080 §8); the stand-ins' one seed: 5.60% and 5.70%.
    const firstMonth = weeksMean(year, 'hostileShare', ...FIRST_MONTH);
    const lastQuarter = weeksMean(year, 'hostileShare', ...LAST_QUARTER);

    expect(firstMonth).toBeCloseTo(0.056047, 5);
    expect(lastQuarter).toBeCloseTo(0.056955, 5);
    expect(Math.abs(lastQuarter - firstMonth)).toBeLessThanOrEqual(0.005);
  });
});
