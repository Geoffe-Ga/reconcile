/**
 * The term-overlap fallback (#477; ADR-0080 §1, §2): what the device decides
 * the model doesn't cover, and the rows term overlap gives while the model
 * hasn't loaded and for that text, every one unverified.
 */
import { describe, expect, it } from 'vitest';

import { loadCorpus } from './corpus';
import { covers, termOverlapRow } from './fallback';
import { THRESHOLDS } from './thresholds';

const CUTS = {
  ...THRESHOLDS,
  fallback: { shared: 2 },
  nearCopy: 0.8,
  strangeness: { closeBelow: 0.4, strangeFrom: 0.7 },
  shortEntry: { claims: 3, close: 0.6, middle: 0.45 },
};

describe('covers (#477)', () => {
  it('covers English prose', () => {
    expect(
      covers(
        'We want the old laundry block turned back into a reading room, with long tables and a kettle.',
        CUTS.covers,
      ),
    ).toBe(true);
  });

  it('covers every Document and entry of the corpus, which is all English', () => {
    const corpus = loadCorpus();
    const texts = [
      ...corpus.readers.flatMap((reader) => reader.documents.map((doc) => doc.text)),
      ...corpus.entries.map((entry) => `${entry.title}\n${entry.text}`),
    ];

    expect(texts.filter((text) => !covers(text, THRESHOLDS.covers))).toEqual([]);
  });

  it('covers text too short to tell, so a short English line isn’t sent to term overlap', () => {
    expect(covers('Keep the reading room open late.', CUTS.covers)).toBe(true);
    expect(covers('Bike lanes now', CUTS.covers)).toBe(true);
  });

  it('doesn’t cover Spanish, French or German prose', () => {
    expect(
      covers(
        'Queremos que la biblioteca del barrio siga abierta por las tardes y los domingos para todos los vecinos.',
        CUTS.covers,
      ),
    ).toBe(false);
    expect(
      covers(
        'Nous voulons garder la bibliothèque du quartier ouverte le soir et le dimanche pour tous les voisins.',
        CUTS.covers,
      ),
    ).toBe(false);
    expect(
      covers(
        'Wir wollen die Bibliothek im Viertel abends und sonntags für alle Nachbarn offen halten.',
        CUTS.covers,
      ),
    ).toBe(false);
  });

  it('doesn’t cover a long run of numbers, which has no letters and no English words', () => {
    expect(covers('12 14 16 18 20 22 24 26 28 30', CUTS.covers)).toBe(false);
  });

  it('doesn’t cover text mostly in a script other than Latin', () => {
    expect(
      covers(
        'Мы хотим, чтобы библиотека в нашем районе оставалась открытой по вечерам и в воскресенье.',
        CUTS.covers,
      ),
    ).toBe(false);
  });
});

describe('termOverlapRow (#477)', () => {
  const reader = ['Keep the library open on Sundays.', 'Plant more trees along the river.'];

  it('pairs claims sharing enough content words, and gives the best pair as an unverified reason', () => {
    const row = termOverlapRow(
      'e1',
      ['Library hours', 'We want the library open on Sundays too.'],
      [reader],
      CUTS,
    );

    expect(row?.row.reason).toEqual({
      entrySentence: 'We want the library open on Sundays too.',
      readerSentence: 'Keep the library open on Sundays.',
      verified: false,
    });
    expect(row?.row.entryId).toBe('e1');
  });

  it('prefers the pair sharing more words, and breaks a tie by the earlier sentence', () => {
    const row = termOverlapRow(
      'e1',
      [
        'Plant trees, more trees, along every river and canal in the county.',
        'Plant trees along the river.',
        'Keep the library open.',
        'Ducks need clean water.',
        'Bread is bad for ducks.',
        'Feed them seeds instead.',
      ],
      [reader],
      CUTS,
    );

    // Both tree sentences share four words with the reader's, all of the shorter side's: the earlier wins.
    expect(row?.row.reason.entrySentence).toBe('Plant trees along the river.');
    expect(
      termOverlapRow('e2', ['Library open, Sundays only.', 'Open library Sundays.'], [reader], CUTS)
        ?.row.reason.entrySentence,
    ).toBe('Library open, Sundays only.');
  });

  it('gives no row when no pair shares enough words, as with one shared word', () => {
    expect(termOverlapRow('e1', ['The library burned down.'], [reader], CUTS)).toBeNull();
    expect(termOverlapRow('e1', [], [reader], CUTS)).toBeNull();
  });

  it('leaves out a near-copy of three claims or more', () => {
    const copy = [
      'Keep the library open on Sundays.',
      'Plant more trees along the river.',
      'Keep the library open on Sundays please.',
    ];

    expect(termOverlapRow('e1', copy, [reader], CUTS)).toBeNull();
  });

  it('places an entry of three claims or more by strangeness', () => {
    const row = termOverlapRow(
      'e1',
      [
        'Keep the library open on Sundays.',
        'Ducks need clean water.',
        'Bread is bad for ducks.',
        'Feed them seeds instead.',
      ],
      [reader],
      CUTS,
    );

    // Coverage 1/4: strangeness 3/4.
    expect(row?.row.tier).toBe('strange');
    expect(row?.strength).toBe(1);
  });

  it('places a short entry by its pair’s share of words and its nearest Document’s', () => {
    const near = termOverlapRow('near', ['Keep the library open on Sundays.'], [reader], CUTS);
    const far = termOverlapRow(
      'far',
      ['Library Sundays: bring cake, bring songs, bring neighbours, bring chairs.'],
      [reader],
      CUTS,
    );

    expect(near?.row.tier).toBe('close');
    expect(far?.row.tier).toBe('strange');
  });
});
