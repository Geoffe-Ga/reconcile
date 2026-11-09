/** The device clock, read again on a timer so countdowns move while a screen is open. */
import { useEffect, useState } from 'react';

/** How often the clock is read again: countdowns show whole minutes at most. */
export const TICK_MS = 15_000;

/** `clock()` now, read again every {@link TICK_MS} while the component is mounted. */
export function useNow(clock: () => number): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(clock());
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [clock]);
  return now;
}
