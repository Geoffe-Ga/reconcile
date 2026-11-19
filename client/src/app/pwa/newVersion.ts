/**
 * Whether a new version of Reconcile is installed and waiting (#513).
 *
 * `registerServiceWorker` marks it when the browser's own update check has
 * installed a new worker that waits for the next launch; Start and Settings
 * read it to show "A new version is ready. Close and reopen Reconcile." Once
 * waiting, it stays so for the rest of this page's life: nothing here makes
 * the new version take over (ADR-0057; ADR-0073's 2026-11-19 amendment).
 */
import { useSyncExternalStore } from 'react';

/** What the screens read: whether a new version waits, and a way to hear when one does. */
export interface NewVersion {
  /** True once a new version is installed and waiting for the next launch. */
  readonly ready: () => boolean;
  /** Calls `listener` when that turns true; returns a function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** {@link NewVersion}, plus the one way to turn it on, which `main.tsx` hands the registration. */
export interface NewVersionSignal extends NewVersion {
  /** Records that a new version is waiting. Telling it again changes nothing. */
  readonly markWaiting: () => void;
}

/** A signal that starts with nothing waiting. */
export function createNewVersion(): NewVersionSignal {
  let waiting = false;
  const listeners = new Set<() => void>();
  return {
    ready: () => waiting,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markWaiting() {
      if (waiting) return;
      waiting = true;
      for (const listener of listeners) listener();
    },
  };
}

/** Nothing waits where there's no signal: in development, and in most tests. */
const NEVER: NewVersion = {
  ready: () => false,
  subscribe: () => () => undefined,
};

/** Whether a new version is waiting, re-rendering when one starts to. */
export function useNewVersionReady(signal: NewVersion | undefined): boolean {
  const { subscribe, ready } = signal ?? NEVER;
  return useSyncExternalStore(subscribe, ready, ready);
}
