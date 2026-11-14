/**
 * Kinship (#428, ADR-0077 §4): how much a shelf entry shares with a reader's own writing,
 * scored on the device, and the middle band that Bedfellows would show.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SAMPLE_ENTRIES, SAMPLE_READERS, type SampleKin } from '../test/kinshipSamples';
import {
  inBand,
  type Kinship,
  KINSHIP_BAND,
  KINSHIP_METHOD,
  kinship,
  type KinshipMethod,
  type KinshipText,
  pickBand,
  readerOf,
  stem,
} from './kinship';

/** A text with the title left empty, for examples about the words alone. */
function words(text: string): KinshipText {
  return { title: '', text };
}

/** The kinship of `entry` with a reader who wrote `documents`, by `method`. */
function kinOf(
  documents: readonly KinshipText[],
  entry: KinshipText,
  method: KinshipMethod = KINSHIP_METHOD,
): Kinship {
  return kinship(readerOf(documents, method), entry);
}

/** Words only, no stemming and no phrases: the plainest method, for exact scores. */
const PLAIN: KinshipMethod = { stem: false, phraseWeight: 0 };

describe('stem', () => {
  it.each([
    ['libraries', 'library'],
    ['families', 'family'],
    ['taxes', 'tax'],
    ['buses', 'bus'],
    ['houses', 'hous'],
    ['house', 'hous'],
    ['housing', 'hous'],
    ['trees', 'tre'],
    ['heroes', 'hero'],
    ['schools', 'school'],
    ['tracking', 'track'],
    ['running', 'run'],
    ['planned', 'plan'],
    ['closed', 'clos'],
    ['closing', 'clos'],
    ['close', 'clos'],
    ['opposed', 'oppos'],
    ['falling', 'fall'],
    ['added', 'add'],
  ])('folds %s to %s', (word, folded) => {
    expect(stem(word)).toBe(folded);
  });

  it.each(['bus', 'glass', 'gas', 'need', 'agreed', 'string', 'sing', 'shed', 'one'])(
    'leaves %s alone',
    (word) => {
      expect(stem(word)).toBe(word);
    },
  );

  it('folds the forms of one word to one stem', () => {
    for (const forms of [
      ['library', 'libraries'],
      ['tax', 'taxes'],
      ['close', 'closes', 'closed', 'closing'],
      ['oppose', 'opposes', 'opposed', 'opposing'],
      ['plan', 'plans', 'planned', 'planning'],
      ['donate', 'donated', 'donates'],
    ]) {
      expect(new Set(forms.map(stem)).size).toBe(1);
    }
  });
});

describe('kinship: which words count', () => {
  it('scores the share of the entry’s terms that the reader’s Document also has', () => {
    const found = kinOf([words('library trout')], words('library budget tenant rifle'), PLAIN);
    expect(found).toEqual({ score: 0.25, shared: ['library'] });
  });

  it('never counts stop words, numbers or words under three letters', () => {
    const reader = [words('The 30 of us, and our ox, go to it in 2026.')];
    expect(kinOf(reader, words('The 30 of us and our ox go to it in 2026'))).toEqual({
      score: 0,
      shared: [],
    });
  });

  it('reads words with their letters and marks, in any case, after NFC', () => {
    const reader = [words('CAFÉ библиотека niño')];
    expect(kinOf(reader, words('café Библиотека niño'), PLAIN)).toEqual({
      score: 1,
      shared: ['café', 'библиотека', 'niño'],
    });
  });

  it('drops a possessive and other apostrophes, straight or curly', () => {
    expect(kinOf([words('the plant')], words('the plant’s ash'), PLAIN).shared).toEqual(['plant']);
    expect(kinOf([words('rock and roll')], words('rock’n’roll'), PLAIN).shared).toEqual([]);
    expect(kinOf([words('rocknroll')], words("rock'n'roll"), PLAIN).shared).toEqual(['rocknroll']);
  });

  it('matches the forms of a word only when stemming is on', () => {
    const reader = [words('No school should track children.')];
    const entry = words('No tracking apps in schools.');
    expect(kinOf(reader, entry, { stem: true, phraseWeight: 0 }).shared).toEqual([
      'tracking',
      'schools',
    ]);
    expect(kinOf(reader, entry, PLAIN).shared).toEqual([]);
  });

  it('scores the entry’s title with its text', () => {
    const found = kinOf([words('library')], { title: 'Library', text: 'budget' }, PLAIN);
    expect(found).toEqual({ score: 0.5, shared: ['library'] });
  });

  it('never scores the names of the levels that published an entry', () => {
    const entry = { title: 'Choir', text: 'concert', levels: ['Library Friends'] };
    expect(kinOf([words('library friends')], entry)).toEqual({ score: 0, shared: [] });
  });
});

describe('kinship: phrases', () => {
  it('counts a phrase both texts use at its weight, beside its two words', () => {
    const reader = [words('the coal plant has to close')];
    const entry = words('coal plant, river');
    // Terms: coal 1, plant 1, "coal plant" 2, river 1; the reader has all but river.
    expect(kinOf(reader, entry, { stem: false, phraseWeight: 2 })).toEqual({
      score: 0.8,
      shared: ['coal plant'],
    });
    expect(kinOf(reader, entry, { stem: false, phraseWeight: 0 })).toEqual({
      score: 2 / 3,
      shared: ['coal', 'plant'],
    });
  });

  it('makes a phrase only of words side by side, across a hyphen but no other break', () => {
    const phrase = { stem: false, phraseWeight: 1 };
    const reader = [words('night shift; coal plant; okker river; feedlot runoff; rent unit')];
    expect(kinOf(reader, words('a night-shift'), phrase).shared).toEqual(['night shift']);
    for (const apart of [
      'coal, plant',
      'coal and plant',
      'okker 9 river',
      'feedlot\nrunoff',
      'rent**unit',
    ]) {
      expect(kinOf(reader, words(apart), phrase).shared).toHaveLength(2);
    }
    expect(kinOf(reader, { title: 'coal', text: 'plant' }, phrase).shared).toEqual([
      'coal',
      'plant',
    ]);
  });

  it('names a shared phrase in place of its words, in the order the entry uses them', () => {
    const reader = [words('trout, feedlot runoff and the Okker River')];
    const entry = { title: 'Clean the Okker River', text: 'Feedlot runoff killed the trout.' };
    expect(kinOf(reader, entry).shared).toEqual(['okker river', 'feedlot runoff', 'trout']);
  });

  it('names a word as the entry writes it', () => {
    expect(kinOf([words('library')], words('Libraries')).shared).toEqual(['libraries']);
  });
});

describe('kinship: the reader’s Documents', () => {
  it('scores against the one Document the entry most resembles, not all of them pooled', () => {
    const reader = [words('library trout'), words('budget tenant'), words('rifle')];
    expect(kinOf(reader, words('library budget tenant rifle'), PLAIN)).toEqual({
      score: 0.5,
      shared: ['budget', 'tenant'],
    });
  });

  it('breaks a tie between Documents the same way whatever their order', () => {
    const reader = [words('plant'), words('coal')];
    const entry = words('coal plant river');
    const found = kinOf(reader, entry, PLAIN);
    expect(found).toEqual({ score: 1 / 3, shared: ['coal'] });
    expect(kinOf([...reader].reverse(), entry, PLAIN)).toEqual(found);
  });

  it('scores 0 for a reader with no Documents, and for an entry with no terms', () => {
    expect(kinOf([], words('library'))).toEqual({ score: 0, shared: [] });
    expect(kinOf([words('library')], words('the and of'))).toEqual({ score: 0, shared: [] });
  });

  it('refuses a phrase weight that is negative or not a number', () => {
    for (const phraseWeight of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => readerOf([], { stem: true, phraseWeight })).toThrow(RangeError);
    }
  });
});

describe('the band', () => {
  const found = (score: number): Kinship => ({ score, shared: [] });

  it('takes a score from low up to, but not including, high', () => {
    const band = { low: 0.2, high: 0.5 };
    expect([0.19, 0.2, 0.49, 0.5].map((score) => inBand(found(score), band))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it('picks the scored entries in the band, keeping their order', () => {
    const scored = [0.1, 0.3, 0.9, 0.2, 0].map((score, id) => ({ id, kinship: found(score) }));
    expect(pickBand(scored, { low: 0.2, high: 0.5 }).map(({ id }) => id)).toEqual([1, 3]);
  });

  it('uses the default band when given none', () => {
    const scored = [{ kinship: found(KINSHIP_BAND.low) }, { kinship: found(KINSHIP_BAND.high) }];
    expect(pickBand(scored)).toEqual([scored[0]]);
    expect(inBand(found(KINSHIP_BAND.low))).toBe(true);
  });

  it('refuses a band that is empty, upside down, or outside 0 to 1', () => {
    for (const band of [
      { low: 0.5, high: 0.5 },
      { low: 0.6, high: 0.4 },
      { low: -0.1, high: 0.5 },
      { low: 0.1, high: 1.1 },
      { low: Number.NaN, high: 0.5 },
    ]) {
      expect(() => inBand(found(0.3), band)).toThrow(RangeError);
      expect(() => pickBand([], band)).toThrow(RangeError);
    }
  });

  it('defaults to a middle band, for the founder to replace', () => {
    expect(KINSHIP_BAND.low).toBeGreaterThan(0);
    expect(KINSHIP_BAND.high).toBeLessThan(1);
  });
});

/** Content words that no two share a stem, and that are no stop words. */
const POOL = ['library', 'libraries', 'river', 'tenant', 'tenants', 'rifle', 'budget', 'draft'];
/** Words and marks that never count, so properties meet them too. */
const NOISE = ['the', 'and', 'our', '2026', ',', '.', '-'];

const textArb = fc
  .array(fc.constantFrom(...POOL, ...NOISE), { maxLength: 16 })
  .map((parts) => parts.join(' '));
const documentArb = fc.record({ title: textArb, text: textArb });
const methodArb = fc.record({
  stem: fc.boolean(),
  phraseWeight: fc.constantFrom(0, 0.5, 1, 2, 3),
});

/**
 * Two alphabets with no letter in common. Words made from one never share a stem with
 * words made from the other: no stemming rule applies to either, since each lacks the
 * letters of every ending ("s" in the first, "e" and "i" in the second).
 */
const READER_LETTERS = ['a', 'b', 'c', 'd', 'm'];
const ENTRY_LETTERS = ['n', 'p', 'r', 't', 'w'];

/** A word of three to eight letters drawn from `letters` alone. */
const wordFrom = (letters: readonly string[]) =>
  fc.string({ unit: fc.constantFrom(...letters), minLength: 3, maxLength: 8 });
/** Text of words from `letters`, with noise that never counts. */
const textFrom = (letters: readonly string[]) =>
  fc
    .array(fc.oneof(wordFrom(letters), fc.constantFrom(...NOISE)), { maxLength: 16 })
    .map((parts) => parts.join(' '));

describe('kinship properties', () => {
  it('doesn’t depend on the order of the reader’s Documents', () => {
    const shuffled = fc.array(documentArb, { maxLength: 6 }).chain((documents) =>
      fc.tuple(
        fc.constant(documents),
        fc.shuffledSubarray(documents, {
          minLength: documents.length,
          maxLength: documents.length,
        }),
      ),
    );
    fc.assert(
      fc.property(shuffled, documentArb, methodArb, ([documents, reordered], entry, method) => {
        expect(kinOf(reordered, entry, method)).toEqual(kinOf(documents, entry, method));
      }),
    );
  });

  it('is deterministic: the same writing and entry always give the same kinship', () => {
    fc.assert(
      fc.property(fc.array(documentArb, { maxLength: 4 }), documentArb, (documents, entry) => {
        expect(kinOf(structuredClone(documents), structuredClone(entry))).toEqual(
          kinOf(documents, entry),
        );
      }),
    );
  });

  it('scores an entry identical to one of the reader’s Documents 1, and nothing higher', () => {
    const withAWord = fc
      .tuple(documentArb, fc.constantFrom(...POOL))
      .map(([document, word]) => ({ ...document, text: `${document.text} ${word}` }));
    fc.assert(
      fc.property(
        fc.array(documentArb, { maxLength: 4 }),
        withAWord,
        fc.array(documentArb, { maxLength: 4 }),
        methodArb,
        (others, document, entries, method) => {
          const reader = readerOf([...others, document], method);
          expect(kinship(reader, { ...document }).score).toBe(1);
          for (const entry of entries) {
            const { score } = kinship(reader, entry);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });

  it('scores 0, naming nothing, for an entry that shares no term with the reader', () => {
    const reader = fc.array(
      fc.record({ title: textFrom(READER_LETTERS), text: textFrom(READER_LETTERS) }),
      {
        maxLength: 4,
      },
    );
    const entry = fc.record({ title: textFrom(ENTRY_LETTERS), text: textFrom(ENTRY_LETTERS) });
    fc.assert(
      fc.property(reader, entry, methodArb, (documents, unrelated, method) => {
        expect(kinOf(documents, unrelated, method)).toEqual({ score: 0, shared: [] });
      }),
    );
  });

  it('takes a score into the band exactly when low ≤ score < high', () => {
    const bandArb = fc
      .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
      .filter(([a, b]) => a !== b)
      .map(([a, b]) => ({ low: Math.min(a, b), high: Math.max(a, b) }));
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), bandArb, (score, band) => {
        expect(inBand({ score, shared: [] }, band)).toBe(band.low <= score && score < band.high);
      }),
    );
  });
});

/** Every sample reader against every sample entry, with the kin a person gave the pair. */
const PAIRS = SAMPLE_READERS.flatMap((reader) => {
  const prepared = readerOf(reader.documents);
  return SAMPLE_ENTRIES.map((entry) => ({
    pair: `${reader.id} × ${entry.id}`,
    kin: entry.kin[reader.id] ?? ('none' as const),
    found: kinship(prepared, entry),
  }));
});

/** The pairs a person marked `kin`. */
function pairsMarked(kin: SampleKin | 'none') {
  return PAIRS.filter((pair) => pair.kin === kin);
}

describe('the default method and band on the sample writing', () => {
  it('has samples of every kind', () => {
    for (const kin of ['near', 'one', 'none', 'unseen', 'opposed', 'passing'] as const) {
      expect(pairsMarked(kin).length, kin).toBeGreaterThan(0);
    }
    for (const { text } of SAMPLE_ENTRIES) expect(text.length).toBeLessThanOrEqual(500);
  });

  it('surfaces every pair that shares one thing', () => {
    for (const { pair, found } of pairsMarked('one')) expect(inBand(found), pair).toBe(true);
  });

  it('leaves out the near copies, above the band', () => {
    for (const { pair, found } of pairsMarked('near')) {
      expect(found.score, pair).toBeGreaterThanOrEqual(KINSHIP_BAND.high);
    }
  });

  it('leaves out the unrelated, below the band', () => {
    for (const { pair, found } of pairsMarked('none')) {
      expect(found.score, pair).toBeLessThan(KINSHIP_BAND.low);
    }
  });

  it('can’t see one thing said in other words: it falls below the band', () => {
    for (const { pair, found } of pairsMarked('unseen')) {
      expect(found.score, pair).toBeLessThan(KINSHIP_BAND.low);
    }
  });

  it('leaves out one thing mentioned only in passing, though it shares a phrase', () => {
    for (const { pair, found } of pairsMarked('passing')) {
      expect(found.score, pair).toBeLessThan(KINSHIP_BAND.low);
      expect(
        found.shared.some((term) => term.includes(' ')),
        pair,
      ).toBe(true);
    }
  });

  it('can’t tell agreeing from taking the other side: an opposed pair lands in the band', () => {
    for (const { pair, found } of pairsMarked('opposed')) expect(inBand(found), pair).toBe(true);
  });

  it('says in words what each surfaced pair shares', () => {
    const shared = (pair: string) => PAIRS.find((each) => each.pair === pair)?.found.shared;
    expect(shared('wren × branch-library')).toEqual(
      expect.arrayContaining(['public library', 'books', 'families']),
    );
    expect(shared('pell × clean-river')).toEqual(
      expect.arrayContaining(['okker river', 'feedlot runoff', 'trout']),
    );
    expect(shared('sol × no-tracking')).toEqual(
      expect.arrayContaining(['tracking', 'schools', 'company']),
    );
    expect(shared('ash × late-buses')).toEqual(expect.arrayContaining(['buses', 'late', 'night']));
  });
});
