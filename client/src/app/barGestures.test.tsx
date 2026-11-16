/**
 * The link bar's gestures: a swipe up tucks it away, and a pull down past
 * the page's top, by finger or wheel, brings it back.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  liftOf,
  PULL_BACK,
  SWIPE_AWAY,
  swipedAway,
  usePullBack,
  useSwipeAway,
  WHEEL_BACK,
} from './barGestures';

describe('swipedAway', () => {
  it('is a move up of at least SWIPE_AWAY that goes more up than across', () => {
    expect(swipedAway(0, -SWIPE_AWAY)).toBe(true);
    expect(swipedAway(0, -(SWIPE_AWAY - 1))).toBe(false);
    expect(swipedAway(SWIPE_AWAY, -SWIPE_AWAY)).toBe(false);
    expect(swipedAway(-(SWIPE_AWAY + 1), -SWIPE_AWAY)).toBe(false);
    expect(swipedAway(SWIPE_AWAY - 1, -SWIPE_AWAY)).toBe(true);
    expect(swipedAway(0, SWIPE_AWAY * 2)).toBe(false);
  });
});

describe('liftOf', () => {
  it('follows a finger up and never down', () => {
    expect(liftOf(-20)).toBe(-20);
    expect(liftOf(0)).toBe(0);
    expect(liftOf(30)).toBe(0);
  });
});

/** A pill that takes the swipe's handlers and shows its lift. */
function Pill({ onAway }: { readonly onAway: () => void }) {
  const { lift, ...handlers } = useSwipeAway(onAway);
  return (
    <div data-testid="pill" data-lift={lift} {...handlers}>
      Pill
    </div>
  );
}

/** A finger's swipe on `element`, from y 100 to `toY` (and `toX` across). */
function swipe(element: HTMLElement, toY: number, toX = 0, pointerType = 'touch') {
  fireEvent.pointerDown(element, { pointerId: 1, pointerType, clientX: 0, clientY: 100 });
  fireEvent.pointerMove(element, { pointerId: 1, pointerType, clientX: toX, clientY: toY });
  fireEvent.pointerUp(element, { pointerId: 1, pointerType, clientX: toX, clientY: toY });
}

describe('useSwipeAway', () => {
  it('calls onAway once a finger swipes up far enough and lets go', () => {
    const onAway = vi.fn();
    render(<Pill onAway={onAway} />);
    swipe(screen.getByTestId('pill'), 100 - SWIPE_AWAY);
    expect(onAway).toHaveBeenCalledOnce();
  });

  it('does nothing for a short swipe, a swipe down, a swipe across or a mouse', () => {
    const onAway = vi.fn();
    render(<Pill onAway={onAway} />);
    const pill = screen.getByTestId('pill');
    swipe(pill, 100 - SWIPE_AWAY + 1);
    swipe(pill, 100 + SWIPE_AWAY * 2);
    swipe(pill, 100 - SWIPE_AWAY, SWIPE_AWAY * 2);
    swipe(pill, 100 - SWIPE_AWAY * 2, 0, 'mouse');
    expect(onAway).not.toHaveBeenCalled();
  });

  it('follows the finger up past a tap’s slop, and rests again when it lets go or is cancelled', () => {
    render(<Pill onAway={vi.fn()} />);
    const pill = screen.getByTestId('pill');
    fireEvent.pointerDown(pill, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 100 });
    fireEvent.pointerMove(pill, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 95 });
    expect(pill.dataset.lift).toBe('0');
    fireEvent.pointerMove(pill, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 80 });
    expect(pill.dataset.lift).toBe('-20');
    fireEvent.pointerCancel(pill, { pointerId: 1, pointerType: 'touch' });
    expect(pill.dataset.lift).toBe('0');
    // A cancelled finger's later lift-off swipes nothing.
    fireEvent.pointerUp(pill, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
    expect(pill.dataset.lift).toBe('0');
  });

  it('ignores a second finger’s moves', () => {
    const onAway = vi.fn();
    render(<Pill onAway={onAway} />);
    const pill = screen.getByTestId('pill');
    fireEvent.pointerDown(pill, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 100 });
    fireEvent.pointerMove(pill, { pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
    expect(pill.dataset.lift).toBe('0');
    fireEvent.pointerUp(pill, { pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
    expect(onAway).not.toHaveBeenCalled();
  });
});

/** A scrolling page that listens for a pull back while `active`. */
function Page({ active, onBack }: { readonly active: boolean; readonly onBack: () => void }) {
  const page = useRef<HTMLDivElement>(null);
  usePullBack(page, active, onBack);
  return (
    <div ref={page} data-testid="page">
      A page
    </div>
  );
}

/** A finger that comes down at y 100 and moves down `by` px, letting go when `end`. */
function pull(page: HTMLElement, by: number, end: 'touchEnd' | 'touchCancel' = 'touchEnd') {
  fireEvent.touchStart(page, { touches: [{ clientY: 100 }] });
  fireEvent.touchMove(page, { touches: [{ clientY: 100 + by / 2 }] });
  fireEvent.touchMove(page, { touches: [{ clientY: 100 + by }] });
  fireEvent[end](page, { touches: [] });
}

describe('usePullBack', () => {
  it('calls onBack when a finger pulls the page down past its top far enough and lets go', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    pull(page, PULL_BACK - 1);
    expect(onBack).not.toHaveBeenCalled();
    pull(page, PULL_BACK);
    expect(onBack).toHaveBeenCalledOnce();
    pull(page, PULL_BACK, 'touchCancel');
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('waits for the finger to let go', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    fireEvent.touchStart(page, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 100 + PULL_BACK * 2 }] });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.touchEnd(page, { touches: [] });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('counts the pull from where the page reached its top, and a bounce past it as the top', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    page.scrollTop = 200;
    fireEvent.touchStart(page, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 150 }] });
    // WebKit reports the bounce past the top as a negative scroll.
    page.scrollTop = -1;
    fireEvent.touchMove(page, { touches: [{ clientY: 160 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 160 + PULL_BACK - 1 }] });
    fireEvent.touchEnd(page, { touches: [] });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.touchStart(page, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 100 + PULL_BACK }] });
    fireEvent.touchEnd(page, { touches: [] });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('does nothing for a pull that scrolls the page, or with no touch', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    page.scrollTop = 200;
    pull(page, PULL_BACK * 2);
    page.scrollTop = 0;
    fireEvent.touchStart(page, { touches: [] });
    fireEvent.touchMove(page, { touches: [] });
    fireEvent.touchEnd(page, { touches: [] });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('calls onBack when a wheel scrolls up past the top far enough in one go', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    fireEvent.wheel(page, { deltaY: -(WHEEL_BACK / 2) });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.wheel(page, { deltaY: -(WHEEL_BACK / 2) });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('counts a wheel’s lines as 16px each', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    fireEvent.wheel(screen.getByTestId('page'), {
      deltaY: -(WHEEL_BACK / 16),
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('starts the wheel’s count again after a scroll down or a scroll mid-page', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    const half = -(WHEEL_BACK / 2);
    fireEvent.wheel(page, { deltaY: half });
    fireEvent.wheel(page, { deltaY: 10 });
    fireEvent.wheel(page, { deltaY: half });
    page.scrollTop = 50;
    fireEvent.wheel(page, { deltaY: half });
    page.scrollTop = 0;
    fireEvent.wheel(page, { deltaY: half });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('starts the wheel’s count again after a pause', () => {
    const onBack = vi.fn();
    render(<Page active onBack={onBack} />);
    const page = screen.getByTestId('page');
    const half = -(WHEEL_BACK / 2);
    page.dispatchEvent(wheelAt(half, 1000));
    page.dispatchEvent(wheelAt(half, 1500));
    expect(onBack).not.toHaveBeenCalled();
    page.dispatchEvent(wheelAt(half, 1600));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('listens only while active, and stops once inactive', () => {
    const onBack = vi.fn();
    const { rerender } = render(<Page active={false} onBack={onBack} />);
    const page = screen.getByTestId('page');
    pull(page, PULL_BACK);
    fireEvent.wheel(page, { deltaY: -WHEEL_BACK });
    expect(onBack).not.toHaveBeenCalled();
    rerender(<Page active onBack={onBack} />);
    pull(page, PULL_BACK);
    expect(onBack).toHaveBeenCalledOnce();
    rerender(<Page active={false} onBack={onBack} />);
    pull(page, PULL_BACK);
    fireEvent.wheel(page, { deltaY: -WHEEL_BACK });
    expect(onBack).toHaveBeenCalledOnce();
  });
});

/** A wheel turn of `deltaY` px stamped `timeStamp` ms. */
function wheelAt(deltaY: number, timeStamp: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}
