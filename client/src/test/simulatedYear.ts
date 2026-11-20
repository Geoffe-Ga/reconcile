/**
 * The year's simulation over the whole corpus with the stand-in models (#481;
 * ADR-0080 §8), shared by the year's tests. Each reader kind's year runs in a
 * test file of its own, so the runner can take them side by side: every
 * week's run is handed the whole shelf (ADR-0080 §5), which makes one kind's
 * year about half a minute.
 */
import type { Corpus } from '../bedfellows/corpus';
import { type MarkKind, simulate, type WeekReport } from '../bedfellows/simulate';

/** `value`, which the test knows is there. */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value.');
  return value;
}

/** The mean of `field` over weeks `from` to `to` of `year` (1-based, inclusive). */
export function weeksMean(
  year: readonly WeekReport[],
  field: keyof WeekReport,
  from: number,
  to: number,
): number {
  return year.slice(from - 1, to).reduce((sum, w) => sum + Number(w[field]), 0) / (to - from + 1);
}

/** Weeks 1 to 4 and the last quarter, weeks 40 to 52: the two the founder's bar compares. */
export const FIRST_MONTH = [1, 4] as const;
export const LAST_QUARTER = [40, 52] as const;

/**
 * A year of readers of `marks`'s kind: `corpus`'s readers and shelf, 52
 * weeks, seed 1. The test hands it the corpus, which only tests may load.
 */
export function corpusYear(corpus: Corpus, marks: MarkKind): Promise<WeekReport[]> {
  return simulate({
    readers: corpus.readers,
    shelf: corpus.entries,
    pairs: corpus.pairs,
    weeks: 52,
    seed: 1,
    marks,
  });
}
