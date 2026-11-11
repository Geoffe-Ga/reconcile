/**
 * What the link screens (#96) share: a link that exists only while its
 * screen is open, and a poll of the relay every 2 seconds while the step it
 * last read wants another.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/** How often a link screen looks at the relay while it waits, in milliseconds. */
export const LINK_POLL_MS = 2000;

/** Something that holds secrets until it's dropped. */
interface Droppable {
  drop(): void;
}

/**
 * A store holding the one thing `make` makes, made when the first screen
 * subscribes and dropped when the last one leaves. React's StrictMode
 * subscribes, leaves and subscribes again, so that first one is dropped too.
 */
function holder<T extends Droppable>(make: () => T) {
  let held: T | null = null;
  let subscribers = 0;
  return {
    subscribe: (): (() => void) => {
      subscribers += 1;
      held ??= make();
      return () => {
        subscribers -= 1;
        if (subscribers > 0) return;
        held?.drop();
        held = null;
      };
    },
    current: (): T | null => held,
  };
}

/**
 * What `make` makes, for as long as the calling component is mounted: null
 * on the first render, then the made thing, which is dropped when the
 * component unmounts. A new `make` drops it and makes another; to start
 * over with the same one, remount the component with a new `key`.
 */
export function useHeld<T extends Droppable>(make: () => T): T | null {
  const store = useMemo(() => holder(make), [make]);
  return useSyncExternalStore(store.subscribe, store.current, store.current);
}

/** The last step a poll read, and whether the last look failed to reach the relay. */
export interface Polled<Step> {
  readonly step: Step | null;
  readonly unreachable: boolean;
}

/** What {@link usePolling} keeps: the poll it belongs to, and what that poll read. */
interface PollState<Step> extends Polled<Step> {
  readonly poll: (() => Promise<Step>) | null;
}

/**
 * Runs `poll` at once, then every {@link LINK_POLL_MS} while `again` says the
 * last step wants another, or after a look that failed (the relay out of
 * reach), until the screen closes or `poll` changes. Null runs nothing.
 */
export function usePolling<Step>(
  poll: (() => Promise<Step>) | null,
  again: (step: Step) => boolean,
): Polled<Step> {
  const [state, setState] = useState<PollState<Step>>({
    poll: null,
    step: null,
    unreachable: false,
  });
  useEffect(() => {
    if (poll === null) return;
    let live = true;
    let timer = 0;
    const tick = async (): Promise<void> => {
      let step: Step | null = null;
      try {
        step = await poll();
      } catch {
        // The relay is out of reach: keep the last step shown, and try again.
      }
      if (!live) return;
      const read = step;
      setState((now) =>
        read === null
          ? { poll, step: now.poll === poll ? now.step : null, unreachable: true }
          : { poll, step: read, unreachable: false },
      );
      if (read === null || again(read)) {
        timer = window.setTimeout(() => void tick(), LINK_POLL_MS);
      }
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [poll, again]);
  return state.poll === poll ? state : { step: null, unreachable: false };
}
