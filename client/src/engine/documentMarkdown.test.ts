import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { genesisAtoms, normalizeAtomText } from './atomText';
import { documentToMarkdown } from './documentMarkdown';

/** True when a line of `text` holds only whitespace, as the genesis split reads a blank line. */
function hasBlankLine(text: string): boolean {
  return text
    .slice(0, -1)
    .split('\n')
    .some((line) => line.trim() === '');
}

/** Atom texts as the composer signs them: normalized, never `""`, and with no blank line inside. */
const atomTexts = fc.array(
  fc
    .string({ unit: 'binary', maxLength: 40 })
    .map(normalizeAtomText)
    .filter((text) => text !== '' && !hasBlankLine(text)),
  { maxLength: 8 },
);

describe('documentToMarkdown', () => {
  it('joins the Atoms with a blank line between them', () => {
    expect(documentToMarkdown([{ text: '# Our aims\n' }, { text: 'We meet monthly.\n' }])).toBe(
      '# Our aims\n\nWe meet monthly.\n',
    );
  });

  it('gives one Atom’s text as it is, and nothing for no Atoms', () => {
    expect(documentToMarkdown([{ text: 'We meet monthly.\n' }])).toBe('We meet monthly.\n');
    expect(documentToMarkdown([])).toBe('');
  });

  it('keeps each Atom’s Markdown and line breaks byte for byte', () => {
    const atoms = [
      { text: '- Quiet after ten\n- Bins on Tuesday\n' },
      { text: 'Be *kind*.\\\nAsk.\n' },
    ];
    expect(documentToMarkdown(atoms)).toBe(
      '- Quiet after ten\n- Bins on Tuesday\n\nBe *kind*.\\\nAsk.\n',
    );
  });

  it('is byte-identical to the normalized Atoms joined by blank lines', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(atomTexts, (texts) => {
        const joined =
          texts.length === 0 ? '' : `${texts.map((t) => t.slice(0, -1)).join('\n\n')}\n`;
        const markdown = documentToMarkdown(texts.map((text) => ({ text })));
        expect(encoder.encode(markdown)).toEqual(encoder.encode(joined));
      }),
    );
  });

  it('gives back the same Atoms through the genesis split, when no Atom holds a blank line', () => {
    fc.assert(
      fc.property(atomTexts, (texts) => {
        expect(genesisAtoms(documentToMarkdown(texts.map((text) => ({ text }))))).toEqual(texts);
      }),
    );
  });
});
