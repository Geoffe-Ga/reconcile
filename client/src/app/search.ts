/**
 * Search on this device (#445; ADR-0001): records in, ranked results out,
 * with no React, no store and no network. It's a scan over what the device
 * already holds, in memory: nothing it reads or finds is written anywhere,
 * and a query never leaves the device.
 *
 * Case and accents don't matter ("resume" finds "Résumé"). Every word typed
 * must appear at the start of a word ("recon" finds "reconcile"), and a
 * phrase in double quotes matches as written. A title match ranks before a
 * text match, then newer before older, then by id, so the order is stable.
 */
import type { Route } from './router';

/** What a record is, which decides the eyebrow it's listed under. */
export type ResultKind =
  'group' | 'coalition' | 'document' | 'section' | 'proposal' | 'dispatch' | 'personal' | 'place';

/** One thing search can find. */
export interface SearchRecord {
  readonly kind: ResultKind;
  /** Unique among the records, and what ties break on. */
  readonly id: string;
  readonly title: string;
  /** Its body, or "" for none. */
  readonly text: string;
  /** Where it's from, as its row says: a group's or coalition's name, or "" for the app's own places. */
  readonly from: string;
  /** How new it is, in any one clock for all records: newer ranks first. */
  readonly at: number;
  /** Where opening it goes. */
  readonly route: Route;
}

/** A piece of a snippet: marked when it's a word the query matched. */
export interface SnippetPart {
  readonly text: string;
  readonly marked: boolean;
}

/** A record the query found. */
export interface SearchResult {
  readonly record: SearchRecord;
  /** Whether every term matched in the title alone. */
  readonly inTitle: boolean;
  /** One line of the record's text, near its first match, with the matched words marked; empty for none. */
  readonly snippet: readonly SnippetPart[];
}

/** Text folded for matching, and for each of its code units the original index it came from. */
interface Folded {
  readonly text: string;
  readonly from: readonly number[];
}

/** `char` with its accents taken off and its case folded. */
function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** `text` folded, a character at a time, so each folded unit maps back to where it came from. */
function folded(text: string): Folded {
  let out = '';
  const from: number[] = [];
  let index = 0;
  for (const char of text) {
    const fold = foldChar(char);
    out += fold;
    for (let unit = 0; unit < fold.length; unit += 1) from.push(index);
    index += char.length;
  }
  return { text: out, from };
}

/** Quoted phrases: straight or curly quotes, the closing one optional while typing. */
const PHRASE = /["“”]([^"“”]*)["“”]?/gu;

/** The query's terms, folded: each quoted phrase, then each word outside quotes. */
function termsOf(query: string): string[] {
  const phrases: string[] = [];
  const rest = query.replace(PHRASE, (_whole, phrase: string) => {
    const words = folded(phrase)
      .text.split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== '');
    if (words.length > 0) phrases.push(words.join(' '));
    return ' ';
  });
  const words = folded(rest).text.split(/[^\p{L}\p{N}]+/u);
  return [...phrases, ...words.filter((word) => word !== '')];
}

/** `text` safe inside a regular expression. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A term as a pattern that matches at the start of a word, its words apart by any space. */
function patternOf(term: string): RegExp {
  const body = term.split(' ').map(escaped).join('[^\\p{L}\\p{N}]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}`, 'gu');
}

/** Whether `pattern` matches anywhere in `text`. */
function holds(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** Each record's folded title and one-line text, kept while the record object lives. */
const FOLDED = new WeakMap<SearchRecord, { title: Folded; line: string; text: Folded }>();

/** `record`'s folded title and text, folded once. */
function foldedOf(record: SearchRecord) {
  let cached = FOLDED.get(record);
  if (cached === undefined) {
    // Each space, tab or line break becomes one space, so the snippet stays one line and maps one to one.
    const line = record.text.replace(/\s/gu, ' ');
    cached = { title: folded(record.title), line, text: folded(line) };
    FOLDED.set(record, cached);
  }
  return cached;
}

/** The longest snippet, in code units, and how much of it comes before the first match. */
const SNIPPET_MAX = 140;
const SNIPPET_LEAD = 40;

/** The original ranges in `line` that `patterns` matched in its folding, each widened to whole words. */
function markedRanges(line: string, fold: Folded, patterns: readonly RegExp[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of fold.text.matchAll(pattern)) {
      const start = fold.from[match.index] ?? 0;
      let end = (fold.from[match.index + match[0].length - 1] ?? start) + 1;
      while (end < line.length && /[\p{L}\p{N}\p{M}]/u.test(line.charAt(end))) end += 1;
      ranges.push([start, end]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Where a snippet of `line` starts and ends: near `first`, cut at spaces, at most {@link SNIPPET_MAX} long. */
function windowOf(line: string, first: number): [number, number] {
  if (line.length <= SNIPPET_MAX) return [0, line.length];
  let start = Math.max(0, first - SNIPPET_LEAD);
  if (start > 0) start = line.indexOf(' ', start) + 1 || start;
  let end = Math.min(line.length, start + SNIPPET_MAX);
  if (end < line.length)
    end = line.lastIndexOf(' ', end) > start ? line.lastIndexOf(' ', end) : end;
  return [start, end];
}

/** `line` from `start` to `end`, split so each range in `ranges` is its own marked part. */
function partsOf(
  line: string,
  ranges: readonly [number, number][],
  [start, end]: [number, number],
): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = start;
  for (const [from, to] of ranges) {
    if (to <= start || from >= end) continue;
    if (from > at) parts.push({ text: line.slice(at, from), marked: false });
    parts.push({ text: line.slice(Math.max(from, at), Math.min(to, end)), marked: true });
    at = Math.min(to, end);
  }
  if (at < end) parts.push({ text: line.slice(at, end), marked: false });
  return parts;
}

/** One line of `record`'s text near its first match, its matched words marked, "…" where it's cut. */
function snippetOf(record: SearchRecord, patterns: readonly RegExp[]): SnippetPart[] {
  const { line, text } = foldedOf(record);
  if (line.trim() === '') return [];
  const ranges = markedRanges(line, text, patterns);
  const [start, end] = windowOf(line, ranges[0]?.[0] ?? 0);
  const cut = { text: '…', marked: false };
  return [
    ...(start > 0 ? [cut] : []),
    ...partsOf(line, ranges, [start, end]),
    ...(end < line.length ? [cut] : []),
  ];
}

/** Title matches first, then newer before older, then by id. */
function ranked(a: SearchResult, b: SearchResult): number {
  if (a.inTitle !== b.inTitle) return a.inTitle ? -1 : 1;
  if (a.record.at !== b.record.at) return b.record.at - a.record.at;
  return a.record.id < b.record.id ? -1 : Number(a.record.id > b.record.id);
}

/** The records `query` finds, ranked; none for a blank query. It never throws. */
export function search(records: readonly SearchRecord[], query: string): SearchResult[] {
  const patterns = termsOf(query).map(patternOf);
  if (patterns.length === 0) return [];
  const results: SearchResult[] = [];
  for (const record of records) {
    const { title, text } = foldedOf(record);
    // A NUL between them, so no phrase runs from the title into the text.
    const both = `${title.text}\u0000${text.text}`;
    if (!patterns.every((pattern) => holds(pattern, both))) continue;
    const inTitle = patterns.every((pattern) => holds(pattern, title.text));
    results.push({ record, inTitle, snippet: snippetOf(record, patterns) });
  }
  return results.sort(ranked);
}
