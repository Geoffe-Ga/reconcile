/**
 * The Bedfellows pipeline (#475; ADR-0080 §1, §3, §4, §7): a reader's own
 * Documents and some public shelf entries in, ranked rows out.
 *
 * 1. Each reader Document and each entry is cut into claims, one sentence
 *    each; an entry's title is a claim too.
 * 2. Every claim is embedded, and every reader claim is matched against every
 *    entry claim by cosine. Pairs at or above `THRESHOLDS.match` are candidates.
 * 3. An entry's coverage is the share of its claims with a candidate. One with
 *    no candidate, or (at three claims or more) coverage above
 *    `THRESHOLDS.nearCopy`, stays out.
 * 4. Its best three pairs go to the stance check. An agreeing pair is a
 *    verified anchor, an unsure one a shared subject; an opposed pair is
 *    dropped, and an entry left with none stays out, with nothing said.
 * 5. Its tier comes from strangeness, one minus coverage, or for an entry
 *    under three claims from its reason's strength.
 *
 * It is pure: the same input and models give the same rows, whatever order
 * the reader's Documents or the entries come in, because every tie is broken
 * by words, never by position. It writes nothing and sends nothing: the
 * reader's text, vectors and scores exist only in memory (ADR-0080 §5).
 */
import { standInSplitter } from './standIns';
import { THRESHOLDS } from './thresholds';
import type {
  BedfellowsEntry,
  BedfellowsInput,
  Models,
  Reason,
  Row,
  Splitter,
  StanceJudge,
  Tier,
  Vector,
} from './types';

/** A reader claim and its vector. */
interface Claim {
  readonly sentence: string;
  readonly vector: Vector;
}

/** A candidate pair of claims and how alike their vectors are. */
interface Candidate {
  readonly readerSentence: string;
  readonly entrySentence: string;
  readonly similarity: number;
}

/** A row and the strength of its reason, which ranks it within its tier. */
interface Ranked {
  readonly row: Row;
  readonly strength: number;
}

/** The order tiers are shown in. */
const TIER_ORDER: readonly Tier[] = ['close', 'middle', 'strange'];

/** The cosine of the angle between `a` and `b`; 0 when either is the zero vector. */
export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/** Orders strings by their UTF-16 code units, the same on every device and in every locale. */
function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** `sentences`, trimmed, without blanks or repeats, in code-unit order. */
function claimsOf(sentences: readonly string[]): string[] {
  const trimmed = sentences.map((sentence) => sentence.trim()).filter((s) => s !== '');
  return [...new Set(trimmed)].sort(byText);
}

/** Stronger pairs first; equal pairs by the entry's sentence, then the reader's. */
function byStrength(a: Candidate, b: Candidate): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity;
  return byText(a.entrySentence, b.entrySentence) || byText(a.readerSentence, b.readerSentence);
}

/** Close kin first, then middle, then strange; stronger reasons first, then by entry id. */
function byRank(a: Ranked, b: Ranked): number {
  const tier = TIER_ORDER.indexOf(a.row.tier) - TIER_ORDER.indexOf(b.row.tier);
  if (tier !== 0) return tier;
  if (a.strength !== b.strength) return b.strength - a.strength;
  return byText(a.row.entryId, b.row.entryId);
}

/** Rejects the run with an AbortError once `signal` is aborted. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('The Bedfellows run was cancelled.', 'AbortError');
  }
}

/** Every pair of `entryClaim` with a reader claim at or above the match threshold. */
function candidatesFor(entryClaim: Claim, reader: readonly Claim[]): Candidate[] {
  return reader
    .map((own) => ({
      readerSentence: own.sentence,
      entrySentence: entryClaim.sentence,
      similarity: cosine(own.vector, entryClaim.vector),
    }))
    .filter((pair) => pair.similarity >= THRESHOLDS.match);
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

/** `pair` as a reason. */
function reasonFrom(pair: Candidate, verified: boolean): Reason {
  return { entrySentence: pair.entrySentence, readerSentence: pair.readerSentence, verified };
}

/** The tier of an entry of three claims or more, by its strangeness. */
function tierByStrangeness(strangeness: number): Tier {
  if (strangeness < THRESHOLDS.strangeness.closeBelow) return 'close';
  return strangeness < THRESHOLDS.strangeness.strangeFrom ? 'middle' : 'strange';
}

/** The tier of an entry under three claims, by its reason's strength. */
function tierByStrength(strength: number): Tier {
  if (strength >= THRESHOLDS.shortEntry.close) return 'close';
  return strength >= THRESHOLDS.shortEntry.middle ? 'middle' : 'strange';
}

/** `entry`'s row against the reader's claims, or null when it stays out. */
async function place(
  entry: BedfellowsEntry,
  reader: readonly Claim[],
  models: Models,
  split: Splitter,
): Promise<Ranked | null> {
  const sentences = claimsOf([entry.title, ...split(entry.text)]);
  if (sentences.length === 0) return null;
  const vectors = await models.embedder.embed(sentences);
  const perClaim = sentences.map((sentence, i) =>
    candidatesFor({ sentence, vector: vectors[i] ?? [] }, reader),
  );
  const candidates = perClaim.flat().sort(byStrength);
  if (candidates.length === 0) return null;
  const coverage = perClaim.filter((pairs) => pairs.length > 0).length / sentences.length;
  const short = sentences.length < THRESHOLDS.shortEntry.claims;
  if (!short && coverage > THRESHOLDS.nearCopy) return null;
  const found = await reasonOf(candidates.slice(0, THRESHOLDS.judged), models.judge);
  if (found === null) return null;
  const tier = short ? tierByStrength(found.strength) : tierByStrangeness(1 - coverage);
  return { row: { entryId: entry.id, tier, reason: found.reason }, strength: found.strength };
}

/**
 * The rows Bedfellows would show `input.reader` from `input.entries`, ranked:
 * close kin first, then middle, then strange, and stronger reasons first
 * within a tier. A reader with no Documents gets none. `input.dial` is not
 * read yet (#479).
 *
 * @throws {DOMException} an AbortError, between entries, once `signal` is aborted.
 */
export async function bedfellows(
  input: BedfellowsInput,
  models: Models,
  signal?: AbortSignal,
): Promise<Row[]> {
  stopIfAborted(signal);
  const split = models.splitter ?? standInSplitter;
  const sentences = claimsOf(input.reader.flatMap((doc) => split(doc.text)));
  if (sentences.length === 0) return [];
  const vectors = await models.embedder.embed(sentences);
  const reader = sentences.map((sentence, i) => ({ sentence, vector: vectors[i] ?? [] }));
  const ranked: Ranked[] = [];
  for (const entry of [...input.entries].sort((a, b) => byText(a.id, b.id))) {
    stopIfAborted(signal);
    const row = await place(entry, reader, models, split);
    if (row !== null) ranked.push(row);
  }
  stopIfAborted(signal);
  return ranked.sort(byRank).map(({ row }) => row);
}
