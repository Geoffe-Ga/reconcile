/**
 * Everything the app reaches outside React: the store, the sync loop, the
 * relay, the seal, the clock, the clipboard, Web Share and the guide's flag. `main.tsx` builds
 * the real ones; tests hand in a fake relay and fake IndexedDB.
 */
import type { GuideRecord } from '../platform/guide';
import type { Sync } from '../store/sync';
import type { Services } from './actions';
import type { WebShare } from './share';

/** What `App` runs on. */
export interface AppServices extends Services {
  /** The sync loop, which `useGroup` also reads for reachability. */
  readonly sync: Sync;
  /** The app's origin, which invite links start with. */
  readonly origin: string;
  /**
   * Puts text on the clipboard; rejects when the browser blocks it. Text still
   * on its way, such as an invite link waiting on the relay, may come as a
   * promise: nothing is copied if it rejects.
   */
  readonly copyText: (text: string | Promise<string>) => Promise<void>;
  /** The browser's Web Share (`navigator.share`), or undefined where it has none (#77). */
  readonly share: WebShare | undefined;
  /**
   * Whether this device has seen the first-run guide (#91). Without one, as in
   * most tests, the guide never shows.
   */
  readonly guide?: GuideRecord;
}

/**
 * The browser's clipboard. A browser without one (an insecure origin) rejects.
 *
 * Text that is still on its way goes in a `ClipboardItem` holding the
 * promise, where the browser has one. Safari allows a clipboard write only
 * inside the tap that asked for it, and an invite link is ready only after
 * the relay has its envelope, so the write starts at the tap and the browser
 * waits for the text. When the promise rejects, the clipboard is left alone.
 */
export async function copyToClipboard(text: string | Promise<string>): Promise<void> {
  if (typeof text === 'string') {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof ClipboardItem === 'function') {
    const blob = text.then((ready) => new Blob([ready], { type: 'text/plain' }));
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}
