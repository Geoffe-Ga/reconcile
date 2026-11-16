import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../test/axe';
import { AtomBadge } from './AtomBadge';

/** Renders a badge inside a page's main landmark, as the Document view does. */
function badge(cls: 'ordinary' | 'entrenched' | 'eternal') {
  document.title = 'House rules · Reconcile';
  return render(
    <main>
      <h1>House rules</h1>
      <AtomBadge cls={cls} />
    </main>,
  );
}

describe('AtomBadge (#116, DESIGN.md Atom block)', () => {
  it('shows nothing for an ordinary section', () => {
    const { container } = badge('ordinary');
    expect(container.querySelector('.atom-badge')).toBeNull();
    expect(screen.queryByText(/Entrenched|Eternal/)).toBeNull();
  });

  it('carries the eyebrow "Entrenched" and a lock glyph, in clay', async () => {
    badge('entrenched');
    const eyebrow = screen.getByText('Entrenched');
    expect(eyebrow).toHaveClass('eyebrow', 'atom-badge', 'atom-badge-entrenched');
    const glyph = eyebrow.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveAttribute('focusable', 'false');
    expect(await axeViolations()).toEqual([]);
  });

  it('carries the eyebrow "Eternal", with a double ink rule and no lock', async () => {
    badge('eternal');
    const eyebrow = screen.getByText('Eternal');
    expect(eyebrow).toHaveClass('eyebrow', 'atom-badge', 'atom-badge-eternal');
    expect(eyebrow).not.toHaveClass('atom-badge-entrenched');
    expect(eyebrow.querySelector('svg')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('says its class in words, so color is never the only signal', () => {
    badge('entrenched');
    expect(screen.getByText('Entrenched')).toHaveTextContent(/^Entrenched$/);
  });
});
