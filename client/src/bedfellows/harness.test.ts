/**
 * The harness (#474; ADR-0080 §8): any matcher in, per-kind counts out, with
 * the precision of "common ground" and the share of opposed pairs called
 * common ground. A small corpus written here pins the arithmetic exactly;
 * `corpus.test.ts` checks the real corpus, and `baseline.test.ts` its numbers.
 */
import { describe, expect, it } from 'vitest';

import type { Corpus, Entry, Pair, PairKind, Reader } from './corpus';
import { harness, heldOutReport, type Matcher, type Verdict } from './harness';

/** A reader with one Document, `text`, in `split`. */
function reader(id: string, text: string, split: Reader['split'] = 'tune'): Reader {
  return { id, split, community: 'a test', documents: [{ title: 'Ours', text }] };
}

/** An entry whose text is `text`, in `split`. */
function entry(id: string, text: string, split: Entry['split'] = 'tune'): Entry {
  return { id, split, title: 'Theirs', text, hostile: false, publisher: 'g1', subject: 'parks' };
}

/** A pair of `kind` between reader `r` and entry `e`. */
function pair(id: string, r: string, e: string, kind: PairKind): Pair {
  return { id, reader: r, entry: e, kind };
}

const TINY: Corpus = {
  readers: [reader('r1', 'Keep the park open.'), reader('r2', 'Hold quiz nights.', 'held-out')],
  entries: [
    entry('e1', 'Open the park to all.'),
    entry('e2', 'Close the park at night.'),
    entry('e3', 'Paint the boards.'),
    entry('e4', 'Quiz nights are back.', 'held-out'),
  ],
  publishers: [{ id: 'g1', name: 'Test publishers', split: 'tune' }],
  pairs: [
    pair('p1', 'r1', 'e1', 'shared-claim'),
    pair('p2', 'r1', 'e2', 'opposed'),
    pair('p3', 'r1', 'e3', 'word-sense-trap'),
    pair('p4', 'r2', 'e4', 'shared-claim'),
  ],
};

/** A matcher that answers from a table of entry ids, and nothing for the rest. */
function fixed(verdicts: Readonly<Record<string, Verdict>>): Matcher {
  return (_reader, e) => verdicts[e.id] ?? 'nothing';
}

describe('harness (#474)', () => {
  it('counts, per kind, what the matcher called each pair', () => {
    const matcher = fixed({ e1: 'common-ground', e2: 'common-ground', e3: 'shared-subject' });

    const report = harness(matcher, 'tune', TINY);

    expect(report.split).toBe('tune');
    expect(report.byKind['shared-claim']).toEqual({
      pairs: 1,
      commonGround: 1,
      sharedSubject: 0,
      nothing: 0,
    });
    expect(report.byKind.opposed).toEqual({
      pairs: 1,
      commonGround: 1,
      sharedSubject: 0,
      nothing: 0,
    });
    expect(report.byKind['word-sense-trap']).toEqual({
      pairs: 1,
      commonGround: 0,
      sharedSubject: 1,
      nothing: 0,
    });
    expect(report.byKind.unrelated).toEqual({
      pairs: 0,
      commonGround: 0,
      sharedSubject: 0,
      nothing: 0,
    });
  });

  it('gives the precision of common ground: the share of it that falls on shared claims', () => {
    const report = harness(fixed({ e1: 'common-ground', e2: 'common-ground' }), 'tune', TINY);

    expect(report.precision).toBe(0.5);
    expect(report.falseAgreement).toBe(1);
  });

  it('gives no precision when the matcher called nothing common ground, and no false agreement then', () => {
    const report = harness(fixed({}), 'tune', TINY);

    expect(report.precision).toBeNull();
    expect(report.falseAgreement).toBe(0);
    expect(report.byKind['shared-claim'].nothing).toBe(1);
  });

  it('reads only the split it was asked for', () => {
    const asked: string[] = [];
    const matcher: Matcher = (r, e) => {
      asked.push(`${r.id}:${e.id}`);
      return 'nothing';
    };

    harness(matcher, 'tune', TINY);

    expect(asked).toEqual(['r1:e1', 'r1:e2', 'r1:e3']);
  });

  it('refuses held-out numbers unless they are asked for by name', () => {
    expect(() => harness(fixed({}), 'held-out', TINY)).toThrow(
      'Held-out numbers come only from heldOutReport.',
    );
    const report = heldOutReport(fixed({ e4: 'common-ground' }), TINY);
    expect(report.split).toBe('held-out');
    expect(report.byKind['shared-claim']).toEqual({
      pairs: 1,
      commonGround: 1,
      sharedSubject: 0,
      nothing: 0,
    });
    expect(report.precision).toBe(1);
  });

  it('fails loudly on a pair whose reader or entry isn’t in the corpus', () => {
    const broken: Corpus = { ...TINY, pairs: [pair('px', 'r9', 'e1', 'opposed')] };

    expect(() => harness(fixed({}), 'tune', broken)).toThrow('Pair px names a reader or entry');
  });
});
