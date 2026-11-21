/**
 * Holds a control where it sits on the screen while a render changes what's
 * above it (#407): a sync that brings in a line above a ballot, say, moves the
 * page's scroll by the same amount, in the same commit, so the ballot stays
 * under the finger or pointer aimed at it, and a tap that began before the
 * line came still ends on it.
 *
 * It's the browser's scroll anchoring with the control as the anchor, done by
 * hand: Safari has none, and the app's page turns the browser's off
 * (`frame.css`) so it never adds a second correction to the bar's
 * ({@link useSteadyPage}).
 */
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

import { roomOf } from './barGestures';

/** Where the control stood after the last render, scroll or resize. */
interface Held {
  /** Its place in the page's content, in px ({@link placeOf}). */
  readonly place: number;
  /** The page's scroll then, in px. */
  readonly scrollTop: number;
}

/**
 * Where `element` sits in `page`'s content, in px: the sum of its layout
 * offsets, which neither a scroll nor a transform changes, less the page's top
 * padding, the bar's room, which {@link useSteadyPage} keeps steady itself.
 */
function placeOf(element: HTMLElement, page: HTMLElement): number {
  let place = 0;
  let node: Element | null = element;
  while (node instanceof HTMLElement && page.contains(node)) {
    place += node.offsetTop;
    node = node.offsetParent;
  }
  return place - roomOf(page);
}

/** Whether any of `element` shows in `page`'s window. */
function inView(element: HTMLElement, page: HTMLElement): boolean {
  const shown = element.getBoundingClientRect();
  const frame = page.getBoundingClientRect();
  return shown.bottom > frame.top && shown.top < frame.bottom;
}

/** Where `element` stands in `page` now. */
function heldAt(element: HTMLElement, page: HTMLElement): Held {
  return { place: placeOf(element, page), scrollTop: page.scrollTop };
}

/**
 * Keeps `target` where it sits on the screen across every render of the
 * component that calls it. After a render that moved it in the page while the
 * page's scroll stayed put, the page scrolls by what moved, so long as some of
 * it shows; out of view, the words being read stay put instead. A scroll or a
 * resize since the last render moved it on purpose, so it's held from there.
 *
 * `target` must be in the app's page (`.app-page`) when the component mounts.
 */
export function useSteadyInView(target: RefObject<HTMLElement | null>): void {
  const held = useRef<Held | null>(null);
  // No dependencies: it runs after every render, before the browser paints or takes the next input.
  useLayoutEffect(() => {
    const element = target.current;
    const page = element?.closest<HTMLElement>('.app-page') ?? null;
    if (element === null || page === null) {
      held.current = null;
      return;
    }
    const before = held.current;
    const place = placeOf(element, page);
    const moved = before !== null && before.place !== place;
    if (moved && before.scrollTop === page.scrollTop && inView(element, page)) {
      page.scrollTop += place - before.place;
    }
    held.current = { place, scrollTop: page.scrollTop };
  });
  useEffect(() => {
    const element = target.current;
    const page = element?.closest<HTMLElement>('.app-page') ?? null;
    if (element === null || page === null) return undefined;
    const remember = () => {
      held.current = heldAt(element, page);
    };
    page.addEventListener('scroll', remember, { passive: true });
    window.addEventListener('resize', remember);
    return () => {
      page.removeEventListener('scroll', remember);
      window.removeEventListener('resize', remember);
    };
  }, [target]);
}
