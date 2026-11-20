/**
 * A year of the stretch, simulated (#481; ADR-0080 §8): the history's rules,
 * the reader kinds, and what one week's run is handed. The year itself over
 * the whole corpus with the stand-in models, whose numbers ADR-0080 §6 and §8
 * report beside the real model's, is in `simulate.year-none.test.ts` and
 * `simulate.year-too-far.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadCorpus } from './corpus';
import { TOP } from './mix';
import { THRESHOLDS } from './thresholds';
import {
  HISTORY_DAYS,
  MARK_KINDS,
  markFor,
  marked,
  NEW_HISTORY,
  opened,
  showed,
  simulate,
  START,
  VIEW_SIZE,
  weekInput,
} from './simulate';
import { splitClaims } from './split';
import { standInEmbedder, standInJudge } from './standIns';
import type { Row } from './types';

/** `value`, which the test knows is there. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value.');
  return value;
}

/** A row of `tier`, verified or not. */
function row(tier: Row['tier'], verified: boolean): Row {
  return { entryId: 'e1', tier, reason: { entrySentence: 'a', readerSentence: 'b', verified } };
}

describe('the simulated history keeps the store’s rules (#480)', () => {
  it('notes the first week without stepping, then steps once for each later week opened', () => {
    const first = opened(NEW_HISTORY, '2027-01-04');
    const sameWeek = opened(first, '2027-01-10');
    const later = opened(sameWeek, '2027-03-01');

    expect(first.dial).toBe(0);
    expect(sameWeek.dial).toBe(0);
    expect(later.dial).toBe(1);
  });

  it('never steps past the top', () => {
    let history = NEW_HISTORY;
    for (let w = 0; w < TOP + 4; w += 1) {
      history = opened(history, new Date(Date.UTC(2027, 0, 4 + 7 * w)).toISOString().slice(0, 10));
    }

    expect(history.dial).toBe(TOP);
  });

  it('forgets a record 30 days after the day it was first shown, and not before', () => {
    const shown = showed(opened(NEW_HISTORY, '2027-01-04'), ['e1'], '2027-01-04');

    expect(HISTORY_DAYS).toBe(30);
    expect(opened(shown, '2027-02-02').shown.has('e1')).toBe(true);
    expect(opened(shown, '2027-02-03').shown.has('e1')).toBe(false);
  });

  it('keeps the day an entry was first shown when it is shown again', () => {
    const once = showed(NEW_HISTORY, ['e1'], '2027-01-04');
    const twice = showed(once, ['e1', 'e2'], '2027-01-11');

    expect(twice.shown.get('e1')?.day).toBe(once.shown.get('e1')?.day);
    expect(twice.shown.get('e2')?.day).toBe(must(once.shown.get('e1')).day + 7);
  });

  it('records an entry marked before it was recorded as shown, as first shown that day', () => {
    const history = marked(NEW_HISTORY, 'e9', 'too-far', '2027-01-04');

    expect(history.shown.get('e9')).toEqual({ day: 20_822, mark: 'too-far' });
    expect(history.dial).toBe(0);
  });

  it('nudges the dial out for Common ground and in for Too far, and not for the same mark again', () => {
    const start = { ...NEW_HISTORY, dial: 3 };
    const out = marked(start, 'e1', 'common-ground', START);
    const again = marked(out, 'e1', 'common-ground', START);

    expect([out.dial, again.dial]).toEqual([4, 4]);
    expect(opened(again, START).dial).toBe(4);
    expect(marked(opened(again, START), 'e1', 'too-far', START).dial).toBe(3);
  });

  it('nudges at most once a view, and a new view (each open) has its own nudge', () => {
    const view = opened({ ...NEW_HISTORY, dial: 3 }, START);
    const first = marked(view, 'e1', 'too-far', START);
    const second = marked(first, 'e2', 'too-far', START);
    const third = marked(second, 'e3', 'common-ground', START);
    const next = marked(opened(third, START), 'e4', 'too-far', START);

    expect([first.dial, second.dial, third.dial, next.dial]).toEqual([2, 2, 2, 1]);
    expect(third.shown.get('e2')?.mark).toBe('too-far');
    expect(third.shown.get('e3')?.mark).toBe('common-ground');
  });

  it('spends no nudge on the same mark again', () => {
    const view = opened({ ...NEW_HISTORY, dial: 3 }, START);
    const once = marked(marked(view, 'e1', 'common-ground', START), 'e2', 'too-far', START);
    const held = marked(opened(once, START), 'e1', 'common-ground', START);

    expect(once.dial).toBe(4);
    expect(marked(held, 'e2', 'common-ground', START).dial).toBe(5);
  });
});

describe('markFor: each kind of simulated reader (#481)', () => {
  it('has the three kinds #481 names', () => {
    expect(MARK_KINDS).toEqual(['none', 'common-ground', 'too-far']);
  });

  it('marks nothing for a reader who marks nothing', () => {
    expect(markFor('none', row('strange', true))).toBeNull();
  });

  it('marks only verified strange entries Common ground', () => {
    expect(markFor('common-ground', row('strange', true))).toBe('common-ground');
    expect(markFor('common-ground', row('strange', false))).toBeNull();
    expect(markFor('common-ground', row('middle', true))).toBeNull();
  });

  it('marks every strange entry Too far, verified or not, and nothing nearer', () => {
    expect(markFor('too-far', row('strange', false))).toBe('too-far');
    expect(markFor('too-far', row('strange', true))).toBe('too-far');
    expect(markFor('too-far', row('close', false))).toBeNull();
  });
});

describe('simulate (#481)', () => {
  const corpus = loadCorpus();
  const few = { readers: corpus.readers.slice(0, 3), shelf: corpus.entries, pairs: corpus.pairs };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is the same for the same seed, week for week', async () => {
    const a = await simulate({ ...few, weeks: 4, seed: 7, marks: 'too-far' });
    const b = await simulate({ ...few, weeks: 4, seed: 7, marks: 'too-far' });

    expect(a).toEqual(b);
    expect(a.map((w) => w.week)).toEqual([1, 2, 3, 4]);
  });

  it('shows no more than a view’s worth a week, and steps the dial each week', async () => {
    const year = await simulate({ ...few, weeks: 3, seed: 1, marks: 'none' });

    expect(year.every((w) => w.shown <= VIEW_SIZE)).toBe(true);
    expect(year.map((w) => w.dial)).toEqual([0, 1, 2]);
  });

  it('scores a verified reason by its pair’s label, and leaves precision null with none', async () => {
    const reader = must(corpus.readers[0]);
    const shared = must(
      corpus.pairs.find((p) => p.reader === reader.id && p.kind === 'shared-claim'),
    );
    // The labelled entry's id, holding the reader's own sentence, so the stand-in finds the pair.
    const shelf = [
      {
        ...must(corpus.entries[0]),
        id: shared.entry,
        title: '',
        text: must(shared.readerSentence),
      },
    ];
    const agreeing = {
      embedder: standInEmbedder,
      judge: { judge: () => Promise.resolve('agrees' as const) },
    };
    const input = { readers: [reader], shelf, weeks: 1, seed: 1, marks: 'none' as const };

    const scored = await simulate({ ...input, pairs: corpus.pairs, models: agreeing });
    const unlabelled = await simulate({ ...input, models: agreeing });

    expect(scored[0]).toMatchObject({ verified: 1, verifiedPrecision: 1 });
    expect(unlabelled[0]).toMatchObject({ verified: 1, verifiedPrecision: null });
  });

  it('hands every week’s run the whole shelf, and leaves Too far out of the rows only (ADR-0080 §5)', () => {
    // §5 (#477, #480): the run is handed every entry on the shelf, so a cache
    // of its vectors says nothing about the reader; the reader's own groups'
    // entries (`own`) and those marked Too far leave the rows, never the run.
    const shelf = corpus.entries.map(({ id, title, text }) => ({ id, title, text }));
    const reader = must(few.readers[0]);
    let history = opened(NEW_HISTORY, '2027-03-01');
    history = showed(history, ['e001', 'e002', 'e003'], '2027-03-01');
    history = marked(history, 'e002', 'too-far', '2027-03-01');
    history = marked(history, 'e003', 'common-ground', '2027-03-01');

    const input = weekInput(reader, shelf, history, {
      size: VIEW_SIZE,
      date: '2027-03-01',
      seed: 9,
    });

    expect(input.entries).toEqual(shelf);
    expect(input.reader).toBe(reader.documents);
    expect(input.dial).toBe(history.dial);
    expect(input.view).toEqual({ size: VIEW_SIZE, date: '2027-03-01', seed: 9, own: [] });
    expect([...(input.shown ?? [])].sort()).toEqual(['e001', 'e002', 'e003']);
    expect(input.leaveOut).toEqual(['e002']);
  });

  it('is the same for a reader who marks Common ground as for one who marks nothing, with nothing verified', async () => {
    // The stand-in judge never agrees, so no reason is verified and the
    // Common ground reader has nothing to mark (ADR-0080 §8).
    const none = await simulate({ ...few, weeks: 13, seed: 1, marks: 'none' });
    const commonGround = await simulate({ ...few, weeks: 13, seed: 1, marks: 'common-ground' });

    expect(commonGround).toEqual(none);
    expect(none.every((w) => w.verified === 0 && w.verifiedPrecision === null)).toBe(true);
    // Two 13-week runs over the whole shelf each week: about 10 s on CI's runner, beside the year files.
  }, 60_000);

  it('takes a view’s size, a first date, thresholds and a splitter when a run by hand passes them', async () => {
    const year = await simulate({
      ...few,
      weeks: 2,
      seed: 1,
      marks: 'none',
      size: 3,
      start: '2027-06-07',
      thresholds: THRESHOLDS,
      models: { embedder: standInEmbedder, judge: standInJudge, splitter: splitClaims },
    });

    expect(year.map((w) => w.shown <= 3)).toEqual([true, true]);
    expect(year.map((w) => w.dial)).toEqual([0, 1]);
  });

  it('reads and writes nothing outside memory: no request, no storage, no log', async () => {
    const doors = [
      vi.fn(),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const open = vi.fn();
    vi.stubGlobal('fetch', doors[0]);
    vi.stubGlobal('indexedDB', { open, deleteDatabase: open });
    vi.stubGlobal('caches', { open, match: open });

    await simulate({ ...few, weeks: 2, seed: 1, marks: 'too-far' });

    for (const door of [...doors, open]) expect(door).not.toHaveBeenCalled();
  });
});
