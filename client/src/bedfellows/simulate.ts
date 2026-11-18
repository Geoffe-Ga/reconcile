/**
 * A year of the stretch, simulated (#481; ADR-0080 §8): nothing leaves a
 * device, so no one can watch whether real readers are being reconciled or
 * radicalized. This is the check before the pilot.
 *
 * Each corpus reader opens Bedfellows once a week for `weeks` weeks against
 * the corpus shelf. Each week the dial steps as `clock.ts` steps it, the
 * pipeline picks a view of {@link VIEW_SIZE} at that dial with the reader's
 * history, and the reader marks what they were shown by their kind:
 *
 * - `none` marks nothing;
 * - `common-ground` marks every verified strange entry Common ground, which
 *   nudges the dial out;
 * - `too-far` marks every strange entry Too far, which nudges the dial in
 *   and leaves the entry out while the history keeps the mark.
 *
 * The history is modelled here as `src/store/bedfellows.ts` (#480) keeps it,
 * since Bedfellows may not import the store: a record per entry shown, with
 * the day first shown and its mark, forgotten 30 days on; a new mark nudges
 * the dial, the same mark again doesn't. `simulate.test.ts` holds the two to
 * the same rules.
 *
 * It is deterministic for a seed: each reader's view seed comes from it, and
 * every date from `start`. It reads and writes nothing outside memory: entry
 * vectors go to a store in memory, and nothing is logged or sent.
 */
import type { Entry, Pair, Reader } from './corpus';
import { dayOf, nextDial, nudge, weekOf } from './clock';
import { memoryVectorStore, type VectorStore } from './entryVectors';
import { turn } from './mix';
import { bedfellows, type RunOptions } from './pipeline';
import { splitClaims } from './split';
import { standInEmbedder, standInJudge } from './standIns';
import type { Thresholds } from './thresholds';
import type { BedfellowsEntry, Models, Row, Splitter } from './types';

/** How a simulated reader marks what they're shown. */
export type MarkKind = 'none' | 'common-ground' | 'too-far';

/** Every kind of simulated reader. */
export const MARK_KINDS: readonly MarkKind[] = ['none', 'common-ground', 'too-far'];

/** Rows per view: no screen sets one yet, so a phone screen's worth. */
export const VIEW_SIZE = 10;

/** The first week's Monday: any date gives the same shape; this one pins the numbers. */
export const START = '2027-01-04';

/** Days a history record lasts (`HISTORY_DAYS` in `src/store/bedfellows.ts`). */
export const HISTORY_DAYS = 30;

/** What one year's run is asked. */
export interface SimulationInput {
  readonly readers: readonly Reader[];
  readonly shelf: readonly Entry[];
  readonly weeks: number;
  readonly seed: number;
  readonly marks: MarkKind;
  /** The labelled pairs, so a verified reason can be scored; without them, none is. */
  readonly pairs?: readonly Pair[];
  /** The models: the stand-ins unless a run by hand passes the real ones. */
  readonly models?: Models;
  readonly thresholds?: Thresholds;
  readonly size?: number;
  readonly start?: string;
}

/** One week, over every reader. */
export interface WeekReport {
  /** 1 for the first week. */
  readonly week: number;
  /** The dial's mean step as the view was picked. */
  readonly dial: number;
  /** Rows shown, per reader, on average. */
  readonly shown: number;
  /** Distinct publishing groups in a reader's view, on average. */
  readonly distinctGroups: number;
  /** Distinct subjects (the corpus's labels) in a reader's view, on average. */
  readonly distinctSubjects: number;
  /** Distinct publishing groups a reader has been shown so far this year, on average. */
  readonly groupsSoFar: number;
  /** Distinct subjects a reader has been shown so far this year, on average. */
  readonly subjectsSoFar: number;
  /** The share of a reader's view from its most-shown group, on average over views with rows. */
  readonly topGroupShare: number;
  /** Verified reasons shown, over every reader. */
  readonly verified: number;
  /**
   * Of the verified reasons shown on a labelled pair, the share labelled
   * `shared-claim`; null when there were none to judge.
   */
  readonly verifiedPrecision: number | null;
  /** The share of every row shown that week whose entry is labelled `hostile`. */
  readonly hostileShare: number;
}

/** One record of a simulated history. */
interface HistoryRecord {
  readonly day: number;
  readonly mark?: 'common-ground' | 'too-far';
}

/** A simulated reader's history, as `src/store/bedfellows.ts` keeps it. */
export interface SimulatedHistory {
  readonly dial: number;
  readonly lastStepWeek: number | null;
  readonly shown: ReadonlyMap<string, HistoryRecord>;
}

/** A history before the first view. */
export const NEW_HISTORY: SimulatedHistory = { dial: 0, lastStepWeek: null, shown: new Map() };

/**
 * `history` as Bedfellows opens on `date`: records 30 days old or more
 * forgotten, then the dial stepped for the week (the first view only notes it).
 */
export function opened(history: SimulatedHistory, date: string): SimulatedHistory {
  const today = dayOf(date);
  const week = weekOf(date);
  const shown = new Map([...history.shown].filter(([, r]) => today < r.day + HISTORY_DAYS));
  const last = history.lastStepWeek;
  if (last !== null && week <= last) return { ...history, shown };
  const dial = last === null ? history.dial : nextDial(history.dial, last, week, true);
  return { dial, lastStepWeek: week, shown };
}

/** `history` once `ids` were shown on `date`: each not yet recorded is, as first shown that day. */
export function showed(
  history: SimulatedHistory,
  ids: readonly string[],
  date: string,
): SimulatedHistory {
  const shown = new Map(history.shown);
  for (const id of ids) if (!shown.has(id)) shown.set(id, { day: dayOf(date) });
  return { ...history, shown };
}

/** `history` once `id` is marked `mark`: a new mark nudges the dial, the same mark again doesn't. */
export function marked(
  history: SimulatedHistory,
  id: string,
  mark: 'common-ground' | 'too-far',
  date: string,
): SimulatedHistory {
  const held = history.shown.get(id);
  const dial =
    held?.mark === mark
      ? history.dial
      : nudge(history.dial, mark === 'common-ground' ? 'out' : 'in');
  const shown = new Map(history.shown);
  shown.set(id, { day: held?.day ?? dayOf(date), mark });
  return { ...history, dial, shown };
}

/** The mark a reader of `kind` puts on `row`, or none. */
export function markFor(kind: MarkKind, row: Row): 'common-ground' | 'too-far' | null {
  if (row.tier !== 'strange') return null;
  if (kind === 'too-far') return 'too-far';
  return kind === 'common-ground' && row.reason.verified ? 'common-ground' : null;
}

/** The date `weeks` weeks after `start`. */
function weeksAfter(start: string, weeks: number): string {
  return new Date((dayOf(start) + 7 * weeks) * 86_400_000).toISOString().slice(0, 10);
}

/** One row as the week's report reads it: the row, and the corpus entry it shows. */
interface Shown {
  readonly row: Row;
  readonly entry: Entry;
}

/** What one reader's view showed in one week. */
interface ViewStats {
  readonly reader: string;
  readonly dial: number;
  readonly shown: readonly Shown[];
  /** Distinct groups and subjects the reader has been shown so far this year. */
  readonly groupsSoFar: number;
  readonly subjectsSoFar: number;
}

/** Everything one reader's year is run with. */
interface Run {
  readonly input: SimulationInput;
  /** The corpus entries, as the shelf, by id. */
  readonly entries: ReadonlyMap<string, Entry>;
  readonly models: Models;
  /** The shelf's public vectors, in memory, shared by every reader of the run. */
  readonly store: VectorStore;
  readonly options: RunOptions;
  readonly size: number;
  readonly start: string;
}

/** `entry` as the pipeline reads a shelf entry. */
function onShelf({ id, title, text }: Entry): BedfellowsEntry {
  return { id, title, text };
}

/**
 * The entries of `run`'s shelf the pipeline gives `reader` any row for. An
 * entry is placed on its own claims and the reader's alone, so one with no
 * row never gets one, whatever the dial, the history or the date: each week
 * can run on these alone and give the same view, at a fraction of the cost.
 */
async function placeable(reader: Reader, run: Run): Promise<BedfellowsEntry[]> {
  const shelf = [...run.entries.values()].map(onShelf);
  const rows = await bedfellows(
    { reader: reader.documents, entries: shelf, dial: 0 },
    run.models,
    run.options,
  );
  const ids = new Set(rows.map((row) => row.entryId));
  return shelf.filter((entry) => ids.has(entry.id));
}

/** `rows` with the corpus entry each shows. */
function shownOf(rows: readonly Row[], entries: ReadonlyMap<string, Entry>): Shown[] {
  return rows.flatMap((row) => {
    const entry = entries.get(row.entryId);
    return entry === undefined ? [] : [{ row, entry }];
  });
}

/** One reader's year: each week's dial and view. */
async function readerYear(reader: Reader, run: Run): Promise<ViewStats[]> {
  const { input } = run;
  const seed = turn(0, input.seed, reader.id);
  const entries = await placeable(reader, run);
  const weeks: ViewStats[] = [];
  const groups = new Set<string>();
  const subjects = new Set<string>();
  let history = NEW_HISTORY;
  for (let w = 0; w < input.weeks; w += 1) {
    const date = weeksAfter(run.start, w);
    history = opened(history, date);
    const rows = await bedfellows(
      {
        reader: reader.documents,
        entries,
        dial: history.dial,
        view: { size: run.size, date, seed },
        shown: [...history.shown.keys()],
        leaveOut: [...history.shown].flatMap(([id, r]) => (r.mark === 'too-far' ? [id] : [])),
      },
      run.models,
      run.options,
    );
    const shown = shownOf(rows, run.entries);
    for (const { entry } of shown) {
      groups.add(entry.publisher);
      subjects.add(entry.subject);
    }
    weeks.push({
      reader: reader.id,
      dial: history.dial,
      shown,
      groupsSoFar: groups.size,
      subjectsSoFar: subjects.size,
    });
    history = showed(
      history,
      rows.map((row) => row.entryId),
      date,
    );
    for (const row of rows) {
      const mark = markFor(input.marks, row);
      if (mark !== null) history = marked(history, row.entryId, mark, date);
    }
  }
  return weeks;
}

/**
 * `store`, keeping every entry's vectors whichever subset a run asks about:
 * the simulation's shelf never changes, and every reader shares it.
 */
function kept(store: VectorStore): VectorStore {
  return {
    read: (ids) => store.read(ids),
    write: (records) => store.write(records),
    keepOnly: () => Promise.resolve(),
  };
}

/** `split`, remembering each text's claims for the run, since the same shelf is cut every week. */
function remembered(split: Splitter): Splitter {
  const cut = new Map<string, readonly string[]>();
  return (text) => {
    const claims = cut.get(text) ?? split(text);
    cut.set(text, claims);
    return [...claims];
  };
}

/** The mean of `values`, 0 for none. */
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** How many of `values` are distinct. */
function distinct(values: readonly string[]): number {
  return new Set(values).size;
}

/** The share of `values` taken by its most common value; 0 for none. */
function topShare(values: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return values.length === 0 ? 0 : Math.max(...counts.values()) / values.length;
}

/** The share of `kinds` that are `shared-claim`, or null for none. */
function precisionOf(kinds: readonly Pair['kind'][]): number | null {
  return kinds.length === 0
    ? null
    : kinds.filter((k) => k === 'shared-claim').length / kinds.length;
}

/**
 * What one week's `views`, one per reader, add up to; `pairs` holds each
 * labelled pair's kind, keyed `reader|entry`.
 */
function weekReport(
  week: number,
  views: readonly ViewStats[],
  pairs: ReadonlyMap<string, Pair['kind']>,
): WeekReport {
  const groups = views.map((v) => v.shown.map(({ entry }) => entry.publisher));
  const all = views.flatMap((v) => v.shown.map((shown) => ({ ...shown, reader: v.reader })));
  const verified = all.filter(({ row }) => row.reason.verified);
  const judged = verified.flatMap(({ entry, reader }) => {
    const kind = pairs.get(`${reader}|${entry.id}`);
    return kind === undefined ? [] : [kind];
  });
  const hostile = all.filter(({ entry }) => entry.hostile).length;
  return {
    week,
    dial: mean(views.map((v) => v.dial)),
    shown: mean(views.map((v) => v.shown.length)),
    distinctGroups: mean(groups.map(distinct)),
    distinctSubjects: mean(views.map((v) => distinct(v.shown.map(({ entry }) => entry.subject)))),
    groupsSoFar: mean(views.map((v) => v.groupsSoFar)),
    subjectsSoFar: mean(views.map((v) => v.subjectsSoFar)),
    topGroupShare: mean(groups.filter((g) => g.length > 0).map(topShare)),
    verified: verified.length,
    verifiedPrecision: precisionOf(judged),
    hostileShare: all.length === 0 ? 0 : hostile / all.length,
  };
}

/**
 * A year of the stretch: one {@link WeekReport} per week, for readers of
 * `input.marks`'s kind.
 */
export async function simulate(input: SimulationInput): Promise<WeekReport[]> {
  const models = input.models ?? { embedder: standInEmbedder, judge: standInJudge };
  const store = kept(memoryVectorStore());
  const run: Run = {
    input,
    entries: new Map(input.shelf.map((e) => [e.id, e])),
    models: { ...models, splitter: remembered(models.splitter ?? splitClaims) },
    store,
    options: { store, ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }) },
    size: input.size ?? VIEW_SIZE,
    start: input.start ?? START,
  };
  const byWeek: ViewStats[][] = Array.from({ length: input.weeks }, () => []);
  for (const reader of input.readers) {
    const year = await readerYear(reader, run);
    year.forEach((view, w) => byWeek[w]?.push(view));
  }
  const pairs = new Map((input.pairs ?? []).map((p) => [`${p.reader}|${p.entry}`, p.kind]));
  return byWeek.map((views, w) => weekReport(w + 1, views, pairs));
}
