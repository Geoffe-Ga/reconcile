/**
 * `wordDiff` (#70): jsdiff's diffWordsWithSpace on Atom source text.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type DiffPart, MAX_DIFF_EDITS, wordDiff } from './wordDiffParts';

/** The text a diff's parts rebuild, keeping the unchanged parts and one side's changes. */
function rebuild(parts: readonly DiffPart[], side: 'added' | 'removed'): string {
  return parts
    .map((part) => {
      if ('same' in part) return part.same;
      if (side === 'added') return 'added' in part ? part.added : '';
      return 'removed' in part ? part.removed : '';
    })
    .join('');
}

const word = fc.constantFrom('the', 'quick', 'slow', 'fox', '**fox**', '#', '-', 'é', 'é');
const gap = fc.constantFrom(' ', '  ', '\n', '\n\n', '\t', '');
const text = fc
  .array(fc.tuple(word, gap), { maxLength: 20 })
  .map((pairs) => pairs.map(([w, g]) => w + g).join(''));

describe('wordDiff', () => {
  it('matches the issue’s example', () => {
    expect(wordDiff('the quick fox\n', 'the slow fox\n')).toEqual([
      { same: 'the ' },
      { removed: 'quick' },
      { added: 'slow' },
      { same: ' fox\n' },
    ]);
  });

  it('gives one unchanged part for identical texts', () => {
    expect(wordDiff('Quiet after ten.\n', 'Quiet after ten.\n')).toEqual([
      { same: 'Quiet after ten.\n' },
    ]);
  });

  it('keeps whitespace changes, line breaks included', () => {
    expect(wordDiff('a b\n', 'a\nb\n')).toEqual([
      { same: 'a' },
      { removed: ' ' },
      { added: '\n' },
      { same: 'b\n' },
    ]);
  });

  it('diffs Markdown source, never what it renders to, punctuation by itself', () => {
    expect(wordDiff('Quiet after ten.\n', 'Quiet after **ten**.\n')).toEqual([
      { same: 'Quiet after ' },
      { added: '**' },
      { same: 'ten' },
      { added: '**' },
      { same: '.\n' },
    ]);
  });

  it('shows all-new text against an empty one as one added part', () => {
    expect(wordDiff('', 'New section.\n')).toEqual([{ added: 'New section.\n' }]);
  });

  it('falls back to removing the old text and adding the new when the edit is too long to work out', () => {
    const before = Array.from({ length: MAX_DIFF_EDITS + 1 }, (_, i) => `a${String(i)}`).join(' ');
    const after = Array.from({ length: MAX_DIFF_EDITS + 1 }, (_, i) => `b${String(i)}`).join(' ');
    expect(wordDiff(before, after)).toEqual([{ removed: before }, { added: after }]);
  });

  it('rebuilds the new text from its unchanged and added parts, and the old from its unchanged and removed', () => {
    fc.assert(
      fc.property(text, text, (current, proposed) => {
        const parts = wordDiff(current, proposed);
        expect(rebuild(parts, 'added')).toBe(proposed);
        expect(rebuild(parts, 'removed')).toBe(current);
      }),
    );
  });

  it('never gives an empty part', () => {
    fc.assert(
      fc.property(text, text, (current, proposed) => {
        for (const part of wordDiff(current, proposed)) {
          expect(Object.values(part)).not.toContain('');
        }
      }),
    );
  });
});
