/**
 * A year of the stretch, simulated (#481; ADR-0080 §8): the history's rules,
 * the reader kinds, and the year itself with the stand-in models, whose
 * numbers ADR-0080 §6 and §8 report beside the real model's.
 *
 * The year's tests assert what is true of the stand-ins on the corpus, and
 * say where it isn't what #481 hoped: a reader's candidate set on the
 * 329-entry corpus shelf is 2 to 29 entries, nearly none of them close kin,
 * so a weekly view of 10 shows most of it from the first week, and the dial
 * has little to stretch (ADR-0080 §6's amendment).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadCorpus } from './corpus';
import { TOP } from './mix';
import { THRESHOLDS } from './thresholds';
import { bedfellows } from './pipeline';
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
  type WeekReport,
} from './simulate';
import { claimsIn, splitClaims } from './split';
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
    const back = marked(again, 'e1', 'too-far', START);

    expect([out.dial, again.dial, back.dial]).toEqual([4, 4, 3]);
    expect(back.shown.get('e1')?.mark).toBe('too-far');
  });
});

describe('markFor: each kind of simulated reader (#481)', () => {
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

  it('may run each week on the entries placed at all: their view is the full shelf’s', async () => {
    // The shortcut `simulate` takes: an entry is placed on its own claims and
    // the reader's, so the rest of the shelf never changes a view.
    const models = { embedder: standInEmbedder, judge: standInJudge };
    const shelf = corpus.entries.map(({ id, title, text }) => ({ id, title, text }));
    for (const reader of few.readers) {
      const all = await bedfellows({ reader: reader.documents, entries: shelf, dial: 0 }, models);
      const placed = shelf.filter((e) => all.some((r) => r.entryId === e.id));
      const ids = placed.map((e) => e.id);
      const input = {
        reader: reader.documents,
        dial: 5,
        view: { size: VIEW_SIZE, date: '2027-03-01', seed: 9 },
        shown: ids.slice(0, 3),
        leaveOut: ids.slice(3, 4),
      };

      expect(await bedfellows({ ...input, entries: placed }, models)).toEqual(
        await bedfellows({ ...input, entries: shelf }, models),
      );
    }
  });

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

describe('a year with the stand-in models over the corpus (#481)', () => {
  const corpus = loadCorpus();
  const years = new Map<string, WeekReport[]>();
  /** The mean of `field` over weeks `from` to `to` (1-based, inclusive). */
  const quarter = (
    year: readonly WeekReport[],
    field: keyof WeekReport,
    from: number,
    to: number,
  ) => year.slice(from - 1, to).reduce((sum, w) => sum + Number(w[field]), 0) / (to - from + 1);

  beforeAll(async () => {
    for (const marks of MARK_KINDS) {
      const input = { readers: corpus.readers, shelf: corpus.entries, pairs: corpus.pairs };
      years.set(marks, await simulate({ ...input, weeks: 52, seed: 1, marks }));
    }
  }, 60_000);

  it.each(MARK_KINDS)('meets more groups and subjects as the year goes on: %s', (marks) => {
    const year = must(years.get(marks));

    expect(must(year.at(-1)).groupsSoFar).toBeGreaterThan(must(year[0]).groupsSoFar);
    expect(must(year.at(-1)).subjectsSoFar).toBeGreaterThan(must(year[0]).subjectsSoFar);
  });

  it('fails #481’s example, as the PR reports: the week’s view doesn’t widen and hostility doesn’t fall', () => {
    // The example expects week 52 to show more groups than week 1, and no
    // greater a hostile share. Neither holds: a reader's candidate set on the
    // corpus shelf is small, so a view of 10 holds most of it from the first
    // week, and the stretch moves the view from middle toward strange entries,
    // where the hostile ones mostly sit (ADR-0080 §6 and §8's amendments).
    const year = must(years.get('none'));
    const [first, last] = [must(year[0]), must(year.at(-1))];

    expect(last.distinctGroups).toBeLessThanOrEqual(first.distinctGroups);
    expect(last.topGroupShare).toBeGreaterThanOrEqual(first.topGroupShare);
    expect(last.hostileShare).toBeGreaterThan(first.hostileShare);
  });

  it('verifies nothing, as the stand-in judge never agrees: precision has nothing to judge', () => {
    for (const year of years.values()) {
      expect(year.every((w) => w.verified === 0 && w.verifiedPrecision === null)).toBe(true);
    }
  });

  it('is the same for a reader who marks Common ground as for one who marks nothing, with nothing verified', () => {
    expect(years.get('common-ground')).toEqual(years.get('none'));
  });

  it('keeps the hostile share between 3% and 8% every week, for every kind, with the check off', () => {
    for (const year of years.values()) {
      expect(year.every((w) => w.hostileShare >= 0.03 && w.hostileShare <= 0.08)).toBe(true);
    }
  });

  it('raises the hostile share for a reader who marks strange entries Too far (a finding for the founder)', () => {
    const year = must(years.get('too-far'));

    expect(quarter(year, 'hostileShare', 40, 52)).toBeGreaterThan(
      quarter(year, 'hostileShare', 1, 13),
    );
  });

  it('shows nothing hostile once a check flags every hostile claim', async () => {
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
  });
});
