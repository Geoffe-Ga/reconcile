/**
 * A year of the stretch for readers who mark every strange entry Too far
 * (#481; ADR-0080 §8), over the whole corpus with the stand-in models, seed
 * 1. The entries such a reader marks leave the rows, not the run (§5), and
 * leave their views short until the 30-day history lets the marks lapse.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { corpusYear, FIRST_MONTH, LAST_QUARTER, must, weeksMean } from '../test/simulatedYear';
import { loadCorpus } from './corpus';
import { TOP } from './mix';
import { simulate, type WeekReport } from './simulate';
import { claimsIn, splitClaims } from './split';
import { standInEmbedder, standInJudge } from './standIns';

describe('a year with the stand-in models over the corpus: a reader who marks Too far (#481)', () => {
  let year: WeekReport[] = [];

  beforeAll(async () => {
    year = await corpusYear(loadCorpus(), 'too-far');
  }, 180_000);

  it('meets more groups and subjects as the year goes on', () => {
    expect(must(year.at(-1)).groupsSoFar).toBeGreaterThan(must(year[0]).groupsSoFar);
    expect(must(year.at(-1)).subjectsSoFar).toBeGreaterThan(must(year[0]).subjectsSoFar);
  });

  it('verifies nothing, as the stand-in judge never agrees: precision has nothing to judge', () => {
    expect(year.every((w) => w.verified === 0 && w.verifiedPrecision === null)).toBe(true);
  });

  it('keeps the hostile share between 2% and 6% every week, with the check off', () => {
    // Lower than the reader who marks nothing, and lower in the weeks a view
    // is short: a left-out strange entry is often a hostile one.
    expect(year.every((w) => w.hostileShare >= 0.02 && w.hostileShare <= 0.06)).toBe(true);
  });

  it('raises the hostile share from the first quarter to the last (a finding for the founder)', () => {
    expect(weeksMean(year, 'hostileShare', 40, 52)).toBeGreaterThan(
      weeksMean(year, 'hostileShare', 1, 13),
    );
  });

  it('keeps the hostile share flat by the founder’s bar: the last quarter within 0.5 points of weeks 1 to 4', () => {
    // The founder's bar (2026-11-19) is set on the real model's ten-seed
    // means (ADR-0080 §8); the stand-ins' one seed: 4.49% and 4.91%.
    const firstMonth = weeksMean(year, 'hostileShare', ...FIRST_MONTH);
    const lastQuarter = weeksMean(year, 'hostileShare', ...LAST_QUARTER);

    expect(firstMonth).toBeCloseTo(0.044928, 5);
    expect(lastQuarter).toBeCloseTo(0.049083, 5);
    expect(Math.abs(lastQuarter - firstMonth)).toBeLessThanOrEqual(0.005);
  });

  it('lets the reader reach the top by the last quarter, with one nudge a view (#480)', () => {
    // Before #480 nudged at most once a view, each Too far mark stepped the
    // dial in, and this reader averaged 4.6 over the last quarter.
    expect(weeksMean(year, 'dial', 40, 52)).toBe(TOP);
  });
});

describe('the year with a shared-enemy check that knows the labels (#481)', () => {
  it('shows nothing hostile once a check flags every hostile claim', async () => {
    const corpus = loadCorpus();
    const hostile = new Set(
      corpus.entries
        .filter((e) => e.hostile)
        .flatMap((e) => claimsIn(e.title, e.text, splitClaims)),
    );
    const year = await simulate({
      readers: corpus.readers.slice(0, 12),
      shelf: corpus.entries,
      weeks: 8,
      seed: 1,
      marks: 'too-far',
      models: {
        embedder: standInEmbedder,
        judge: standInJudge,
        hostility: { isMainlyHostile: (s) => Promise.resolve(hostile.has(s)) },
      },
    });

    expect(year.every((w) => w.hostileShare === 0)).toBe(true);
  }, 30_000);
});
