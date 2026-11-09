/**
 * `normalizeAtomText` and the genesis split (#70): the golden vectors in
 * vectors/atom-text.json, then fast-check properties.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { genesisAtoms, normalizeAtomText } from './atomText';
import vectorText from './vectors/atom-text.json?raw';

interface NormalizeVector {
  readonly name: string;
  readonly input: string;
  readonly expect: string;
}

interface GenesisVector {
  readonly name: string;
  readonly document: string;
  readonly expect: readonly string[];
}

// Read as text and parsed with JSON.parse, as any reader would: Vite's own JSON loader
// refuses the lone-surrogate escapes these vectors need.
const { vectors, genesis } = JSON.parse(vectorText) as {
  readonly vectors: readonly NormalizeVector[];
  readonly genesis: readonly GenesisVector[];
};

const encoder = new TextEncoder();
const bytes = (text: string): number[] => Array.from(encoder.encode(text));

/** A lone surrogate: a high one not followed by a low one, or a low one not after a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Characters that stress each step: spaces, tabs and NBSP, every line ending,
 * letters with and without combining marks (precomposed and not), astral
 * characters, and lone surrogates of both halves.
 */
const piece = fc.oneof(
  fc.constantFrom(' ', '\t', '\r', '\n', '\r\n', ' ', '　'),
  fc.constantFrom('a', 'e', 'A', 'é', 'é', '́', 'Å', 'Å', 'ẛ̣'),
  fc.constantFrom('😀', '\ud800', '\udfff', '\ud83d', '#', '*', '<b>'),
  fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
);
const anyText = fc.array(piece, { maxLength: 40 }).map((pieces) => pieces.join(''));

/** One line of text with no line break in it. */
const line = fc
  .array(piece, { maxLength: 12 })
  .map((pieces) => pieces.join('').replace(/[\r\n]/g, ''));

describe('normalizeAtomText vectors', () => {
  it('cover every case the issue names', () => {
    expect(vectors.map((vector) => vector.name)).toEqual(
      expect.arrayContaining([
        'a lone CR becomes LF',
        'NFD becomes NFC',
        'a trailing NBSP stays',
        'a missing final newline is added',
        'several final newlines become one',
        'blank text becomes the empty string',
        '<b>x</b> is unchanged: the normalizer never touches markup',
      ]),
    );
    expect(new Set(vectors.map((vector) => vector.name)).size).toBe(vectors.length);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    expect(normalizeAtomText(vector.input)).toBe(vector.expect);
  });
});

describe('normalizeAtomText', () => {
  it('matches the issue’s examples', () => {
    expect(normalizeAtomText('Café  \r\nNext\t\n\n\n')).toBe('Café\nNext\n');
    expect(normalizeAtomText('a \n')).toBe('a \n');
    expect(normalizeAtomText(' \n\t\n')).toBe('');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const once = normalizeAtomText(text);
        expect(normalizeAtomText(once)).toBe(once);
      }),
    );
  });

  it('leaves well-formed NFC with LF endings, no trailing spaces or tabs, and one final LF', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const out = normalizeAtomText(text);
        expect(out).not.toMatch(LONE_SURROGATE);
        expect(out).not.toContain('\r');
        expect(out.normalize('NFC')).toBe(out);
        expect(out).not.toMatch(/[ \t]\n/);
        if (out !== '') expect(out).toMatch(/[^\n]\n$/);
      }),
    );
  });

  it('gives identical UTF-8 bytes for texts that differ only in form, line endings or trailing spaces', () => {
    const ending = fc.constantFrom('\n', '\r\n', '\r');
    const trailing = fc.array(fc.constantFrom(' ', '\t'), { maxLength: 3 }).map((s) => s.join(''));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(line, trailing), { minLength: 1, maxLength: 6 }),
        // One line-ending style per text: a CR ending then an LF ending is one CRLF.
        ending,
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom<'NFC' | 'NFD'>('NFC', 'NFD'),
        (lines, eol, extraNewlines, form) => {
          const plain = lines.map(([text]) => text).join('\n');
          const varied =
            lines.map(([text, spaces]) => `${text}${spaces}${eol}`).join('') +
            eol.repeat(extraNewlines);
          expect(bytes(normalizeAtomText(varied.normalize(form)))).toEqual(
            bytes(normalizeAtomText(plain)),
          );
        },
      ),
    );
  });
});

describe('genesisAtoms', () => {
  it.each(genesis.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    expect(genesisAtoms(vector.document)).toEqual(vector.expect);
  });

  it('yields Atoms that are each already normalized, and never blank', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        for (const atom of genesisAtoms(text)) {
          expect(atom).not.toBe('');
          expect(normalizeAtomText(atom)).toBe(atom);
        }
      }),
    );
  });
});
