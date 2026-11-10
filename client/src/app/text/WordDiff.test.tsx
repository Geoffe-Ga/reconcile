/**
 * `<WordDiff>` (#70, DESIGN.md "Ballot"): a Proposal's change as a word diff
 * of the source, with each change marked in text as well as color.
 */
import { render } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../../test/axe';
import proposalsCss from '../../styles/proposals.css?raw';
import { WordDiff } from './WordDiff';

function diff(current: string, proposed: string): HTMLElement {
  const { container } = render(<WordDiff current={current} proposed={proposed} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('Expected the diff.');
  return root;
}

/** The text a sighted reader sees on one side: the shared runs and that side's changes. */
function side(root: HTMLElement, keep: 'ins' | 'del'): string {
  const copy = root.cloneNode(true) as HTMLElement;
  const drop = keep === 'ins' ? 'del' : 'ins';
  for (const element of Array.from(copy.querySelectorAll(`${drop}, .diff-label`))) {
    element.remove();
  }
  return copy.textContent;
}

/** One CSS rule's body from a stylesheet, by its exact selector. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('WordDiff', () => {
  it('marks a one-word change as exactly one removed and one added part', () => {
    const root = diff('the quick fox\n', 'the slow fox\n');
    expect(Array.from(root.querySelectorAll('del')).map((node) => node.textContent)).toEqual([
      'quick',
    ]);
    expect(Array.from(root.querySelectorAll('ins')).map((node) => node.textContent)).toEqual([
      'slow',
    ]);
  });

  it('reads “removed quick added slow”, so color is never the only signal', () => {
    const root = diff('the quick fox\n', 'the slow fox\n');
    expect(root.textContent.replace(/\s+/g, ' ').trim()).toBe('the removed quick added slow fox');
    const labels = Array.from(root.querySelectorAll('.diff-label'));
    expect(labels.map((label) => label.textContent.trim())).toEqual(['removed', 'added']);
    expect(labels[0]?.nextElementSibling?.tagName).toBe('DEL');
    expect(labels[1]?.nextElementSibling?.tagName).toBe('INS');
  });

  it('sets the source, not rendered Markdown, with its direction from its own text', () => {
    const root = diff('Quiet after ten.\n', '# Quiet after **ten**.\n');
    expect(root).toHaveClass('word-diff');
    expect(root).toHaveAttribute('dir', 'auto');
    expect(root.querySelector('h2, strong')).toBeNull();
    expect(side(root, 'ins')).toBe('# Quiet after **ten**.\n');
  });

  it('shows an unchanged text with no marks', () => {
    const root = diff('Same.\n', 'Same.\n');
    expect(root.querySelector('ins, del, .diff-label')).toBeNull();
    expect(root.textContent).toBe('Same.\n');
  });

  it('rebuilds the new text from the unchanged and added parts, and the old from the unchanged and removed', () => {
    const word = fc.constantFrom('the', 'quick', 'slow', 'fox', '**a**', '<b>', '[x](y)', 'é');
    const gap = fc.constantFrom(' ', '\n', '  ', '');
    const text = fc
      .array(fc.tuple(word, gap), { maxLength: 12 })
      .map((pairs) => pairs.map(([w, g]) => w + g).join(''));
    fc.assert(
      fc.property(text, text, (current, proposed) => {
        const { container, unmount } = render(<WordDiff current={current} proposed={proposed} />);
        const root = container.firstElementChild as HTMLElement;
        expect(side(root, 'ins')).toBe(proposed);
        expect(side(root, 'del')).toBe(current);
        expect(root.querySelector('script, b, a')).toBeNull();
        unmount();
      }),
      { numRuns: 100 },
    );
  }, 20_000);

  it('follows DESIGN.md: Newsreader, pre-wrap, additions on primary-soft, deletions struck through on a negative tint', () => {
    expect(rule(proposalsCss, '.word-diff')).toContain('font: var(--type-document)');
    expect(rule(proposalsCss, '.word-diff')).toContain('white-space: pre-wrap');
    expect(rule(proposalsCss, '.word-diff ins')).toContain('background: var(--primary-soft)');
    expect(rule(proposalsCss, '.word-diff del')).toContain('background: var(--negative-soft)');
    expect(rule(proposalsCss, '.word-diff del')).toContain('text-decoration-line: line-through');
  });

  it('passes axe', async () => {
    document.title = 'Proposal · Reconcile';
    render(
      <main>
        <h1>Proposal</h1>
        <WordDiff current={'Quiet after ten.\n'} proposed={'Quiet after eleven.\n'} />
      </main>,
    );
    expect(await axeViolations()).toEqual([]);
  });
});
