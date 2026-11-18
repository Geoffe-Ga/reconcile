/**
 * The Bedfellows pipeline (#475; ADR-0080 §1, §3, §4, §7): a reader's
 * Documents and some shelf entries in, ranked rows out, each with its tier and
 * the pair of sentences that is its reason. The models are ports: these tests
 * run the stand-ins where the words matter, and scripted models where the
 * arithmetic does, so each rule is pinned on its own.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { bedfellows } from './pipeline';
import { standInEmbedder, standInJudge } from './standIns';
import { THRESHOLDS } from './thresholds';
import type {
  BedfellowsDocument,
  BedfellowsEntry,
  Embedder,
  Models,
  Stance,
  StanceJudge,
} from './types';

/** A reader Document holding `text`. */
function doc(text: string, title = 'Ours'): BedfellowsDocument {
  return { title, text };
}

/** A shelf entry `id` whose text is `text`, under `title`. */
function entry(id: string, text: string, title = ''): BedfellowsEntry {
  return { id, title, text };
}

const STAND_INS: Models = { embedder: standInEmbedder, judge: standInJudge };

/**
 * An embedder that reads each sentence's vector from a table, so a test sets
 * every similarity exactly. A sentence missing from the table is an error.
 */
function scripted(table: Readonly<Record<string, readonly number[]>>): Embedder {
  return {
    embed: (sentences) =>
      Promise.resolve(
        sentences.map((sentence) => {
          const vector = table[sentence];
          if (vector === undefined) throw new Error(`No vector for "${sentence}".`);
          return vector;
        }),
      ),
  };
}

/** A judge that answers from a table keyed `reader|entry`, and unsure for the rest. */
function judging(table: Readonly<Record<string, Stance>>): StanceJudge {
  return { judge: (r, e) => Promise.resolve(table[`${r}|${e}`] ?? 'unsure') };
}

/** A unit vector at `degrees` in the plane: two of them have cosine cos(difference). */
function at(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

describe('bedfellows (#475)', () => {
  it('finds the issue’s example: a shared subject, quoted as the entry wrote it, unverified by the stand-in judge', async () => {
    const rows = await bedfellows(
      {
        reader: [doc('Keep the library open on Sundays.')],
        entries: [entry('e1', 'We want the library open.')],
        dial: 0,
      },
      STAND_INS,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: 'e1',
      reason: {
        entrySentence: 'We want the library open.',
        readerSentence: 'Keep the library open on Sundays.',
        verified: false,
      },
    });
  });

  it('gives a reader with no Documents no rows and no error, and asks no model anything', async () => {
    const embed = vi.fn<Embedder['embed']>();
    const judge = vi.fn<StanceJudge['judge']>();

    const rows = await bedfellows(
      { reader: [], entries: [entry('e1', 'We want the library open.')], dial: 0 },
      { embedder: { embed }, judge: { judge } },
    );

    expect(rows).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it('gives a reader whose Documents hold no sentence no rows', async () => {
    const rows = await bedfellows(
      { reader: [doc('   ')], entries: [entry('e1', 'We want the library open.')], dial: 0 },
      STAND_INS,
    );

    expect(rows).toEqual([]);
  });

  it('leaves out an entry with no claim pair above the match threshold', async () => {
    const rows = await bedfellows(
      {
        reader: [doc('Keep the library open on Sundays.')],
        entries: [entry('e1', 'Feed the ducks at the pond.'), entry('e2', '   ')],
        dial: 0,
      },
      STAND_INS,
    );

    expect(rows).toEqual([]);
  });

  it('counts an entry’s title as one of its claims', async () => {
    const rows = await bedfellows(
      {
        reader: [doc('Keep the library open on Sundays.')],
        entries: [entry('e1', 'Feed the ducks at the pond.', 'The library open on Sundays')],
        dial: 0,
      },
      STAND_INS,
    );

    expect(rows[0]?.reason.entrySentence).toBe('The library open on Sundays');
  });

  it('calls a pair the judge says agrees verified, and prefers it as the reason over a closer unsure one', async () => {
    const models: Models = {
      embedder: scripted({ R: at(0), A: at(10), B: at(30), C: at(80), D: at(85) }),
      judge: judging({ 'R|B': 'agrees' }),
    };

    const [row] = await bedfellows(
      { reader: [doc('R')], entries: [entry('e1', 'A B C D')], dial: 0 },
      { ...models, splitter: (text) => text.split(' ') },
    );

    expect(row?.reason).toEqual({ entrySentence: 'B', readerSentence: 'R', verified: true });
  });

  it('drops a pair the judge says opposes, and lets the entry qualify through another pair', async () => {
    const models: Models = {
      embedder: scripted({ R: at(0), A: at(5), B: at(20), C: at(80), D: at(85), E: at(88) }),
      judge: judging({ 'R|A': 'opposes' }),
      splitter: (text) => text.split(' '),
    };

    const [row] = await bedfellows(
      { reader: [doc('R')], entries: [entry('e1', 'A B C D E')], dial: 0 },
      models,
    );

    expect(row?.reason).toEqual({ entrySentence: 'B', readerSentence: 'R', verified: false });
  });

  it('leaves out, and says nothing of, an entry whose only pairs are opposed', async () => {
    const models: Models = {
      embedder: scripted({ R: at(0), A: at(5), C: at(80), D: at(85), E: at(88) }),
      judge: judging({ 'R|A': 'opposes' }),
      splitter: (text) => text.split(' '),
    };

    const rows = await bedfellows(
      { reader: [doc('R')], entries: [entry('e1', 'A C D E')], dial: 0 },
      models,
    );

    expect(rows).toEqual([]);
  });

  it('sends the judge only the entry’s best three pairs, best first', async () => {
    const judge = vi.fn<StanceJudge['judge']>(() => Promise.resolve('opposes'));
    const models: Models = {
      embedder: scripted({
        R: at(0),
        A: at(1),
        B: at(2),
        C: at(3),
        D: at(4),
        E: at(80),
        F: at(82),
      }),
      judge: { judge },
      splitter: (text) => text.split(' '),
    };

    const rows = await bedfellows(
      { reader: [doc('R')], entries: [entry('e1', 'D C B A E F')], dial: 0 },
      models,
    );

    expect(THRESHOLDS.judged).toBe(3);
    expect(judge.mock.calls).toEqual([
      ['R', 'A'],
      ['R', 'B'],
      ['R', 'C'],
    ]);
    // D matched but was never judged, so it can't be the reason: all three judged pairs were opposed.
    expect(rows).toEqual([]);
  });

  it('leaves out a near-copy: an entry nearly all of whose claims have a counterpart', async () => {
    const models: Models = {
      embedder: scripted({ R: at(0), S: at(40), A: at(1), B: at(2), C: at(41), D: at(42) }),
      judge: standInJudge,
      splitter: (text) => text.split(' '),
    };

    const rows = await bedfellows(
      { reader: [doc('R S')], entries: [entry('e1', 'A B C D')], dial: 0 },
      models,
    );

    expect(THRESHOLDS.nearCopy).toBeCloseTo(0.8, 5);
    expect(rows).toEqual([]);
  });

  it('places an entry of three or more claims by strangeness, one minus its coverage', async () => {
    const vectors = {
      R: at(0),
      // Each entry has one claim pinned near R; the rest are far from it.
      M1: at(1),
      M2: at(2),
      X1: at(80),
      X2: at(82),
      X3: at(84),
      X4: at(86),
      X5: at(88),
      X6: at(89),
      X7: at(90),
      X8: at(91),
      X9: at(92),
    };
    const models: Models = {
      embedder: scripted(vectors),
      judge: standInJudge,
      splitter: (text) => text.split(' '),
    };

    const rows = await bedfellows(
      {
        reader: [doc('R')],
        entries: [
          // Coverage 2/3: strangeness 1/3.
          entry('close', 'M1 M2 X1'),
          // Coverage 2/4: strangeness 1/2.
          entry('middle', 'M1 M2 X2 X3'),
          // Coverage 1/9: strangeness 8/9.
          entry('strange', 'M1 X1 X2 X3 X4 X5 X6 X7 X8'),
        ],
        dial: 0,
      },
      models,
    );

    expect(Object.fromEntries(rows.map((row) => [row.entryId, row.tier]))).toEqual({
      close: 'close',
      middle: 'middle',
      strange: 'strange',
    });
  });

  it('places an entry under three claims by its best pair’s strength, and never calls it a near-copy', async () => {
    const strong = THRESHOLDS.shortEntry.close;
    const middling = THRESHOLDS.shortEntry.middle;
    const toDegrees = (cos: number): number => (Math.acos(cos) * 180) / Math.PI;
    const models: Models = {
      embedder: scripted({
        R: at(0),
        S: at(toDegrees(strong) - 1),
        M: at(toDegrees(middling) - 1),
        W: at(toDegrees(THRESHOLDS.match) - 1),
        X: at(89),
      }),
      judge: standInJudge,
      splitter: (text) => text.split(' ').filter((word) => word !== ''),
    };

    const rows = await bedfellows(
      {
        reader: [doc('R')],
        entries: [entry('s', 'S X'), entry('m', 'M'), entry('w', 'W X')],
        dial: 0,
      },
      models,
    );

    expect(rows.map((row) => [row.entryId, row.tier])).toEqual([
      ['s', 'close'],
      ['m', 'middle'],
      ['w', 'strange'],
    ]);
  });

  it('ranks close kin first, then middle, then strange, and stronger reasons first within a tier', async () => {
    const models: Models = {
      embedder: scripted({ R: at(0), A: at(1), B: at(20), C: at(30) }),
      judge: standInJudge,
      splitter: (text) => text.split(' '),
    };

    const rows = await bedfellows(
      {
        reader: [doc('R')],
        entries: [entry('weak', 'C'), entry('strong', 'A'), entry('two', 'B'), entry('tie', 'B')],
        dial: 0,
      },
      models,
    );

    expect(rows.map((row) => row.entryId)).toEqual(['strong', 'tie', 'two', 'weak']);
  });

  it('ignores the dial for now (#479 reads it)', async () => {
    const input = {
      reader: [doc('Keep the library open on Sundays.')],
      entries: [entry('e1', 'We want the library open.')],
    };

    const rows = await bedfellows({ ...input, dial: 0 }, STAND_INS);

    expect(await bedfellows({ ...input, dial: 5 }, STAND_INS)).toEqual(rows);
  });

  it('doesn’t let the order of the reader’s Documents or of the entries change which rows come back', async () => {
    const sentences = [
      'Keep the library open on Sundays.',
      'We want the library open.',
      'The park needs more trees.',
      'Plant trees along the river.',
      'Feed the ducks at the pond.',
      'Quiz nights bring the street together.',
      'Open the library late for students.',
      'Trees cool the street in summer.',
    ];
    const text = fc
      .array(fc.constantFrom(...sentences), { minLength: 1, maxLength: 4 })
      .map((picked) => picked.join(' '));
    const docs = fc.array(
      text.map((t) => doc(t)),
      { maxLength: 4 },
    );
    const entries = fc.uniqueArray(
      fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), text, title: fc.constant('') }),
      { maxLength: 6, selector: (e) => e.id },
    );

    await fc.assert(
      fc.asyncProperty(
        docs.chain((d) =>
          fc.tuple(fc.constant(d), fc.shuffledSubarray(d, { minLength: d.length })),
        ),
        entries.chain((e) =>
          fc.tuple(fc.constant(e), fc.shuffledSubarray(e, { minLength: e.length })),
        ),
        async ([reader, readerShuffled], [shelf, shelfShuffled]) => {
          const rows = await bedfellows({ reader, entries: shelf, dial: 0 }, STAND_INS);
          const again = await bedfellows(
            { reader: readerShuffled, entries: shelfShuffled, dial: 0 },
            STAND_INS,
          );
          expect(again).toEqual(rows);
        },
      ),
    );
  });

  it('breaks a tie between equally good pairs by their words, not by where they sit', async () => {
    const models: Models = {
      embedder: scripted({ P: at(0), Q: at(0), A: at(10) }),
      judge: standInJudge,
      splitter: (text) => text.split(' '),
    };

    const one = await bedfellows(
      { reader: [doc('P'), doc('Q')], entries: [entry('e1', 'A')], dial: 0 },
      models,
    );
    const two = await bedfellows(
      { reader: [doc('Q'), doc('P')], entries: [entry('e1', 'A')], dial: 0 },
      models,
    );

    expect(one).toEqual(two);
    expect(one[0]?.reason.readerSentence).toBe('P');
  });

  it('stops between entries once its signal is aborted, rejecting with an AbortError', async () => {
    const controller = new AbortController();
    const judge = vi.fn<StanceJudge['judge']>(() => {
      controller.abort();
      return Promise.resolve('unsure');
    });

    const run = bedfellows(
      {
        reader: [doc('Keep the library open on Sundays.')],
        entries: [entry('e1', 'We want the library open.'), entry('e2', 'The library open.')],
        dial: 0,
      },
      { embedder: standInEmbedder, judge: { judge } },
      controller.signal,
    );

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when its signal is already aborted', async () => {
    const embed = vi.fn<Embedder['embed']>();

    await expect(
      bedfellows(
        { reader: [doc('Keep it.')], entries: [entry('e1', 'Keep it.')], dial: 0 },
        { embedder: { embed }, judge: standInJudge },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(embed).not.toHaveBeenCalled();
  });
});
