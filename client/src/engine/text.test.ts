import { describe, expect, it } from 'vitest';

import { codePointLength, nfcLength, splitAtoms } from './text';

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('\u{1F600}')).toBe(1);
  });

  it('counts the string as given, without normalizing it', () => {
    expect(codePointLength('e\u0301')).toBe(2);
  });

  it('counts a lone surrogate as one code point', () => {
    expect(codePointLength('a\uD800')).toBe(2);
  });
});

describe('nfcLength', () => {
  it('counts code points after NFC, so a decomposed letter counts once', () => {
    expect(nfcLength('e\u0301')).toBe(1);
    expect(nfcLength('caf\u00e9')).toBe(4);
  });

  it('counts a combining mark that has no precomposed form', () => {
    expect(nfcLength('q\u0307')).toBe(2);
  });

  it('counts an astral character once', () => {
    expect(nfcLength('a\u{1F600}b')).toBe(3);
  });
});

describe('splitAtoms', () => {
  it('splits at a blank line', () => {
    expect(splitAtoms('First.\n\nSecond.')).toEqual(['First.', 'Second.']);
  });

  it('keeps consecutive lines together in one Atom', () => {
    expect(splitAtoms('One\nTwo\n\nThree')).toEqual(['One\nTwo', 'Three']);
  });

  it('treats several blank lines, or lines of only spaces and tabs, as one break', () => {
    expect(splitAtoms('A\n\n\n\nB\n \t \nC')).toEqual(['A', 'B', 'C']);
  });

  it('drops leading and trailing blank lines', () => {
    expect(splitAtoms('\n\n  \nA\n\n')).toEqual(['A']);
  });

  it('treats CRLF and CR as line breaks', () => {
    expect(splitAtoms('A\r\nB\r\n\r\nC\r\rD')).toEqual(['A\nB', 'C', 'D']);
  });

  it('keeps indentation inside an Atom', () => {
    expect(splitAtoms('  indented\n    more')).toEqual(['  indented\n    more']);
  });

  it('returns no Atoms for empty or blank text', () => {
    expect(splitAtoms('')).toEqual([]);
    expect(splitAtoms(' \n\t\n')).toEqual([]);
  });
});
