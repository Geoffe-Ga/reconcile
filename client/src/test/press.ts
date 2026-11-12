/**
 * A tap on a busy control, for tests (#190, #192, #193). React Aria's usePress
 * starts a press on pointerdown even on a disabled button, and a browser gives
 * a disabled button pointerdown and pointerup but no click, so 80 ms later
 * usePress clicks the button itself. A test taps while the action waits, lets
 * it settle, then waits past that click, so a late press can't hide.
 */
import { act } from 'react';

/** How long React Aria's usePress waits for a click before clicking a pressed button itself. */
export const PRESS_FALLBACK_MS = 80;

/** Waits past usePress's own click on a button pressed while it was disabled. */
export function pastPressFallback(): Promise<void> {
  return act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, PRESS_FALLBACK_MS + 20);
      }),
  );
}

/** An action's promise that waits until the test settles it. */
export interface Held<T> {
  /** What the action returns, every time it is called. */
  readonly promise: Promise<T>;
  /** Resolves it with `value`. */
  readonly resolve: (value: T) => void;
  /** Rejects it, as an action that couldn't be done. */
  readonly reject: () => void;
}

/** A promise held open until the test settles it, for an action that is slow to finish. */
export function held<T>(): Held<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: () => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = () => {
      fail(new Error('held action failed'));
    };
  });
  return { promise, resolve, reject };
}
