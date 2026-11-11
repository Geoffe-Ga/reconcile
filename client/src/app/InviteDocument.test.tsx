import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Atom } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { testGroup } from '../test/groups';
import { foldInvite } from './foldInvite';
import { InviteDocument } from './InviteDocument';

/** The genesis Document of a group founded with `atoms`, folded as Join folds it. */
function documentOf(atoms: readonly string[]): readonly Atom[] {
  const { records } = testGroup({ atoms });
  const document = foldInvite({ records, relayNow: 29_000_100 });
  if (document === null) throw new Error('Expected a genesis.');
  return document;
}

function show(atoms: readonly Atom[]) {
  document.title = 'Join a group · Reconcile';
  return render(
    <main>
      <h1>Riverside Tenants</h1>
      <InviteDocument atoms={atoms} />
    </main>,
  );
}

describe('InviteDocument', () => {
  it('reads each section in order through the one renderer, read only', async () => {
    show(
      documentOf([
        '# Our aims\nWe keep the building safe and fair.',
        '- Quiet after 10pm\n- Bins go out on Tuesday',
      ]),
    );
    const article = screen.getByRole('article');
    expect(within(article).getByRole('heading', { level: 2, name: 'Our aims' })).toBeVisible();
    expect(within(article).getByText('We keep the building safe and fair.')).toBeVisible();
    expect(
      within(article)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Quiet after 10pm', 'Bins go out on Tuesday']);
    expect(article.querySelectorAll('.atom-text')).toHaveLength(2);
    expect(within(article).queryByRole('button')).toBeNull();
    expect(within(article).queryByRole('textbox')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('renders untrusted sections inert: no script, image, raw HTML or javascript: link', async () => {
    const atoms = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '[x](javascript:alert(1)) and [ok](https://example.org)',
      '<a href="javascript:alert(1)">raw</a>',
    ];
    const { container } = show(documentOf(atoms));
    const article = screen.getByRole('article');
    expect(container.querySelector('script, img, iframe, [onerror], [style]')).toBeNull();
    expect(container.querySelector('a[href^="javascript" i]')).toBeNull();
    expect(within(article).getAllByRole('link')).toHaveLength(1);
    expect(within(article).getByRole('link', { name: /ok/ })).toHaveAttribute(
      'href',
      'https://example.org/',
    );
    expect(article).toHaveTextContent('<script>alert(1)</script>');
    expect(article).toHaveTextContent('[x](javascript:alert(1))');
    expect(article).toHaveTextContent('<a href="javascript:alert(1)">raw</a>');
    expect(await axeViolations()).toEqual([]);
  });

  it('reads a long Document whole, every section in order', async () => {
    const atoms = Array.from(
      { length: 24 },
      (_, i) => `# Part ${String(i + 1)}\nSection ${String(i + 1)} says what it says.`,
    );
    show(documentOf(atoms));
    const parts = screen.getAllByRole('heading', { level: 2 }).map((part) => part.textContent);
    expect(parts).toEqual(atoms.map((_, i) => `Part ${String(i + 1)}`));
    expect(await axeViolations()).toEqual([]);
  });
});
