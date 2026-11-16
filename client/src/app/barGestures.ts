/**
 * The link bar's two gestures (DESIGN.md "Link bar"): a swipe up on the pill
 * tucks the bar away, and pulling the page down past its top brings it back.
 * Once back, the bar stays at the top while the page bounces home under it.
 *
 * Neither gesture is the only way: Cmd+L, Ctrl+L and `/` bring a tucked bar
 * back and put the cursor in it, so no one needs a finger to reach it.
 */
import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';

/** How far up, in px, a finger moves the pill before letting go tucks the bar away. */
export const SWIPE_AWAY = 32;

/** How far down, in px, a finger pulls the page past its top before letting go brings the bar back. */
export const PULL_BACK = 64;

/** How far up, in px, a wheel or trackpad scrolls past the page's top, in one go, to bring the bar back. */
export const WHEEL_BACK = 160;

/** A pause, in ms, between wheel turns that starts a new go. */
const WHEEL_PAUSE = 400;

/** How far a finger moves, in px, before it's a swipe rather than a tap. */
const SLOP = 8;

/** A wheel's line, in px, for a wheel that counts in lines. */
const LINE = 16;

/** Whether a finger's move, `dx` across and `dy` down, swipes the bar away: up far enough, more up than across. */
export function swipedAway(dx: number, dy: number): boolean {
  return dy <= -SWIPE_AWAY && Math.abs(dy) > Math.abs(dx);
}

/** How far up the bar follows a finger that moved `dy` down: up only, never down past where it rests. */
export function liftOf(dy: number): number {
  return Math.min(0, dy);
}

/** What {@link useSwipeAway} hands the element a swipe starts on. */
export interface SwipeAway {
  /** How far up, in px, the bar follows the finger: 0 at rest. */
  readonly lift: number;
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onPointerCancel: () => void;
}

/** Where a finger came down, while it's down. */
interface Start {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A swipe up by a finger or pen on the element that takes these handlers
 * calls `onAway` once it lets go; a tap, a mouse or a short move does
 * nothing. The bar follows the finger up as it goes.
 */
export function useSwipeAway(onAway: () => void): SwipeAway {
  const start = useRef<Start | null>(null);
  const [lift, setLift] = useState(0);
  const reset = (): void => {
    start.current = null;
    setLift(0);
  };
  const moved = (event: PointerEvent): { dx: number; dy: number } | null => {
    const from = start.current;
    if (from?.id !== event.pointerId) return null;
    return { dx: event.clientX - from.x, dy: event.clientY - from.y };
  };
  return {
    lift,
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse') return;
      start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event) => {
      const move = moved(event);
      if (move !== null && Math.abs(move.dy) > SLOP) setLift(liftOf(move.dy));
    },
    onPointerUp: (event) => {
      const move = moved(event);
      reset();
      if (move !== null && swipedAway(move.dx, move.dy)) onAway();
    },
    onPointerCancel: reset,
  };
}

/** A wheel turn's distance in px: up is negative. */
function wheelPixels(event: WheelEvent): number {
  return event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * LINE : event.deltaY;
}

/** Whether `page` is at its top, or bouncing past it (WebKit reports a bounce as a negative scroll). */
function atTop(page: HTMLElement): boolean {
  return page.scrollTop <= 0;
}

/**
 * While `active`, a finger that pulls `page` down past its top by
 * {@link PULL_BACK} calls `onBack` once it lets go, and so does a wheel or
 * trackpad that scrolls up past the top by {@link WHEEL_BACK} in one go. The
 * page still bounces as it always does: these only listen.
 */
export function usePullBack(
  page: RefObject<HTMLElement | null>,
  active: boolean,
  onBack: () => void,
): void {
  useEffect(() => {
    const element = page.current;
    if (!active || element === null) return;
    // Where the finger was when the page reached its top, and whether it's pulled far enough since.
    let topY: number | null = null;
    let pulled = false;
    let wheeled = 0;
    let lastWheel = Number.NEGATIVE_INFINITY;
    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      topY = touch !== undefined && atTop(element) ? touch.clientY : null;
      pulled = false;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined || !atTop(element)) {
        topY = null;
        return;
      }
      topY ??= touch.clientY;
      if (touch.clientY - topY >= PULL_BACK) pulled = true;
    };
    const onTouchEnd = (): void => {
      const done = pulled;
      topY = null;
      pulled = false;
      if (done) onBack();
    };
    const onWheel = (event: WheelEvent): void => {
      const up = -wheelPixels(event);
      const fresh = event.timeStamp - lastWheel > WHEEL_PAUSE;
      lastWheel = event.timeStamp;
      if (up <= 0 || !atTop(element)) {
        wheeled = 0;
        return;
      }
      wheeled = (fresh ? 0 : wheeled) + up;
      if (wheeled >= WHEEL_BACK) {
        wheeled = 0;
        onBack();
      }
    };
    const passive = { passive: true } as const;
    element.addEventListener('touchstart', onTouchStart, passive);
    element.addEventListener('touchmove', onTouchMove, passive);
    element.addEventListener('touchend', onTouchEnd, passive);
    element.addEventListener('touchcancel', onTouchEnd, passive);
    element.addEventListener('wheel', onWheel, passive);
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      element.removeEventListener('wheel', onWheel);
    };
  }, [page, active, onBack]);
}
