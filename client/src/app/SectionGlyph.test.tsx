import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SectionGlyph } from './SectionGlyph';
import { SECTION_GLYPHS } from './sectionGlyphs';

describe('SectionGlyph', () => {
  it('draws a decorative line glyph, out of the tab order and the accessibility tree', () => {
    const { container } = render(<SectionGlyph kind="documents" />);
    const glyph = container.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveClass('section-glyph');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('focusable')).toBe('false');
    expect(glyph?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(glyph?.getAttribute('width')).toBe('16');
    expect(glyph?.getAttribute('height')).toBe('16');
    expect(glyph?.textContent).toBe('');
    expect(glyph?.children.length).toBeGreaterThan(0);
  });

  it('draws every kind differently, so no two sections look alike', () => {
    const drawn = SECTION_GLYPHS.map((kind) => {
      const { container, unmount } = render(<SectionGlyph kind={kind} />);
      const inner = container.querySelector('svg')?.innerHTML;
      unmount();
      return inner;
    });
    expect(drawn.every((inner) => inner !== undefined && inner.length > 0)).toBe(true);
    expect(new Set(drawn).size).toBe(SECTION_GLYPHS.length);
  });
});
