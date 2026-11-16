/**
 * Opening a section from search (#445): its Document opens scrolled to it.
 * Search aims at the section in memory; the Document view, once it shows
 * that section, scrolls to it, once.
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { aimAt, sectionAnchor, useAimedSection } from './aimedSection';

/** A Document of `ids`, each section anchored, that scrolls to the aimed one. */
function Sections({ ids }: { readonly ids: readonly string[] }) {
  useAimedSection(ids.map((id) => ({ id })));
  return (
    <>
      {ids.map((id) => (
        <div key={id} id={sectionAnchor(id)}>
          {id}
        </div>
      ))}
    </>
  );
}

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

/** Spies on every element's `scrollIntoView`, as jsdom has none. */
function spyScroll() {
  const scrolled: string[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(function (this: Element) {
      scrolled.push(this.id);
    }),
  });
  return scrolled;
}

describe('useAimedSection', () => {
  it('scrolls to the section search aimed at once it shows, and only once', () => {
    const scrolled = spyScroll();
    aimAt('b');

    const { rerender } = render(<Sections ids={[]} />);
    expect(scrolled).toEqual([]);
    rerender(<Sections ids={['a', 'b']} />);
    expect(scrolled).toEqual([sectionAnchor('b')]);
    rerender(<Sections ids={['a', 'b', 'c']} />);
    expect(scrolled).toEqual([sectionAnchor('b')]);
  });

  it('scrolls nowhere without an aim', () => {
    const scrolled = spyScroll();

    render(<Sections ids={['a', 'b']} />);

    expect(scrolled).toEqual([]);
  });
});
