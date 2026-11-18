/**
 * The term-overlap baseline (#474): #428's spike in a few lines, which every
 * later matcher in #473 has to beat. It counts shared content words between
 * the reader's sentences and the entry's, so it's blind to paraphrase and
 * stance by design; these tests pin that it is.
 */
import { describe, expect, it } from 'vitest';

import { type Entry, loadCorpus, type Reader } from './corpus';
import { harness } from './harness';
import { contentWords, sentencesOf, termOverlap } from './baseline';

function reader(...texts: string[]): Reader {
  return {
    id: 'r',
    split: 'tune',
    community: 'a test',
    documents: texts.map((text, i) => ({ title: `Doc ${String(i + 1)}`, text })),
  };
}

function entry(title: string, text: string): Entry {
  return { id: 'e', split: 'tune', title, text, hostile: false, publisher: 'g', subject: 'parks' };
}

describe('sentencesOf (#474)', () => {
  it('cuts on sentence punctuation and paragraph breaks, and drops blanks', () => {
    expect(sentencesOf('One thing. Two things!\n\nThree?  Four')).toEqual([
      'One thing.',
      'Two things!',
      'Three?',
      'Four',
    ]);
    expect(sentencesOf('   ')).toEqual([]);
  });
});

describe('contentWords (#474)', () => {
  it('lowercases, drops common words and very short ones, and keeps each word once', () => {
    expect(contentWords('The Library is OPEN, and the library is ours to run.')).toEqual(
      new Set(['library', 'open', 'run']),
    );
  });
});

describe('termOverlap (#474)', () => {
  it('calls two sentences sharing two content words common ground', () => {
    const verdict = termOverlap(
      reader('We keep the library open on Sundays.'),
      entry(
        'Sundays',
        'Our library should open every Sunday morning, open to all, with tea, board games and a story corner for toddlers.',
      ),
    );
    expect(verdict).toBe('common-ground');
  });

  it('calls one shared content word a shared subject', () => {
    expect(
      termOverlap(reader('Deer need quiet woods.'), entry('News', 'Deer counts are up.')),
    ).toBe('shared-subject');
  });

  it('misses paraphrase: a reading room and a library share no word', () => {
    expect(
      termOverlap(
        reader('We run a reading room for the street.'),
        entry('Books', 'Fund the library.'),
      ),
    ).toBe('nothing');
  });

  it('can’t see stance: ending deer season and loving it share words', () => {
    expect(
      termOverlap(
        reader('We will end the deer season for good.'),
        entry('Opening day', 'Deer season is the best week of our year.'),
      ),
    ).toBe('common-ground');
  });

  it('leaves out a near-copy: an entry most of whose sentences the reader already wrote', () => {
    const text = 'We keep the garden weeded. We share the tools. We meet on Sundays.';
    expect(termOverlap(reader(text), entry('Our garden', text))).toBe('nothing');
  });

  it('leaves out a reworded near-copy: half its words already in one of the reader’s Documents', () => {
    expect(
      termOverlap(
        reader('Our garden is weeded every Saturday and the tools are shared by all.'),
        entry('Garden days', 'Every Saturday we weed the garden; all the tools are shared.'),
      ),
    ).toBe('nothing');
  });

  it('keeps an entry that shares one claim among new things as common ground', () => {
    expect(
      termOverlap(
        reader('We keep the garden weeded.', 'Bins go out on Monday night.'),
        entry(
          'Spring fair',
          'Stalls open at nine. Keep the garden weeded before the judges arrive. Bring cakes, raffle prizes and folding chairs.',
        ),
      ),
    ).toBe('common-ground');
  });

  it('counts the entry’s title as a sentence, and a reader with no Documents gets nothing', () => {
    expect(
      termOverlap(
        reader('Fix the streetlights quickly.'),
        entry(
          'Fix streetlights now',
          'The council meets Thursday: bring torches, petitions and neighbours.',
        ),
      ),
    ).toBe('common-ground');
    expect(termOverlap(reader(), entry('Anything', 'At all.'))).toBe('nothing');
  });
});

describe('termOverlap on the corpus’s tune split (#474)', () => {
  const corpus = loadCorpus();
  const report = harness(termOverlap, 'tune');

  /** The baseline's verdict on the named case `name`'s first tune pair. */
  function onCase(name: string): string {
    const pair = corpus.pairs.find(
      (p) => p.case === name && corpus.readers.find((r) => r.id === p.reader)?.split === 'tune',
    );
    const reader = corpus.readers.find((r) => r.id === pair?.reader);
    const found = corpus.entries.find((e) => e.id === pair?.entry);
    if (reader === undefined || found === undefined) throw new Error(`No tune pair for ${name}.`);
    return termOverlap(reader, found);
  }

  it('can’t see stance: it calls some opposed pairs common ground', () => {
    expect(report.falseAgreement).toBeGreaterThan(0);
    expect(onCase('428-deer-season')).toBe('common-ground');
    expect(onCase('irony')).toBe('common-ground');
    expect(onCase('quoted-opponent')).toBe('common-ground');
  });

  it('reproduces #428’s other failures: paraphrase missed, a word-sense trap and a passing mention taken as subjects', () => {
    expect(onCase('428-reading-room')).not.toBe('common-ground');
    expect(onCase('428-chess-boards')).toBe('shared-subject');
    expect(onCase('428-passing-mention')).toBe('shared-subject');
  });

  it('is right about common ground well under half the time, the number every later matcher must beat', () => {
    expect(report.precision).not.toBeNull();
    expect(report.precision ?? 1).toBeLessThan(0.5);
  });

  it('leaves out most near-copies', () => {
    const nearCopy = report.byKind['near-copy'];
    expect(nearCopy.nothing).toBeGreaterThan(nearCopy.pairs / 2);
  });
});
