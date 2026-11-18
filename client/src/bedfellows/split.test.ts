/**
 * The Bedfellows splitter (#477; ADR-0080 §1): plain text and the Markdown
 * subset Atoms use (ADR-0023) in, claims out, one sentence each. Its rules for
 * headings, list items, code and short fragments are pinned here one by one,
 * with `Intl.Segmenter` and without it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimsIn, MIN_CLAIM_WORDS, splitClaims } from './split';

describe('splitClaims (#477)', () => {
  it('cuts plain text into sentences, trimmed', () => {
    expect(
      splitClaims('We read together on Fridays. Everyone is welcome!  Who brings the tea?'),
    ).toEqual(['We read together on Fridays.', 'Everyone is welcome!', 'Who brings the tea?']);
  });

  it('doesn’t cut inside “p.m.” before a lowercase word, or inside a price', () => {
    expect(splitClaims('We meet at 7 p.m. on Fridays. It costs £3.50 a week.')).toEqual([
      'We meet at 7 p.m. on Fridays.',
      'It costs £3.50 a week.',
    ]);
  });

  it('treats a blank line as the end of a paragraph, even without a full stop', () => {
    expect(splitClaims('We keep the garden open\n\nThe gate stays unlocked all day')).toEqual([
      'We keep the garden open',
      'The gate stays unlocked all day',
    ]);
  });

  it('joins a paragraph’s wrapped lines into one sentence', () => {
    expect(splitClaims('We keep the garden\nopen all summer.')).toEqual([
      'We keep the garden open all summer.',
    ]);
  });

  it(`drops a fragment of fewer than ${String(MIN_CLAIM_WORDS)} words`, () => {
    expect(MIN_CLAIM_WORDS).toBe(3);
    expect(splitClaims('Yes. We agree. We keep the garden open.')).toEqual([
      'We keep the garden open.',
    ]);
  });

  it('keeps a heading as a claim of its own when it is long enough, without its marks', () => {
    expect(
      splitClaims('# Keep the library open late\nWe read here.\n\n## Aims\nNo cuts to the hours.'),
    ).toEqual(['Keep the library open late', 'We read here.', 'No cuts to the hours.']);
  });

  it('makes each list item a claim of its own, without its marker', () => {
    expect(
      splitClaims(
        'We ask:\n- Keep the library open late\n* Fund the reading room\n1. Hire two librarians\n2) Fix the roof soon',
      ),
    ).toEqual([
      'Keep the library open late',
      'Fund the reading room',
      'Hire two librarians',
      'Fix the roof soon',
    ]);
  });

  it('keeps a list item’s wrapped lines with it', () => {
    expect(splitClaims('- Keep the library\n  open late\n- Fund the room')).toEqual([
      'Keep the library open late',
      'Fund the room',
    ]);
  });

  it('reads a block quote’s words, emphasis and link text, and drops their marks and URLs', () => {
    expect(
      splitClaims(
        '> We **keep** the _garden_ open.\n\nRead [our charter](https://example.org/c) and `the rules` today. See <https://example.org>.',
      ),
    ).toEqual(['We keep the garden open.', 'Read our charter and the rules today.']);
  });

  it('skips fenced code: it isn’t a claim', () => {
    expect(splitClaims('We keep the garden open.\n```\nlet x = 1. let y = 2. z\n```')).toEqual([
      'We keep the garden open.',
    ]);
  });

  it('gives nothing for blank text', () => {
    expect(splitClaims('  \n\n ')).toEqual([]);
  });

  describe('without Intl.Segmenter', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('cuts after . ! or ? followed by a space', () => {
      vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });

      expect(
        splitClaims('We read together on Fridays. Everyone is welcome! Who brings tea?'),
      ).toEqual(['We read together on Fridays.', 'Everyone is welcome!', 'Who brings tea?']);
    });
  });
});

describe('claimsIn (#477)', () => {
  it('counts an entry’s title as a claim, however short, before its sentences', () => {
    expect(claimsIn('Bike lanes', 'Paint the lanes on Mill Road. Now.')).toEqual([
      'Bike lanes',
      'Paint the lanes on Mill Road.',
    ]);
  });

  it('gives no claim for a blank title', () => {
    expect(claimsIn('  ', 'Paint the lanes on Mill Road.')).toEqual([
      'Paint the lanes on Mill Road.',
    ]);
  });
});
