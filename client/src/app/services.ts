/**
 * Everything the app reaches outside React: the store, the sync loop, the
 * relay, the seal, the clock and the clipboard. `main.tsx` builds the real
 * ones; tests hand in a fake relay and fake IndexedDB.
 */
import type { Sync } from '../store/sync';
import type { Services } from './actions';

/** What `App` runs on. */
export interface AppServices extends Services {
  /** The sync loop, which `useGroup` also reads for reachability. */
  readonly sync: Sync;
  /** The app's origin, which invite links start with. */
  readonly origin: string;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
}

/** The browser's clipboard. A browser without one (an insecure origin) rejects. */
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
