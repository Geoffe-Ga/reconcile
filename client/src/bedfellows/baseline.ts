/**
 * The term-overlap baseline (#474; ADR-0080 §1): #428's spike, kept to a few
 * lines so the harness has numbers to beat. ADR-0080 keeps term overlap as
 * the fallback while the model hasn't loaded; that fallback lands in #477.
 *
 * Each sentence becomes its set of content words. A reader sentence and an
 * entry sentence sharing two or more is common ground, one is a shared
 * subject (an entry's title counts as a sentence). An entry half of whose
 * content words one of the reader's Documents already holds is a near-copy:
 * it shares everything rather than something, so it's left out. Term
 * overlap can't see paraphrase, stance, word sense or idiom, which is why
 * #473 exists.
 */
import type { Entry, Reader } from './corpus';
import type { Verdict } from './harness';

/** Words too common to say what a sentence is about. */
const STOP = new Set(
  'about after again against also and any are because been before being but can could did does doing down each every few for from had has have having her here him his how into its just like more most much must not now off once only other our ours out over own same she should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would you your'.split(
    ' ',
  ),
);

/** Words shorter than this say too little. */
const MIN_LENGTH = 3;

/** Shared content words for common ground; one is a shared subject. */
const COMMON_GROUND = 2;

/**
 * An entry at least this share of whose content words one of the reader's
 * Documents already holds is a near-copy: half its words, a plain cut, not
 * one tuned on the corpus.
 */
const NEAR_COPY = 0.5;

/** `text`'s sentences: cut after `.`, `!` or `?` and at blank lines, trimmed, none empty. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n\s*\n/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/** `sentence`'s content words, lowercased, each once. */
export function contentWords(sentence: string): Set<string> {
  const words = sentence.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= MIN_LENGTH && !STOP.has(word)));
}

/** How many words `a` and `b` share. */
function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return count;
}

/** Whether one of `reader`'s Documents already holds at least half of `entry`'s content words. */
function isNearCopy(reader: Reader, entry: Entry): boolean {
  const words = contentWords(`${entry.title} ${entry.text}`);
  if (words.size === 0) return false;
  return reader.documents.some(
    (doc) => shared(words, contentWords(doc.text)) / words.size >= NEAR_COPY,
  );
}

/** The term-overlap baseline as a matcher. */
export function termOverlap(reader: Reader, entry: Entry): Verdict {
  if (isNearCopy(reader, entry)) return 'nothing';
  const mine = reader.documents.flatMap((doc) => sentencesOf(doc.text)).map(contentWords);
  const theirs = [entry.title, ...sentencesOf(entry.text)].map(contentWords);
  const best = theirs.map((words) => Math.max(0, ...mine.map((own) => shared(words, own))));
  const top = Math.max(0, ...best);
  if (top >= COMMON_GROUND) return 'common-ground';
  return top >= 1 ? 'shared-subject' : 'nothing';
}
