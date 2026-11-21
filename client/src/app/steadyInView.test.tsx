/**
 * A control held where it is (#407): when a render moves what's above it,
 * the page scrolls by what moved, so a tap aimed at it lands.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useSteadyInView } from './steadyInView';

/** The window the page shows, in px from the viewport's top, as jsdom has no layout. */
const VIEW = { top: 0, bottom: 800 };

/**
 * Where each element sits in the layout, in px from the page's top, before
 * any scroll or transform; jsdom lays nothing out, so the tests set it.
 */
const layout = new Map<HTMLElement, number>();

afterEach(() => {
  layout.clear();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
  Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect');
});

/**
 * Lays the page out: `held` at `at` px down the page, inside a page whose top
 * padding is `room` px, as offsets (which no scroll or transform changes) and
 * as rects (which both do).
 */
function lay(held: HTMLElement, page: HTMLElement, at: number, room = 72): void {
  page.style.paddingTop = `${String(room)}px`;
  layout.set(held, at + room);
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this === held ? page : null;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return layout.get(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (this === page) return new DOMRect(0, VIEW.top, 400, VIEW.bottom - VIEW.top);
      const top = (layout.get(this) ?? 0) - page.scrollTop;
      return new DOMRect(0, top, 400, 120);
    },
  });
}

/** A page with a line above the held control, and the control, re-rendered with `above` px over it. */
function Page({ above }: { readonly above: number }) {
  const held = useRef<HTMLFormElement>(null);
  useSteadyInView(held);
  return (
    <div className="app-page" data-testid="page">
      <p data-testid="above" data-height={above}>
        Above
      </p>
      <form ref={held} data-testid="held">
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

/** Renders the page, lays the held control at `at`, and scrolls the page to `scrollTop`. */
function open(at: number, scrollTop: number) {
  const view = render(<Page above={0} />);
  const page = screen.getByTestId('page');
  const held = screen.getByTestId('held');
  lay(held, page, at);
  page.scrollTop = scrollTop;
  fireEvent.scroll(page);
  return { ...view, page, held };
}

describe('useSteadyInView', () => {
  it('scrolls by what a render moved above the control, so it stays where it was aimed', () => {
    const { page, held, rerender } = open(900, 400);
    expect(held.getBoundingClientRect().top).toBe(572);
    // A synced line, 29px tall, appears above it.
    layout.set(held, 900 + 72 + 29);
    rerender(<Page above={29} />);
    expect(page.scrollTop).toBe(429);
    expect(held.getBoundingClientRect().top).toBe(572);
  });

  it('scrolls back by what a render took away above it', () => {
    const { page, held, rerender } = open(900, 400);
    layout.set(held, 900 + 72 - 40);
    rerender(<Page above={0} />);
    expect(page.scrollTop).toBe(360);
  });

  it('holds it at the top of the page too, wherever there is room to scroll', () => {
    const { page, held, rerender } = open(300, 0);
    layout.set(held, 300 + 72 + 29);
    rerender(<Page above={29} />);
    expect(page.scrollTop).toBe(29);
  });

  it('leaves the page alone when the control is out of view, so words being read stay put', () => {
    const { page, held, rerender } = open(2_000, 0);
    layout.set(held, 2_000 + 72 + 29);
    rerender(<Page above={29} />);
    expect(page.scrollTop).toBe(0);
  });

  it('leaves a scroll the person made alone, though no scroll event has come yet', () => {
    const { page, held, rerender } = open(900, 400);
    page.scrollTop = 250;
    layout.set(held, 900 + 72 + 29);
    rerender(<Page above={29} />);
    expect(page.scrollTop).toBe(250);
    // And holds it from where they left it.
    layout.set(held, 900 + 72 + 58);
    rerender(<Page above={58} />);
    expect(page.scrollTop).toBe(279);
  });

  it('takes no part in the bar’s room changing: the page’s padding moves the control, not a render', () => {
    const { page, held, rerender } = open(300, 0);
    // The bar tucks away: the page's top padding goes from 72px to 12px.
    page.style.paddingTop = '12px';
    layout.set(held, 300 + 12);
    rerender(<Page above={0} />);
    expect(page.scrollTop).toBe(0);
  });

  it('starts again from where a resize leaves the control', () => {
    const { page, held, rerender } = open(900, 400);
    // A narrower window wraps the words above it onto another line.
    layout.set(held, 900 + 72 + 24);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    rerender(<Page above={0} />);
    expect(page.scrollTop).toBe(400);
  });

  it('does nothing outside the app’s page, or before the control is there', () => {
    function Bare({ shown }: { readonly shown: boolean }) {
      const held = useRef<HTMLFormElement>(null);
      useSteadyInView(held);
      return shown ? <form ref={held} data-testid="held" /> : null;
    }
    const { rerender } = render(<Bare shown={false} />);
    expect(() => {
      rerender(<Bare shown />);
      rerender(<Bare shown />);
    }).not.toThrow();
  });
});
