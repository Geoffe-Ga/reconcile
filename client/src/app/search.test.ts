/**
 * Search on this device (#445): records in, ranked results out, pure. Case
 * and accents don't matter, every word must appear at the start of a word,
 * a quoted phrase matches as written, a title match ranks before a text
 * match, then newer before older, then by id.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { prepare, search, type SearchRecord, snippetFor } from './search';

/** A record of `kind` with `title` and `text`, at `at`. */
function record(
  id: string,
  title: string,
  text = '',
  at = 0,
  kind: SearchRecord['kind'] = 'section',
): SearchRecord {
  return { kind, id, title, text, from: 'Riverside Tenants', at, route: { name: 'start' } };
}

const RECORDS: readonly SearchRecord[] = [
  record('a', 'House rules', 'Quiet hours start at ten.', 1),
  record('b', 'Résumé', 'What I have done.', 2, 'personal'),
  record('c', 'Quiet hours', 'Weekends run late.', 3, 'proposal'),
  record('d', 'Bins', 'Bins go out on Tuesday. Hours vary in winter.', 4),
  record('e', 'Reconcile with Oak St', '', 5, 'group'),
];

/** The ids `query` finds, in order. */
function ids(query: string, records = RECORDS): string[] {
  return search(records, query).map((result) => result.record.id);
}

describe('search', () => {
  it('finds nothing for an empty or blank query', () => {
    expect(ids('')).toEqual([]);
    expect(ids('  \n\t')).toEqual([]);
    expect(ids('""')).toEqual([]);
  });

  it('ignores case and accents, both ways', () => {
    expect(ids('resume')).toEqual(['b']);
    expect(ids('RÉSUMÉ')).toEqual(['b']);
    expect(ids('quíet')).toEqual(['c', 'a']);
  });

  it('matches each word at the start of a word, and wants every word', () => {
    expect(ids('recon')).toEqual(['e']);
    expect(ids('econcile')).toEqual([]);
    expect(ids('quiet ten')).toEqual(['a']);
    expect(ids('quiet tuesday')).toEqual([]);
  });

  it('matches a quoted phrase as written, apart from case and accents', () => {
    expect(ids('"hours start"')).toEqual(['a']);
    expect(ids('"start hours"')).toEqual([]);
    expect(ids('“hours vary” bins')).toEqual(['d']);
  });

  it('ranks a title match first, then newer before older, then by id', () => {
    // "hours" is in c's title and in a's and d's text; d is newer than a.
    expect(ids('hours')).toEqual(['c', 'd', 'a']);
    const twins = [record('y', 'Bins', '', 7), record('x', 'Bins', '', 7)];
    expect(ids('bins', twins)).toEqual(['x', 'y']);
  });

  it('says whether the match was in the title, and marks the matched words in a one-line snippet', () => {
    const [title] = search(RECORDS, 'quiet');
    expect(title?.inTitle).toBe(true);
    const bins = record('d', 'Bins', 'Bins go out on Tuesday.\nHours vary in winter.');
    const [text] = search([bins], 'hours');
    expect(text?.inTitle).toBe(false);
    const snippet = snippetFor(bins, 'hours');
    expect(snippet.map((part) => part.text).join('')).toBe(
      'Bins go out on Tuesday. Hours vary in winter.',
    );
    expect(snippet.filter((part) => part.marked).map((part) => part.text)).toEqual(['Hours']);
  });

  it('marks accented words as written, and starts a long snippet near its first match', () => {
    const long = record('r', 'Mine', `${'Some words before. '.repeat(10)}Then the Résumé section.`);
    expect(search([long], 'resume')).toHaveLength(1);
    const snippet = snippetFor(long, 'resume');
    const shown = snippet.map((part) => part.text).join('');
    expect(shown.startsWith('…')).toBe(true);
    expect(shown).toContain('Résumé');
    expect(snippet.filter((part) => part.marked).map((part) => part.text)).toEqual(['Résumé']);
  });

  const words = fc.constantFrom(
    'quiet',
    'hours',
    'bins',
    'résumé',
    'oak',
    'start',
    'ten',
    'winter',
  );
  const anyRecord = fc
    .record({
      id: fc.uuid(),
      title: fc.array(words, { maxLength: 4 }).map((list) => list.join(' ')),
      text: fc.array(words, { maxLength: 8 }).map((list) => list.join(' ')),
      at: fc.nat(1000),
    })
    .map(({ id, title, text, at }) => record(id, title, text, at));

  it('finds the same results in the same order, however the records are held', () => {
    fc.assert(
      fc.property(fc.array(anyRecord, { maxLength: 12 }), words, (records, query) => {
        expect(ids(query, [...records].reverse())).toEqual(ids(query, records));
      }),
    );
  });

  it('finds only records that hold every word of the query', () => {
    const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    fc.assert(
      fc.property(
        fc.array(anyRecord, { maxLength: 12 }),
        fc.array(words, { minLength: 1, maxLength: 3 }),
        (records, query) => {
          for (const { record: found } of search(records, query.join(' '))) {
            for (const word of query)
              expect(fold(`${found.title} ${found.text}`)).toContain(fold(word));
          }
        },
      ),
    );
  });

  it('finds the same after the records are folded ahead of time', () => {
    const before = ids('quiet');
    prepare(RECORDS);
    expect(ids('quiet')).toEqual(before);
  });

  it('never throws', () => {
    fc.assert(
      fc.property(
        fc.array(anyRecord, { maxLength: 6 }),
        fc.string({ unit: 'binary' }),
        (records, query) => {
          expect(Array.isArray(search(records, query))).toBe(true);
        },
      ),
    );
  });
});
