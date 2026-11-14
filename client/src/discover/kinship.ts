/**
 * Kinship (#428, ADR-0077 §4): how much a shelf entry shares with a reader's own
 * writing, so Discover's Bedfellows view can show entries from groups that share
 * something with the reader but not everything.
 *
 * It runs on the device and nowhere else (ADR-0001). It reads the reader's personal
 * Documents and their groups' Documents as plain text, and a shelf entry's title and
 * words. It never reads the names of the levels that published an entry, and never a
 * vote, a membership or a follow. It sends nothing, stores nothing and keeps nothing
 * between calls, so no likeness between groups is ever written down: a score lives
 * only as long as the screen that asked for it.
 *
 * The method is plain term overlap. The spike in #428 compared it with exact words
 * alone and with stemmed words alone, on invented sample writing:
 * - A text becomes terms. Its title and its text are read apart, each in lower case
 *   after NFC. Stop words ({@link STOP_WORDS}), numbers and words under three letters
 *   drop out, and each word left folds to a light English stem ({@link stem}). Two
 *   words side by side, with nothing but space or a hyphen between them, also make a
 *   phrase.
 * - An entry's score against one Document is the share of the entry's terms that the
 *   Document also has. A word weighs 1 and a phrase `phraseWeight`, so a phrase both
 *   use counts for more than its two words apart. 1 means the Document says everything
 *   the entry says; 0 means they share nothing.
 * - The entry's kinship with the reader is its score against the one Document it
 *   resembles most, so writing more never makes an entry look closer than its closest
 *   match does.
 *
 * What it can't see: the same idea in other words ("reading room" for "library"),
 * agreement from disagreement on a shared subject, which sense a word has ("boards" in
 * a chess park and a housing board), and words in a script written without spaces.
 */
import { codePointLength } from '../engine/text';
import { STOP_WORDS } from './stopWords';

/** A text kinship reads: a Document's, or a shelf entry's, title and words. */
export interface KinshipText {
  readonly title: string;
  readonly text: string;
}

/** How a text becomes terms. Tunable (ADR-0077 §4); {@link KINSHIP_METHOD} is the default. */
export interface KinshipMethod {
  /** Whether a word's English endings fold away first, so "libraries" meets "library". */
  readonly stem: boolean;
  /** What a phrase both texts use weighs beside its two words, from 0 (no phrases) up. */
  readonly phraseWeight: number;
}

/** The method the spike recommends (#428): stemmed words, and phrases at twice a word. */
export const KINSHIP_METHOD: KinshipMethod = Object.freeze({ stem: true, phraseWeight: 2 });

/** What an entry shares with a reader's writing. */
export interface Kinship {
  /** From 0, nothing shared, to 1, everything the entry says one of the reader's Documents says too. */
  readonly score: number;
  /** The entry's own words and phrases behind the score, in the order the entry first uses them. */
  readonly shared: readonly string[];
}

/** A reader's writing, read into terms once, so many entries can be scored against it. */
export interface KinshipReader {
  readonly method: KinshipMethod;
  /** Each of the reader's Documents as the set of its terms. */
  readonly documents: readonly ReadonlySet<string>[];
}

/** The middle band of kinship Bedfellows shows: scores from `low` up to, not including, `high`. */
export interface KinshipBand {
  readonly low: number;
  readonly high: number;
}

/**
 * The first default band, from the spike's sample writing (#428): an entry must share
 * at least about a ninth of what it says with one of the reader's Documents, and less
 * than half. The founder's pick, once recorded in ADR-0077 §4, replaces it.
 */
export const KINSHIP_BAND: KinshipBand = Object.freeze({ low: 0.11, high: 0.5 });

/** A word or one mark that breaks a phrase: anything but a space, a hyphen or an apostrophe. */
const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[\n\r]|[^\s\p{L}\p{M}\p{N}'’-]/gu;
const LETTER = /\p{L}/u;
const POSSESSIVE = /['’]s$/u;
const APOSTROPHES = /['’]/gu;
/** The fewest code points a word needs to count. */
const MIN_LENGTH = 3;

/** One word that counts: its stem, and the word as the text writes it, in lower case. */
interface Word {
  readonly key: string;
  readonly surface: string;
}

/** A word or a phrase, with its weight and the stems it is made of. */
interface Term extends Word {
  readonly weight: number;
  readonly parts: readonly string[];
}

const NOTHING: Kinship = Object.freeze({ score: 0, shared: Object.freeze([]) });

/** Rejects a method whose phrase weight is negative or not a finite number. */
function checkMethod({ phraseWeight }: KinshipMethod): void {
  if (!(Number.isFinite(phraseWeight) && phraseWeight >= 0)) {
    throw new RangeError(`A phrase weighs 0 or more, not ${String(phraseWeight)}`);
  }
}

/** Rejects a band that is empty, upside down, or reaches outside 0 to 1. */
function checkBand({ low, high }: KinshipBand): void {
  if (!(low >= 0 && low < high && high <= 1)) {
    throw new RangeError(
      `A band runs from low up to a higher high, within 0 to 1, not ${String(low)} to ${String(high)}`,
    );
  }
}

/** Drops a plural ending, by Harman's S-stemmer: "libraries" to "library", "taxes" to "taxe". */
function withoutPlural(word: string): string {
  if (word.length > 4 && /[^ae]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /[^aeo]es$/.test(word)) return word.slice(0, -1);
  if (word.length > 3 && /[^us]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Drops one of a doubled final consonant ("runn" to "run"), but never l, s or z ("fall"). */
function undoubled(word: string): string {
  return word.length > 3 && /([bcdfghjkmnpqrtvwx])\1$/.test(word) ? word.slice(0, -1) : word;
}

/** Drops an "-ing" or "-ed" ending when what is left has a vowel and three letters or more. */
function withoutEnding(word: string): string {
  if (word.length >= 6 && word.endsWith('ing') && /[aeiouy]/.test(word.slice(0, -3))) {
    return undoubled(word.slice(0, -3));
  }
  if (word.length >= 5 && /[^e]ed$/.test(word) && /[aeiouy]/.test(word.slice(0, -2))) {
    return undoubled(word.slice(0, -2));
  }
  return word;
}

/**
 * Folds a lower-case word to a light English stem, so the forms of one word meet:
 * a plural ending goes, then an "-ing" or "-ed", then a final "e" ("close", "closes",
 * "closed" and "closing" all become "clos"). Words in other languages pass mostly
 * untouched, and both sides of a comparison fold alike.
 */
export function stem(word: string): string {
  const stripped = withoutEnding(withoutPlural(word));
  return stripped.length > 3 && stripped.endsWith('e') ? stripped.slice(0, -1) : stripped;
}

/** The word a token makes, or undefined for a stop word, a number, a short word or a break. */
function wordOf(token: string, method: KinshipMethod): Word | undefined {
  const surface = token.replace(POSSESSIVE, '').replace(APOSTROPHES, '');
  if (codePointLength(surface) < MIN_LENGTH || !LETTER.test(surface) || STOP_WORDS.has(surface)) {
    return undefined;
  }
  return { key: method.stem ? stem(surface) : surface, surface };
}

/** Keeps `term` unless the text already used it, so each term keeps its first place. */
function keep(terms: Map<string, Term>, term: Term): void {
  if (!terms.has(term.key)) terms.set(term.key, term);
}

/** The terms of one run of text: its words, and each pair side by side as a phrase. */
function readPart(part: string, method: KinshipMethod, terms: Map<string, Term>): void {
  let previous: Word | undefined;
  for (const [token] of part.toLowerCase().normalize('NFC').matchAll(TOKEN)) {
    const word = wordOf(token, method);
    if (word !== undefined) {
      keep(terms, { ...word, weight: 1, parts: [word.key] });
      if (previous !== undefined && method.phraseWeight > 0) {
        keep(terms, {
          key: `${previous.key} ${word.key}`,
          surface: `${previous.surface} ${word.surface}`,
          weight: method.phraseWeight,
          parts: [previous.key, word.key],
        });
      }
    }
    previous = word;
  }
}

/** A text's terms in the order it first uses them: its title's, then its text's. */
function termsOf({ title, text }: KinshipText, method: KinshipMethod): Term[] {
  const terms = new Map<string, Term>();
  readPart(title, method, terms);
  readPart(text, method, terms);
  return [...terms.values()];
}

/** What `terms` weigh together. */
function weightOf(terms: readonly Term[]): number {
  return terms.reduce((sum, term) => sum + term.weight, 0);
}

/** The shared terms in words: each phrase, and each word no shared phrase already names. */
function explain(shared: readonly Term[]): string[] {
  const phrased = new Set(shared.flatMap((term) => (term.parts.length > 1 ? term.parts : [])));
  return shared
    .filter((term) => term.parts.length > 1 || !phrased.has(term.key))
    .map((term) => term.surface);
}

/** The entry's kinship with one Document: the share of its terms' weight the Document has. */
function against(terms: readonly Term[], total: number, document: ReadonlySet<string>): Kinship {
  const shared = terms.filter((term) => document.has(term.key));
  return { score: weightOf(shared) / total, shared: explain(shared) };
}

/**
 * The closer of two kinships: the higher score, and on a tie the one whose shared
 * words sort first, so the reader's Documents may come in any order.
 */
function closer(a: Kinship, b: Kinship): Kinship {
  if (a.score !== b.score) return a.score > b.score ? a : b;
  return a.shared.join('\n') <= b.shared.join('\n') ? a : b;
}

/**
 * Reads a reader's writing, their personal Documents and their groups' Documents in
 * any order, into terms by `method`, once for any number of entries.
 *
 * @throws {RangeError} when `method`'s phrase weight is negative or not a finite number.
 */
export function readerOf(
  documents: readonly KinshipText[],
  method: KinshipMethod = KINSHIP_METHOD,
): KinshipReader {
  checkMethod(method);
  const fixed = Object.freeze({ stem: method.stem, phraseWeight: method.phraseWeight });
  return {
    method: fixed,
    documents: documents.map((document) => new Set(termsOf(document, fixed).map(({ key }) => key))),
  };
}

/**
 * How much `entry` shares with `reader`'s writing: its score against the reader's
 * Document it resembles most, and the words behind it. The same reader and entry
 * always give the same kinship, whatever order the reader's Documents came in.
 */
export function kinship(reader: KinshipReader, entry: KinshipText): Kinship {
  const terms = termsOf(entry, reader.method);
  const total = weightOf(terms);
  if (total === 0) return NOTHING;
  return reader.documents.reduce<Kinship>(
    (best, document) => closer(best, against(terms, total, document)),
    NOTHING,
  );
}

/**
 * Whether `found` falls in `band`: from its low up to, not including, its high.
 *
 * @throws {RangeError} when `band` is empty, upside down, or reaches outside 0 to 1.
 */
export function inBand(found: Kinship, band: KinshipBand = KINSHIP_BAND): boolean {
  checkBand(band);
  return band.low <= found.score && found.score < band.high;
}

/**
 * The scored entries whose kinship falls in `band`, in the order they came.
 *
 * @throws {RangeError} when `band` is empty, upside down, or reaches outside 0 to 1.
 */
export function pickBand<T extends { readonly kinship: Kinship }>(
  scored: readonly T[],
  band: KinshipBand = KINSHIP_BAND,
): T[] {
  checkBand(band);
  return scored.filter(({ kinship: found }) => inBand(found, band));
}
