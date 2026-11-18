/**
 * The Bedfellows pipeline (#475; ADR-0080 §1, §3, §4, §7): a reader's
 * Documents and some shelf entries in, ranked rows out, each with its tier and
 * the pair of sentences that is its reason. The models are ports: these tests
 * run the stand-ins where the words matter, and scripted models where the
 * arithmetic does, so each rule is pinned on its own.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { memoryVectorStore } from './entryVectors';
import { TOP } from './mix';
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

describe('bedfellows with the model and its fallback (#477)', () => {
  /**
   * The real model's cosines for the issue's examples (#476's model, measured
   * on the measuring page): 0.479 for the reading room against the library,
   * 0.332 for the chess club's boards against the housing board.
   */
  const MEASURED = { library: 0.479, chess: 0.332 };
  const angle = (cos: number) => (Math.acos(cos) * 180) / Math.PI;
  const examples = scripted({
    'Keep the reading room open late.': at(0),
    'The library must stay open.': at(angle(MEASURED.library)),
    'Our chess club needs new boards.': at(90),
    'The housing board meets on Tuesday.': at(90 + angle(MEASURED.chess)),
  });

  /** The row `reader` gets for `text` as an entry, or undefined. */
  async function rowFor(reader: string, text: string, models: Models) {
    const [row] = await bedfellows(
      { reader: [doc(reader)], entries: [entry('e', text)], dial: 0 },
      models,
    );
    return row;
  }

  it('finds “reading room” against “library” at the model’s cosine, which term overlap misses', async () => {
    const reader = 'Keep the reading room open late.';
    const text = 'The library must stay open.';

    expect(
      (await rowFor(reader, text, { embedder: examples, judge: standInJudge }))?.tier,
    ).toBeDefined();
    expect(await rowFor(reader, text, { judge: standInJudge })).toBeUndefined();
  });

  it('finds no candidate pair between a chess club’s boards and a housing board', async () => {
    expect(
      await rowFor('Our chess club needs new boards.', 'The housing board meets on Tuesday.', {
        embedder: examples,
        judge: standInJudge,
      }),
    ).toBeUndefined();
  });

  it('matches by term overlap while the model hasn’t loaded, every reason unverified, and asks the judge nothing', async () => {
    const judge = vi.fn<StanceJudge['judge']>(() => Promise.resolve('agrees'));

    const rows = await bedfellows(
      {
        reader: [doc('Keep the library open on Sundays.')],
        entries: [
          entry('e1', 'We want the library open.'),
          entry('e2', 'Feed the ducks at the pond.'),
        ],
        dial: 0,
      },
      { judge: { judge } },
    );

    expect(rows).toEqual([
      {
        entryId: 'e1',
        tier: 'close',
        reason: {
          entrySentence: 'We want the library open.',
          readerSentence: 'Keep the library open on Sundays.',
          verified: false,
        },
      },
    ]);
    expect(judge).not.toHaveBeenCalled();
  });

  const SPANISH =
    'Queremos que la biblioteca del barrio siga abierta por las tardes y los domingos para todos los vecinos.';

  it('matches an entry the model doesn’t cover by term overlap, and never embeds it', async () => {
    const embed = vi.fn<Embedder['embed']>((sentences) => standInEmbedder.embed(sentences));

    const rows = await bedfellows(
      {
        reader: [doc('Pedimos que la biblioteca del barrio siga abierta.')],
        entries: [entry('es', SPANISH)],
        dial: 0,
      },
      { embedder: { embed }, judge: standInJudge },
    );

    expect(rows.map((row) => [row.entryId, row.reason.verified])).toEqual([['es', false]]);
    expect(embed.mock.calls.flat(2)).not.toContain(SPANISH);
  });

  it('matches an entry by term overlap against a reader Document the model doesn’t cover, and by the model against the rest', async () => {
    const embed = vi.fn<Embedder['embed']>((sentences) => standInEmbedder.embed(sentences));
    const judge = judging({
      'Keep the library open on Sundays.|We want the library open.': 'agrees',
    });

    const rows = await bedfellows(
      {
        reader: [doc('Keep the library open on Sundays.'), doc(SPANISH)],
        entries: [
          entry('en', 'We want the library open.'),
          entry('mixed', 'Visit the biblioteca: queremos que siga abierta los domingos.'),
        ],
        dial: 0,
      },
      { embedder: { embed }, judge },
    );

    expect(rows.map((row) => [row.entryId, row.reason.verified]).sort()).toEqual([
      ['en', true],
      ['mixed', false],
    ]);
    expect(embed.mock.calls.flat(2)).not.toContain(SPANISH);
  });

  it('keeps the entries’ vectors in the store it is handed, never the reader’s, and reuses them on the next run', async () => {
    const store = memoryVectorStore();
    const embed = vi.fn<Embedder['embed']>((sentences) => standInEmbedder.embed(sentences));
    const models: Models = { embedder: { model: 'stand-in', embed }, judge: standInJudge };
    const input = {
      reader: [doc('Keep the library open on Sundays.')],
      entries: [entry('e1', 'We want the library open.', 'Library hours')],
      dial: 0,
    };

    const first = await bedfellows(input, models, { store });
    embed.mockClear();
    const second = await bedfellows(input, models, { store });

    expect(second).toEqual(first);
    expect(store.records().map((r) => [r.entryId, r.claims])).toEqual([
      ['e1', ['Library hours', 'We want the library open.']],
    ]);
    expect(embed.mock.calls).toEqual([[['Keep the library open on Sundays.']]]);
  });
});

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
        G: at(84),
        H: at(86),
      }),
      judge: { judge },
      splitter: (text) => text.split(' '),
    };

    const rows = await bedfellows(
      // Four of eight claims have a counterpart: coverage 1/2, well short of a near-copy.
      { reader: [doc('R')], entries: [entry('e1', 'D C B A E F G H')], dial: 0 },
      models,
      // Eight one-letter claims aren't English prose, so the model wouldn't cover them; this test is about judging.
      { thresholds: { ...THRESHOLDS, covers: { ...THRESHOLDS.covers, minWords: 100 } } },
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

    expect(rows).toEqual([]);
  });

  it('places an entry of three or more claims by strangeness, one minus its coverage', async () => {
    const { closeBelow, strangeFrom } = THRESHOLDS.strangeness;
    const toDegrees = (cos: number): number => (Math.acos(cos) * 180) / Math.PI;
    const vectors = {
      R: at(0),
      // M1–M3 are counterparts of R; W is a candidate pair for R but no counterpart; X1–X3 are far.
      M1: at(1),
      M2: at(2),
      M3: at(3),
      W: at(toDegrees((THRESHOLDS.match + THRESHOLDS.counterpart) / 2)),
      X1: at(80),
      X2: at(82),
      X3: at(84),
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
          // Coverage 3/5: strangeness 2/5, below closeBelow.
          entry('close', 'M1 M2 M3 X1 X2'),
          // Coverage 1/4: strangeness 3/4, between the cuts.
          entry('middle', 'M1 X1 X2 X3'),
          // A candidate pair, but no claim with a counterpart: strangeness 1.
          entry('strange', 'W X1 X2'),
        ],
        dial: 0,
      },
      models,
    );

    expect(2 / 5).toBeLessThan(closeBelow);
    expect(3 / 4).toBeGreaterThanOrEqual(closeBelow);
    expect(3 / 4).toBeLessThan(strangeFrom);
    expect(Object.fromEntries(rows.map((row) => [row.entryId, row.tier]))).toEqual({
      close: 'close',
      middle: 'middle',
      strange: 'strange',
    });
  });

  it('places an entry under three claims by its best pair’s strength and its nearest Document, and never calls it a near-copy', async () => {
    const toDegrees = (cos: number): number => (Math.acos(cos) * 180) / Math.PI;
    const { close, middle } = THRESHOLDS.shortEntry;
    const models: Models = {
      embedder: scripted({
        R: at(0),
        S: at(toDegrees(close + 0.02)),
        M: at(toDegrees(middle + 0.02)),
        W: at(toDegrees((THRESHOLDS.match + middle) / 2)),
        Y: at(150),
      }),
      judge: standInJudge,
      splitter: (text) => text.split(' ').filter((word) => word !== ''),
    };

    const rows = await bedfellows(
      {
        reader: [doc('R')],
        entries: [
          // One claim each: its nearest Document's cosine is its pair's, so closeness is the pair's strength.
          entry('s', 'S'),
          entry('m', 'M'),
          entry('w', 'W'),
          // The same strong pair beside a claim far from the reader's Document: further out.
          entry('far', 'S Y'),
        ],
        dial: 0,
      },
      models,
    );

    expect(rows.map((row) => [row.entryId, row.tier])).toEqual([
      ['s', 'close'],
      ['m', 'middle'],
      ['far', 'strange'],
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

  it('returns every row when no view is asked for, whatever the dial', async () => {
    const input = {
      reader: [doc('Keep the library open on Sundays.')],
      entries: [entry('e1', 'We want the library open.')],
    };

    const rows = await bedfellows({ ...input, dial: 0 }, STAND_INS);

    expect(rows).toHaveLength(1);
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
      { signal: controller.signal },
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
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('bedfellows picks and orders a view (#479)', () => {
  const toDegrees = (cos: number): number => (Math.acos(cos) * 180) / Math.PI;
  // One claim each, so closeness is the pair's strength (`tiers.ts`): C close, M middle, W strange.
  const embedder = scripted({
    R: at(0),
    C: at(10),
    M: at(toDegrees(0.5)),
    W: at(toDegrees((THRESHOLDS.match + THRESHOLDS.shortEntry.middle) / 2)),
  });
  const models: Models = {
    embedder,
    judge: standInJudge,
    splitter: (text) => text.split(' '),
  };
  const shelf = (sentence: string, prefix: string): BedfellowsEntry[] =>
    Array.from({ length: 12 }, (_, i) => entry(`${prefix}${String(i).padStart(2, '0')}`, sentence));
  const entries = [...shelf('C', 'c'), ...shelf('M', 'm'), ...shelf('W', 'w')];
  const tiersOf = (rows: readonly { tier: string }[]) => rows.map((row) => row.tier);

  it('shows the dial’s mix: mostly close kin at 0, mostly strange at the top, close kin first', async () => {
    const view = { size: 10, date: '2026-11-18', seed: 7 };

    const at0 = await bedfellows({ reader: [doc('R')], entries, dial: 0, view }, models);
    const atTop = await bedfellows({ reader: [doc('R')], entries, dial: TOP, view }, models);

    expect(tiersOf(at0)).toEqual([
      ...Array<string>(7).fill('close'),
      'middle',
      'middle',
      'strange',
    ]);
    expect(tiersOf(atTop)).toEqual([
      ...Array<string>(2).fill('close'),
      'middle',
      'middle',
      ...Array<string>(6).fill('strange'),
    ]);
    expect(new Set(atTop.map((row) => row.entryId)).size).toBe(10);
  });

  it('gives the same view for the same input, date and seed, in any order, and leads with others on other days', async () => {
    const view = { size: 4, date: '2026-11-18', seed: 7 };
    const one = await bedfellows({ reader: [doc('R')], entries, dial: 0, view }, models);
    const two = await bedfellows(
      { reader: [doc('R')], entries: [...entries].reverse(), dial: 0, view },
      models,
    );
    expect(two).toEqual(one);

    const leaders = new Set<string>();
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-02-${String(day).padStart(2, '0')}`;
      const [first] = await bedfellows(
        { reader: [doc('R')], entries, dial: 0, view: { ...view, date } },
        models,
      );
      leaders.add(first?.entryId ?? '');
    }
    expect(leaders.size).toBeGreaterThan(1);
  });

  it('leaves out every entry the reader marked Too far, and nothing else (#480)', async () => {
    const leaveOut = ['c00', 'm03', 'w11', 'not-on-the-shelf'];
    const all = await bedfellows({ reader: [doc('R')], entries, dial: 0 }, models);
    const kept = await bedfellows({ reader: [doc('R')], entries, dial: 0, leaveOut }, models);
    expect(kept.map((row) => row.entryId)).toEqual(
      all.map((row) => row.entryId).filter((id) => !leaveOut.includes(id)),
    );
    const view = { size: 36, date: '2026-11-18', seed: 7 };
    const shown = await bedfellows(
      { reader: [doc('R')], entries, dial: 0, leaveOut, view },
      models,
    );
    expect(shown.some((row) => leaveOut.includes(row.entryId))).toBe(false);
  });

  it('ranks the entries the reader hasn’t seen first in each tier, with or without a view (#480)', async () => {
    const firstSix = (prefix: string) =>
      Array.from({ length: 6 }, (_, i) => `${prefix}0${String(i)}`);
    const seen = [...firstSix('c'), ...firstSix('m')];
    const rows = await bedfellows({ reader: [doc('R')], entries, dial: 0, shown: seen }, models);
    const close = rows.filter((row) => row.tier === 'close').map((row) => row.entryId);
    expect(close.slice(0, 6).every((id) => !seen.includes(id))).toBe(true);
    expect(close.slice(6).every((id) => seen.includes(id))).toBe(true);
    const middle = rows.filter((row) => row.tier === 'middle').map((row) => row.entryId);
    expect(middle.slice(0, 6).every((id) => !seen.includes(id))).toBe(true);

    // A view of 6 at dial 0 shows only unseen entries while each tier has enough, on any day.
    for (const date of ['2026-11-18', '2026-11-19', '2026-12-01']) {
      const view = { size: 6, date, seed: 3 };
      const picked = await bedfellows(
        { reader: [doc('R')], entries, dial: 0, shown: seen, view },
        models,
      );
      expect(picked.filter((row) => seen.includes(row.entryId))).toEqual([]);
    }
  });

  it('holds the dial’s floors in the pipeline’s view for any dial, date and seed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: TOP }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer(),
        async (dial, day, seed) => {
          const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
          const view = { size: 10, date, seed };
          const rows = await bedfellows({ reader: [doc('R')], entries, dial, view }, models);
          const again = await bedfellows({ reader: [doc('R')], entries, dial, view }, models);
          expect(again).toEqual(rows);
          expect(rows).toHaveLength(10);
          expect(new Set(rows.map((row) => row.entryId)).size).toBe(10);
          expect(tiersOf(rows).filter((tier) => tier === 'close').length).toBeGreaterThanOrEqual(1);
          expect(tiersOf(rows).filter((tier) => tier === 'strange').length).toBeGreaterThanOrEqual(
            1,
          );
        },
      ),
      { numRuns: 30 },
    );
  });

  it('leaves the reader’s own groups’ entries out of the view before it mixes, and still keeps their vectors', async () => {
    const own = ['c00', 'c01', 'c02', 'c03', 'c04'];
    const store = memoryVectorStore();
    const view = { size: 10, date: '2026-11-18', seed: 7, own };

    const kept: Models = { ...models, embedder: { ...embedder, model: 'scripted' } };

    const rows = await bedfellows({ reader: [doc('R')], entries, dial: 0, view }, kept, { store });

    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => own.includes(row.entryId))).toEqual([]);
    expect(tiersOf(rows).filter((tier) => tier === 'close')).toHaveLength(7);
    const cached = new Set(store.records().map((record) => record.entryId));
    expect(own.filter((id) => cached.has(id))).toEqual(own);
  });

  it('still keeps the vectors of entries marked Too far, so the cache shows no sign of a mark (#480)', async () => {
    const leaveOut = ['c00', 'm03', 'w11'];
    const store = memoryVectorStore();
    const view = { size: 10, date: '2026-11-18', seed: 7 };
    const kept: Models = { ...models, embedder: { ...embedder, model: 'scripted' } };

    const rows = await bedfellows({ reader: [doc('R')], entries, dial: 0, leaveOut, view }, kept, {
      store,
    });

    expect(rows.filter((row) => leaveOut.includes(row.entryId))).toEqual([]);
    const cached = new Set(store.records().map((record) => record.entryId));
    expect(leaveOut.filter((id) => cached.has(id))).toEqual(leaveOut);
  });

  describe('the bridging bonus', () => {
    // P and Q are unlike (cosine 0). A sits near P, B near Q; S sits nearer P than A does.
    const bridging: Models = {
      embedder: scripted({ P: at(0), Q: at(90), A: at(30), B: at(60), S: at(1) }),
      judge: standInJudge,
      splitter: (text) => text.split(' '),
    };
    const shelfOf = [entry('bridge', 'A B'), entry('solo', 'S')];

    it('puts an entry with pairs in two unlike Documents first in its tier', async () => {
      const rows = await bedfellows(
        { reader: [doc('P'), doc('Q')], entries: shelfOf, dial: 0 },
        bridging,
      );

      expect(rows.map((row) => [row.entryId, row.tier])).toEqual([
        ['bridge', 'close'],
        ['solo', 'close'],
      ]);
    });

    it('puts it first in its tier in a view too', async () => {
      const rows = await bedfellows(
        {
          reader: [doc('P'), doc('Q')],
          entries: shelfOf,
          dial: 0,
          view: { size: 2, date: '2026-11-18', seed: 1 },
        },
        bridging,
      );

      expect(rows.map((row) => row.entryId)).toEqual(['bridge', 'solo']);
    });

    it('gives a reader with one Document no bonus, and no error', async () => {
      const rows = await bedfellows({ reader: [doc('P Q')], entries: shelfOf, dial: 0 }, bridging);

      expect(rows.map((row) => row.entryId)).toEqual(['solo', 'bridge']);
    });

    it('gives no bonus for pairs in two Documents alike each other', async () => {
      const alike: Models = {
        ...bridging,
        embedder: scripted({ P: at(0), Q: at(20), A: at(5), B: at(15), S: at(1) }),
      };

      const rows = await bedfellows(
        { reader: [doc('P'), doc('Q')], entries: shelfOf, dial: 0 },
        alike,
      );

      expect(rows.map((row) => row.entryId)).toEqual(['solo', 'bridge']);
    });
  });
});
