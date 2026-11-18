/**
 * The Bedfellows splitter (#477; ADR-0080 §1): text in, claims out, one
 * sentence each. It reads plain text and the Markdown subset Atoms use
 * (ADR-0023: headings, emphasis, lists, links, block quotes and code).
 *
 * The rules, in order:
 *
 * 1. **Blocks.** A blank line ends a paragraph. A heading is a block of its
 *    own. A list item starts a block of its own, and the lines under it,
 *    until the next item or blank line, belong to it. Fenced code is skipped:
 *    it isn't a claim. A block's wrapped lines are joined with a space.
 * 2. **Marks.** Heading `#`s, list markers (`-`, `*`, `+`, `1.`, `1)`) and
 *    block-quote `>`s are dropped; a link keeps its text and drops its URL,
 *    an autolink is dropped whole, and emphasis and code marks are dropped.
 * 3. **Sentences.** Each block is cut into sentences by `Intl.Segmenter`
 *    where the browser has it (which knows "7 p.m. on" and "£3.50" aren't
 *    ends), and after `.`, `!` or `?` and a space where it doesn't.
 * 4. **Fragments.** A sentence of fewer than {@link MIN_CLAIM_WORDS} words
 *    ("Yes.", "Our aims", "We ask:") says too little to match on, and is
 *    dropped. A heading or list item long enough is a claim like any other.
 *
 * An entry's title always counts as a claim, however short ({@link claimsIn}).
 */
import type { Splitter } from './types';

/** A sentence needs at least this many words to be a claim. */
export const MIN_CLAIM_WORDS = 3;

/** A code fence's opening or closing line. */
const FENCE = /^ {0,3}(?:```|~~~)/u;
/** A heading, its text in group 1. */
const HEADING = /^ {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/u;
/** A list item, its text in group 1. */
const ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+(.*)$/u;
/** A block quote's marks at the start of a line. */
const QUOTE = /^(?: {0,3}>\s?)+/u;

/** A word: letters or digits, with an apostrophe inside it allowed. */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** `text`'s lines, each fenced code block and its fences turned into one blank line. */
function linesOutsideCode(text: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      lines.push('');
    } else if (!fenced) {
      lines.push(line);
    }
  }
  return lines;
}

/** What a line is: a blank, a heading or list item (which start a block), or more text. */
type Line =
  | { readonly kind: 'blank' }
  | { readonly kind: 'heading' | 'item' | 'text'; readonly text: string };

/** `raw`, its block-quote marks dropped, as a {@link Line}. */
function lineOf(raw: string): Line {
  const line = raw.replace(QUOTE, '').trim();
  if (line === '') return { kind: 'blank' };
  const heading = HEADING.exec(line);
  if (heading !== null) return { kind: 'heading', text: heading[1] ?? '' };
  const item = ITEM.exec(line);
  if (item !== null) return { kind: 'item', text: item[1] ?? '' };
  return { kind: 'text', text: line };
}

/** The blocks of `text` (rule 1), each its lines' text joined, marks not yet dropped. */
function blocksOf(text: string): string[] {
  const blocks: string[][] = [[]];
  for (const line of linesOutsideCode(text).map(lineOf)) {
    if (line.kind !== 'text') blocks.push([]);
    if (line.kind === 'blank') continue;
    blocks.at(-1)?.push(line.text);
    if (line.kind === 'heading') blocks.push([]);
  }
  return blocks.filter((block) => block.length > 0).map((block) => block.join(' '));
}

/** `block` with its inline marks dropped (rule 2), and its spaces collapsed. */
function unmarked(block: string): string {
  return block
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/giu, '')
    .replace(/[*_`~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `block`'s sentences (rule 3), trimmed. */
function sentencesIn(block: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return Array.from(segmenter.segment(block), ({ segment }) => segment.trim());
  }
  return block.split(/(?<=[.!?])\s+/u).map((sentence) => sentence.trim());
}

/** How many words `sentence` holds. */
export function wordCount(sentence: string): number {
  return sentence.match(WORD)?.length ?? 0;
}

/** `text`'s claims, by the rules above. */
export const splitClaims: Splitter = (text) =>
  blocksOf(text)
    .map(unmarked)
    .flatMap(sentencesIn)
    .filter((sentence) => wordCount(sentence) >= MIN_CLAIM_WORDS);

/** An entry's claims: its title, however short, then its text's sentences, cut by `split`. */
export function claimsIn(title: string, text: string, split: Splitter = splitClaims): string[] {
  const heading = title.trim();
  return [...(heading === '' ? [] : [heading]), ...split(text)];
}
