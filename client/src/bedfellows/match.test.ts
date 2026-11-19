/**
 * Matching claims (#477; ADR-0080 §1, §4): every reader claim against every
 * entry claim by cosine, the candidate pairs above the match threshold, the
 * best of them first, and coverage: the share of the entry's claims with a
 * counterpart in the reader's writing.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Claim, cosine, coverage, matchEntry } from './match';

/** A unit vector at `degrees` in the plane. */
function at(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/** A claim `sentence` with `vector`. */
function claim(sentence: string, vector: readonly number[]): Claim {
  return { sentence, vector };
}

const CUTS = { match: Math.cos((30 * Math.PI) / 180), counterpart: Math.cos((20 * Math.PI) / 180) };

describe('cosine (#477)', () => {
  it('is 1 for one direction, 0 at right angles, -1 opposite, and 0 against the zero vector', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0, 10);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
  });

  it('reads a Float32Array as well as an array', () => {
    expect(cosine(Float32Array.from([1, 0]), [1, 0])).toBeCloseTo(1, 6);
  });
});

describe('matchEntry (#477)', () => {
  it('pairs every reader claim with every entry claim, keeping those at or above the match threshold, best first', () => {
    const reader = [claim('R', at(0)), claim('S', at(90))];
    const entry = [claim('A', at(25)), claim('B', at(10)), claim('C', at(62)), claim('D', at(85))];

    const found = matchEntry(entry, reader, CUTS);

    const degrees = (cos: number) => Math.round((Math.acos(cos) * 180) / Math.PI);
    expect(
      found.candidates.map((pair) => [
        pair.readerSentence,
        pair.entrySentence,
        degrees(pair.similarity),
      ]),
    ).toEqual([
      ['S', 'D', 5],
      ['R', 'B', 10],
      ['R', 'A', 25],
      ['S', 'C', 28],
    ]);
  });

  it('counts coverage at the counterpart threshold: A at 25° and C at 28° are candidates but no counterparts', () => {
    const reader = [claim('R', at(0)), claim('S', at(90))];
    const entry = [claim('A', at(25)), claim('B', at(10)), claim('C', at(62)), claim('D', at(85))];

    expect(matchEntry(entry, reader, CUTS).coverage).toBe(2 / 4);
  });

  it('gives an entry with no claims no candidates and no coverage', () => {
    expect(matchEntry([], [claim('R', at(0))], CUTS)).toEqual({ candidates: [], coverage: 0 });
  });
});

describe('coverage (#477)', () => {
  const vectorIn = (dimensions: number) =>
    fc.array(fc.float({ min: -1, max: 1, noNaN: true }), {
      minLength: dimensions,
      maxLength: dimensions,
    });

  it('never rises when an unrelated sentence joins the entry', () => {
    const dimensions = 4;
    fc.assert(
      fc.property(
        fc.array(vectorIn(dimensions), { minLength: 1, maxLength: 5 }),
        fc.array(vectorIn(dimensions), { minLength: 1, maxLength: 6 }),
        fc.float({ min: Math.fround(0.05), max: Math.fround(0.95), noNaN: true }),
        fc.float({ min: Math.fround(0.1), max: Math.fround(5), noNaN: true }),
        (readerVectors, entryVectors, counterpart, length) => {
          // The reader's and entry's vectors live in the first four dimensions; the unrelated
          // sentence points along a fifth that nothing else uses, so its cosine with every
          // reader claim is 0, below any counterpart threshold.
          const pad = (v: readonly number[]) => [...v, 0];
          const reader = readerVectors.map((v, i) => claim(`r${String(i)}`, pad(v)));
          const entry = entryVectors.map((v, i) => claim(`e${String(i)}`, pad(v)));
          const unrelated = claim('u', [0, 0, 0, 0, length]);

          const before = coverage(entry, reader, counterpart);
          const after = coverage([...entry, unrelated], reader, counterpart);

          expect(after).toBeLessThanOrEqual(before);
        },
      ),
    );
  });
});
