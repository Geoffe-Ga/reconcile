/**
 * The corpus's own rules (#474; ADR-0080 §8): at least 30 pairs of each
 * kind, with held-out pairs of each; no reader, entry, publisher or sentence
 * in both splits; every named sentence copied exactly; entries within the
 * shelf's 500 characters; and every named case from #428 and the issue in it.
 * A change to the corpus that breaks any of these fails here.
 */
import { describe, expect, it } from 'vitest';

import { sentencesOf } from './baseline';
import { loadCorpus, PAIR_KINDS } from './corpus';

const corpus = loadCorpus();
const readers = new Map(corpus.readers.map((r) => [r.id, r]));
const entries = new Map(corpus.entries.map((e) => [e.id, e]));
const publishers = new Map(corpus.publishers.map((p) => [p.id, p]));

/** All of reader `id`'s Documents, as one text. */
function readerText(id: string): string {
  return (
    readers
      .get(id)
      ?.documents.map((d) => d.text)
      .join('\n\n') ?? ''
  );
}

/** Entry `id`'s title and text, as one text. */
function entryText(id: string): string {
  const entry = entries.get(id);
  return entry === undefined ? '' : `${entry.title}\n\n${entry.text}`;
}

/** The cases the issue names, each of which must be in the corpus. */
const NAMED_CASES = [
  '428-reading-room',
  '428-deer-season',
  '428-chess-boards',
  '428-passing-mention',
  'devil-idiom',
  'irony',
  'quoted-opponent',
];

describe('the Bedfellows corpus (#474)', () => {
  it('holds about 40 readers and 300 entries, each id once', () => {
    expect(corpus.readers.length).toBeGreaterThanOrEqual(36);
    expect(corpus.entries.length).toBeGreaterThanOrEqual(280);
    for (const list of [corpus.readers, corpus.entries, corpus.publishers, corpus.pairs]) {
      expect(new Set(list.map((item) => item.id)).size).toBe(list.length);
    }
  });

  it.each(PAIR_KINDS)('has at least 30 %s pairs, and some held out', (kind) => {
    const ofKind = corpus.pairs.filter((pair) => pair.kind === kind);
    expect(ofKind.length).toBeGreaterThanOrEqual(30);
    const heldOut = ofKind.filter((pair) => readers.get(pair.reader)?.split === 'held-out');
    expect(heldOut.length).toBeGreaterThanOrEqual(10);
  });

  it('keeps every pair inside one split, and its publisher too', () => {
    for (const pair of corpus.pairs) {
      const reader = readers.get(pair.reader);
      const entry = entries.get(pair.entry);
      expect(reader, pair.id).toBeDefined();
      expect(entry, pair.id).toBeDefined();
      expect(entry?.split, pair.id).toBe(reader?.split);
    }
    for (const entry of corpus.entries) {
      expect(publishers.get(entry.publisher)?.split, entry.id).toBe(entry.split);
    }
  });

  it('puts no sentence in both splits', () => {
    const seen = new Map<string, string>();
    const texts = [
      ...corpus.readers.flatMap((r) => r.documents.map((d) => ({ split: r.split, text: d.text }))),
      ...corpus.entries.map((e) => ({ split: e.split, text: `${e.title}\n\n${e.text}` })),
    ];
    const crossing: string[] = [];
    for (const { split, text } of texts) {
      for (const sentence of sentencesOf(text)) {
        const other = seen.get(sentence);
        if (other !== undefined && other !== split) crossing.push(sentence);
        seen.set(sentence, split);
      }
    }
    expect(crossing).toEqual([]);
  });

  it('copies every named sentence exactly from its side, and names both for shared and opposed claims', () => {
    for (const pair of corpus.pairs) {
      if (pair.kind === 'shared-claim' || pair.kind === 'opposed') {
        expect(pair.readerSentence, pair.id).toBeDefined();
        expect(pair.entrySentence, pair.id).toBeDefined();
      }
      expect(readerText(pair.reader), pair.id).toContain(pair.readerSentence ?? '');
      expect(entryText(pair.entry), pair.id).toContain(pair.entrySentence ?? '');
    }
  });

  it('keeps every entry within the shelf’s 500 characters, and flags hostility apart from anger at the powerful', () => {
    for (const entry of corpus.entries)
      expect(entry.text.length, entry.id).toBeLessThanOrEqual(500);
    const hostile = corpus.entries.filter((e) => e.hostile);
    const angry = corpus.entries.filter((e) => e.angerAtPowerful === true);
    expect(hostile.length).toBeGreaterThanOrEqual(15);
    expect(angry.length).toBeGreaterThanOrEqual(15);
    expect(angry.filter((e) => e.hostile)).toEqual([]);
  });

  it.each(NAMED_CASES)('holds the named case %s', (name) => {
    expect(corpus.pairs.some((pair) => pair.case === name)).toBe(true);
  });
});
