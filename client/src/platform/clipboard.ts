/**
 * Reading the clipboard (#444): the link bar's Paste, on a touch device,
 * reads it once inside that tap and nowhere else. The app never reads the
 * clipboard on its own (spec §8). Where the browser has no way to read
 * text, there's no Paste; where it refuses, the caller stops offering it.
 */

/** Reads the clipboard's text once; rejects where the browser refuses. */
export type ReadClipboard = () => Promise<string>;

/** The one `Clipboard` method used, as an insecure page or an old browser may lack it. */
export interface ClipboardText {
  readonly readText?: () => Promise<string>;
}

/** The browser's clipboard, when this page has one. */
function browserClipboard(): ClipboardText | undefined {
  return 'clipboard' in navigator ? navigator.clipboard : undefined;
}

/** A way to read the clipboard's text, or null where the browser has none. Making it reads nothing. */
export function clipboardReader(
  clipboard: ClipboardText | undefined = browserClipboard(),
): ReadClipboard | null {
  const readText = clipboard?.readText;
  if (readText === undefined) return null;
  return () => readText.call(clipboard);
}

/** `window.matchMedia`, or the part of it used here. */
export type MatchMedia = (query: string) => { readonly matches: boolean };

/** The browser's `matchMedia`, when this page has one. */
function browserMatchMedia(): MatchMedia | undefined {
  return typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined;
}

/** Whether the device's main pointer is coarse, as a touch screen's is. */
export function isTouch(match: MatchMedia | undefined = browserMatchMedia()): boolean {
  return match?.('(pointer: coarse)').matches === true;
}
