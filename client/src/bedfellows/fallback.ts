/**
 * The term-overlap fallback (#477; ADR-0080 §1, §2). #428's term overlap
 * stands in for the model in two cases, and every row it gives is
 * unverified ("You both write about this:"), since it can't see stance:
 *
 * - **while the model hasn't loaded**: the reader hasn't agreed to its
 *   download yet, or it failed to load (offline on first use, a file that
 *   doesn't match its pin), so a run has no embedder at all;
 * - **for text the model doesn't cover**, which the device decides with
 *   {@link covers}: the model is English-first (ADR-0080 §2), so a reader's
 *   Document or an entry that isn't English is matched by term overlap.
 *
 * {@link covers} reads only the text, on the device: a text is covered unless
 * it is long enough to judge (`covers.minWords` words or more) and either
 * fewer than `covers.latinShare` of its letters are Latin script, or fewer
 * than `covers.englishShare` of its words are common English function words
 * ("the", "and", "on", "we", …; ones other languages use often, such as
 * "a", "an", "no" and "die", are left out of the list). English prose runs around a
 * quarter to a half; Spanish, French and German prose almost none.
 *
 * Term overlap here is #474's baseline cut down to claims: an entry claim and
 * a reader claim sharing `fallback.shared` content words or more are a
 * candidate pair; coverage, near-copies and tiers follow the model's rules
 * (`tiers.ts`), with the share of words a pair shares as its strength.
 */
import { contentWords } from './baseline';
import { byText } from './match';
import { tierByStrangeness, type TierCuts, tierOfShortEntry } from './tiers';
import type { Row } from './types';

/** The cuts {@link covers} reads (`THRESHOLDS.covers`). */
export interface CoverCuts {
  readonly minWords: number;
  readonly latinShare: number;
  readonly englishShare: number;
}

/** The cuts {@link termOverlapRow} reads. */
export interface FallbackCuts extends TierCuts {
  readonly nearCopy: number;
  readonly fallback: { readonly shared: number };
}

/** A row and the strength of its reason, which ranks it within its tier. */
export interface RankedRow {
  readonly row: Row;
  readonly strength: number;
}

/** Common English words few other languages written in Latin script share. */
const ENGLISH = new Set(
  'the of and to in on is are was were be been it its we our us you your they their them he she his her this that these those with for from by at as or not but if so will would can could should must have has had do does there here what which who when where how all any more than into about after before over under up out off along past every each'.split(
    ' ',
  ),
);

/** `text`'s words, lowercased. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

/** The share of `text`'s letters that are Latin script; 1 with no letters. */
function latinShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 1;
  return (text.match(/\p{Script=Latin}/gu) ?? []).length / letters.length;
}

/** Whether the model covers `text`, decided on the device as the module comment says. */
export function covers(text: string, cuts: CoverCuts): boolean {
  const words = wordsOf(text);
  if (words.length < cuts.minWords) return true;
  if (latinShare(text) < cuts.latinShare) return false;
  return words.filter((word) => ENGLISH.has(word)).length / words.length >= cuts.englishShare;
}

/** A candidate pair under term overlap. */
interface WordPair {
  readonly readerSentence: string;
  readonly entrySentence: string;
  readonly shared: number;
  /** The share of the shorter sentence's content words the two share. */
  readonly strength: number;
}

/** How many words `a` and `b` share. */
function sharedWords(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return count;
}

/** More shared words first, then the higher share, then by the entry's sentence and the reader's. */
function byOverlap(a: WordPair, b: WordPair): number {
  if (a.shared !== b.shared) return b.shared - a.shared;
  if (a.strength !== b.strength) return b.strength - a.strength;
  return byText(a.entrySentence, b.entrySentence) || byText(a.readerSentence, b.readerSentence);
}

/** Every candidate pair of `entryClaim` with the reader's claims. */
function pairsOf(entryClaim: string, reader: readonly string[], cuts: FallbackCuts): WordPair[] {
  const theirs = contentWords(entryClaim);
  return reader.flatMap((readerSentence) => {
    const mine = contentWords(readerSentence);
    const shared = sharedWords(theirs, mine);
    if (shared < cuts.fallback.shared) return [];
    const strength = shared / Math.min(theirs.size, mine.size);
    return [{ readerSentence, entrySentence: entryClaim, shared, strength }];
  });
}

/** The share of `entry`'s content words the reader's nearest Document holds, 0 with none. */
function nearestByWords(
  entry: readonly string[],
  documents: readonly (readonly string[])[],
): number {
  const words = contentWords(entry.join(' '));
  if (words.size === 0) return 0;
  return Math.max(
    0,
    ...documents.map((doc) => sharedWords(words, contentWords(doc.join(' '))) / words.size),
  );
}

/**
 * Entry `entryId`'s row by term overlap, from its claims and the reader's,
 * Document by Document, or null when it stays out: no candidate pair, or a
 * near-copy of `shortEntry.claims` claims or more. Its reason is unverified.
 */
export function termOverlapRow(
  entryId: string,
  entry: readonly string[],
  documents: readonly (readonly string[])[],
  cuts: FallbackCuts,
): RankedRow | null {
  const reader = documents.flat();
  const perClaim = entry.map((claim) => pairsOf(claim, reader, cuts));
  const [best] = perClaim.flat().sort(byOverlap);
  if (best === undefined) return null;
  const coverage = perClaim.filter((pairs) => pairs.length > 0).length / entry.length;
  const short = entry.length < cuts.shortEntry.claims;
  if (!short && coverage > cuts.nearCopy) return null;
  const tier = short
    ? tierOfShortEntry(best.strength, nearestByWords(entry, documents), cuts)
    : tierByStrangeness(1 - coverage, cuts);
  return {
    row: {
      entryId,
      tier,
      reason: {
        entrySentence: best.entrySentence,
        readerSentence: best.readerSentence,
        verified: false,
      },
    },
    strength: best.strength,
  };
}
