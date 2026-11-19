/**
 * The Bedfellows pipeline (#475, #477; ADR-0080 §1, §3, §4, §7): a reader's
 * own Documents and some public shelf entries in, ranked rows out.
 *
 * 1. Each reader Document and each entry is cut into claims (`split.ts`); an
 *    entry's title is a claim too.
 * 2. Every claim is embedded: the reader's in memory for this run only, the
 *    entries' through the cache of public entry vectors (`entryVectors.ts`).
 *    Every reader claim is matched against every entry claim by cosine
 *    (`match.ts`); pairs at or above `match` are candidates.
 * 3. An entry's coverage is the share of its claims with a counterpart. One
 *    with no candidate, or (at three claims or more) coverage above
 *    `nearCopy`, stays out.
 * 4. Its best three pairs go to the stance check. An agreeing pair is a
 *    verified anchor, an unsure one a shared subject; an opposed pair is
 *    dropped, and an entry left with none stays out, with nothing said.
 * 5. Its tier comes from strangeness, one minus coverage, or for an entry
 *    under three claims from its best pair and its nearest Document
 *    (`tiers.ts`).
 * 6. An entry with candidate pairs in two of the reader's Documents unlike
 *    each other bridges them (`bridge.ts`) and goes first in its tier.
 * 7. With a view (#479), each tier's order is turned by the view's date and
 *    seed, and the dial's mix (`mix.ts`) picks how many of each tier show.
 *
 * Term overlap (`fallback.ts`) places, unverified, every entry while the
 * model hasn't loaded (no embedder), an entry the model doesn't cover against
 * all the reader's Documents, and any entry against those of the reader's
 * Documents the model doesn't cover.
 *
 * It is pure but for the cache: the same input and models give the same
 * rows, whatever order the reader's Documents or the entries come in, because
 * every tie is broken by words, never by position. It sends nothing, and it
 * writes nothing but entries' public vectors to the store it is handed: the
 * reader's text, vectors and scores exist only in memory (ADR-0080 §5).
 *
 * **Hand it the whole shelf.** The cache keeps exactly the entries a run is
 * given, unsealed, so a caller that left out the reader's own groups' entries
 * would leave a gap in it the shape of those groups. A caller drops its own
 * groups' entries from the rows that come back, never from what goes in
 * (ADR-0080 §5, as #477 amends it). A view (#479) mixes the rows it picks, so
 * it can't be trimmed after: the caller names those entries in `view.own`,
 * and the view leaves them out before the mix.
 */
import { bridges, documentsOf } from './bridge';
import { dayOf } from './clock';
import {
  CHUNK,
  embedInChunks,
  entryVectors,
  stopIfAborted,
  type VectorStore,
} from './entryVectors';
import { covers, type RankedRow, termOverlapRow } from './fallback';
import { byText, type Candidate, type Claim, matchEntry } from './match';
import { mix, rotate, turn } from './mix';
import { claimsIn, splitClaims } from './split';
import { THRESHOLDS, type Thresholds } from './thresholds';
import { centroid, nearestDocument, tierByStrangeness, tierOfShortEntry } from './tiers';
import type {
  BedfellowsEntry,
  BedfellowsInput,
  BedfellowsView,
  Embedder,
  Models,
  Reason,
  Row,
  Splitter,
  StanceJudge,
  Tier,
  Vector,
} from './types';

export { cosine } from './match';

/** How a run runs. */
export interface RunOptions {
  /** Stops the run between entries and between embedding chunks. */
  readonly signal?: AbortSignal | undefined;
  /** Where entries' public vectors are kept; without one, nothing is kept. */
  readonly store?: VectorStore | undefined;
  /** The thresholds to run with: {@link THRESHOLDS} unless a tuning run tries others. */
  readonly thresholds?: Thresholds;
}

/** A reader Document's claims, and whether the model covers it. */
interface ReaderDocument {
  readonly claims: readonly string[];
  readonly covered: boolean;
}

/** An entry's claims, and whether the model covers it. */
interface EntryClaims {
  readonly id: string;
  readonly claims: readonly string[];
  readonly covered: boolean;
}

/** The reader, as the model sees the Documents it covers. */
interface ModelReader {
  readonly claims: readonly Claim[];
  /** Each covered Document's claims, and their vectors, in the same order. */
  readonly documents: readonly (readonly string[])[];
  readonly byDocument: readonly (readonly Vector[])[];
}

/** A ranked row, and whether it bridges the reader's Documents. */
interface BridgedRow extends RankedRow {
  readonly bridges: boolean;
}

/** A placed row, and whether the reader has seen it (#480). */
interface PlacedRow extends BridgedRow {
  readonly seen: boolean;
}

/** Everything a run places entries with. */
interface Context {
  readonly reader: ModelReader;
  /** Every Document's claims, for an entry the model doesn't cover. */
  readonly allDocuments: readonly (readonly string[])[];
  /** The claims of the Documents the model doesn't cover. */
  readonly uncovered: readonly (readonly string[])[];
  readonly vectors: ReadonlyMap<string, Vector[]>;
  /** The centroid of each covered Document's vectors, for the bridging bonus. */
  readonly centroids: readonly Vector[];
  readonly judge: StanceJudge;
  readonly thresholds: Thresholds;
}

/** The order tiers are shown in. */
const TIER_ORDER: readonly Tier[] = ['close', 'middle', 'strange'];

/** `sentences`, trimmed, without blanks or repeats, in code-unit order. */
function claimsOf(sentences: readonly string[]): string[] {
  const trimmed = sentences.map((sentence) => sentence.trim()).filter((s) => s !== '');
  return [...new Set(trimmed)].sort(byText);
}

/**
 * Close kin first, then middle, then strange; in a tier, entries the reader
 * hasn't seen first, then bridges, then stronger reasons, then by entry id.
 */
function byRank(a: PlacedRow, b: PlacedRow): number {
  const tier = TIER_ORDER.indexOf(a.row.tier) - TIER_ORDER.indexOf(b.row.tier);
  if (tier !== 0) return tier;
  if (a.seen !== b.seen) return a.seen ? 1 : -1;
  if (a.bridges !== b.bridges) return a.bridges ? -1 : 1;
  if (a.strength !== b.strength) return b.strength - a.strength;
  return byText(a.row.entryId, b.row.entryId);
}

/** `pair` as a reason. */
function reasonFrom(pair: Candidate, verified: boolean): Reason {
  return { entrySentence: pair.entrySentence, readerSentence: pair.readerSentence, verified };
}

/**
 * The reason among `best`, judged in order: the first pair the judge says
 * agrees, else the first it's unsure of, else null (every pair opposed).
 */
async function reasonOf(
  best: readonly Candidate[],
  judge: StanceJudge,
): Promise<{ reason: Reason; strength: number } | null> {
  let unsure: Candidate | null = null;
  for (const pair of best) {
    const stance = await judge.judge(pair.readerSentence, pair.entrySentence);
    if (stance === 'agrees') return { reason: reasonFrom(pair, true), strength: pair.similarity };
    if (stance === 'unsure') unsure ??= pair;
  }
  return unsure === null
    ? null
    : { reason: reasonFrom(unsure, false), strength: unsure.similarity };
}

/** Whether `candidates` reach two of the reader's covered Documents unlike each other. */
function bridgesDocuments(candidates: readonly Candidate[], context: Context): boolean {
  const sentences = candidates.map((pair) => pair.readerSentence);
  const hit = documentsOf(sentences, context.reader.documents);
  return bridges(hit, context.centroids, context.thresholds.bridge.unlikeBelow);
}

/** `entry`'s row by the model, from its claims' `vectors`, or null when it stays out. */
async function placeByModel(
  entry: EntryClaims,
  vectors: readonly Vector[],
  context: Context,
): Promise<BridgedRow | null> {
  const t = context.thresholds;
  const claims = entry.claims.map((sentence, i) => ({ sentence, vector: vectors[i] ?? [] }));
  const found = matchEntry(claims, context.reader.claims, t);
  if (found.candidates.length === 0) return null;
  const short = entry.claims.length < t.shortEntry.claims;
  if (!short && found.coverage > t.nearCopy) return null;
  const best = await reasonOf(found.candidates.slice(0, t.judged), context.judge);
  if (best === null) return null;
  const tier = short
    ? tierOfShortEntry(best.strength, nearestDocument(vectors, context.reader.byDocument), t)
    : tierByStrangeness(1 - found.coverage, t);
  return {
    row: { entryId: entry.id, tier, reason: best.reason },
    strength: best.strength,
    bridges: bridgesDocuments(found.candidates, context),
  };
}

/**
 * `entry`'s row: by the model where it covers the entry, else by term overlap.
 * Term overlap has no vectors to tell Documents apart, so its rows never bridge.
 */
async function place(entry: EntryClaims, context: Context): Promise<BridgedRow | null> {
  const vectors = context.vectors.get(entry.id);
  if (vectors !== undefined) {
    const row = await placeByModel(entry, vectors, context);
    if (row !== null) return row;
  }
  const documents = vectors === undefined ? context.allDocuments : context.uncovered;
  const row =
    documents.length === 0
      ? null
      : termOverlapRow(entry.id, entry.claims, documents, context.thresholds);
  return row === null ? null : { ...row, bridges: false };
}

/** The reader's covered claims embedded, in memory for this run only, and each Document's vectors. */
async function modelReader(
  documents: readonly ReaderDocument[],
  embedder: Embedder | undefined,
  signal: AbortSignal | undefined,
): Promise<ModelReader> {
  const covered = documents.filter((doc) => doc.covered);
  if (embedder === undefined || covered.length === 0) {
    return { claims: [], documents: [], byDocument: [] };
  }
  const sentences = claimsOf(covered.flatMap((doc) => doc.claims));
  const vectors = await embedInChunks(sentences, embedder, CHUNK, signal);
  const vectorOf = (sentence: string): Vector => vectors.get(sentence) ?? [];
  return {
    claims: sentences.map((sentence) => ({ sentence, vector: vectorOf(sentence) })),
    documents: covered.map((doc) => doc.claims),
    byDocument: covered.map((doc) => doc.claims.map(vectorOf)),
  };
}

/** The shelf's entries in id order, each with its claims and whether `modelCovers` it. */
function entryClaimsOf(
  entries: readonly BedfellowsEntry[],
  split: Splitter,
  modelCovers: (text: string) => boolean,
): EntryClaims[] {
  return [...entries]
    .sort((a, b) => byText(a.id, b.id))
    .map((e) => ({
      id: e.id,
      claims: claimsOf(claimsIn(e.title, e.text, split)),
      covered: modelCovers(`${e.title}\n${e.text}`),
    }))
    .filter((entry) => entry.claims.length > 0);
}

/** The vectors of the entries the model covers, when the reader has claims it covers too. */
async function coveredEntryVectors(
  entries: readonly EntryClaims[],
  reader: ModelReader,
  embedder: Embedder | undefined,
  options: RunOptions,
): Promise<Map<string, Vector[]>> {
  const matched = reader.claims.length === 0 ? [] : entries.filter((entry) => entry.covered);
  if (embedder === undefined || matched.length === 0) return new Map();
  return entryVectors(matched, embedder, { store: options.store, signal: options.signal });
}

/**
 * `ranked`, in rank order, as one view: the reader's own groups' entries left
 * out; in each tier, the unseen entries before the seen (#480), each of those
 * bridges first, every part turned by the view's day and seed; then the dial's
 * mix of the tiers.
 */
function pickView(ranked: readonly PlacedRow[], dial: number, view: BedfellowsView): Row[] {
  const day = dayOf(view.date);
  const own = new Set(view.own);
  const candidates = ranked.filter((r) => !own.has(r.row.entryId));
  const turned = (tier: Tier, seen: boolean, bridging: boolean): Row[] => {
    const rows = candidates.filter(
      (r) => r.row.tier === tier && r.seen === seen && r.bridges === bridging,
    );
    const salt = `${tier}|${bridging ? 'bridge' : 'rest'}${seen ? '|seen' : ''}`;
    return rotate(rows, turn(day, view.seed, salt)).map(({ row }) => row);
  };
  const tierOf = (tier: Tier): Row[] =>
    [false, true].flatMap((seen) => [...turned(tier, seen, true), ...turned(tier, seen, false)]);
  const byTier = { close: tierOf('close'), middle: tierOf('middle'), strange: tierOf('strange') };
  return mix(byTier, dial, view.size).shown;
}

/**
 * The rows Bedfellows would show `input.reader` from `input.entries`. Without
 * `input.view`, every row, ranked: close kin first, then middle, then strange,
 * and within a tier bridges first, then stronger reasons. With one, the view's
 * pick at `input.dial` (`pickView`). A reader with no Documents gets none.
 *
 * @throws {DOMException} an AbortError, between entries or embedding chunks, once `signal` is aborted.
 * @throws {RangeError} when `input.view.date` isn't a YYYY-MM-DD date.
 */
export async function bedfellows(
  input: BedfellowsInput,
  models: Models,
  options: RunOptions = {},
): Promise<Row[]> {
  const { signal } = options;
  const t = options.thresholds ?? THRESHOLDS;
  stopIfAborted(signal);
  const { embedder } = models;
  const split = models.splitter ?? splitClaims;
  const modelCovers = (text: string) => embedder !== undefined && covers(text, t.covers);
  const documents: ReaderDocument[] = input.reader
    .map((doc) => ({ claims: claimsOf(split(doc.text)), covered: modelCovers(doc.text) }))
    .filter((doc) => doc.claims.length > 0);
  if (documents.length === 0) return [];
  const entries = entryClaimsOf(input.entries, split, modelCovers);
  const reader = await modelReader(documents, embedder, signal);
  const context: Context = {
    reader,
    centroids: reader.byDocument.map(centroid),
    allDocuments: documents.map((doc) => doc.claims),
    uncovered: documents.filter((doc) => !doc.covered).map((doc) => doc.claims),
    vectors: await coveredEntryVectors(entries, reader, embedder, options),
    judge: models.judge,
    thresholds: t,
  };
  const seen = new Set(input.shown);
  // Too far leaves rows out, never the run's input: the cache keeps exactly
  // what a run is given, so a gap in it would show the reader's marks.
  const leaveOut = new Set(input.leaveOut);
  const ranked: PlacedRow[] = [];
  for (const entry of entries) {
    stopIfAborted(signal);
    const row = await place(entry, context);
    if (row !== null && !leaveOut.has(entry.id)) ranked.push({ ...row, seen: seen.has(entry.id) });
  }
  stopIfAborted(signal);
  ranked.sort(byRank);
  return input.view === undefined
    ? ranked.map(({ row }) => row)
    : pickView(ranked, input.dial, input.view);
}
