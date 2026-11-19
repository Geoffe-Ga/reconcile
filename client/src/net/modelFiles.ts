/**
 * Fetches the Bedfellows model's files from Reconcile's own origin and checks
 * each against its pin before anything uses it (#476; ADR-0080 §2).
 *
 * This is the one way the Bedfellows worker reaches the network, and it can
 * only ask for a pinned file by name: the request carries a fixed path under
 * `/models/` and nothing else, so no word, vector or score of the reader's can
 * ride on it, and every device asks for the same files. dependency-cruiser
 * lets the two model loaders, `src/bedfellows/embedder.ts` and
 * `src/bedfellows/judge.ts` (#478), import this module and nothing else of
 * `src/net`. The shelf classifier's loader, `src/shelf/classify.ts` (#493),
 * fetches its files the same way, on the steward's device only.
 *
 * The service worker keeps each file the first time it's fetched
 * (`serviceWorker.ts`), so this check runs on every load, cached or not.
 */
import { sha256OfFile } from '../crypto/hash';
import { BEDFELLOWS_FILES, type PinnedFile } from './modelPins';

/** A file that came back, but not the one pinned: it is never used. */
export class PinMismatchError extends Error {
  override readonly name = 'PinMismatchError';
}

/**
 * Every byte Bedfellows' first load downloads: what the reader sees before it
 * starts (#433). The shelf classifier's files are never in it (#493).
 */
export const MODEL_DOWNLOAD_BYTES = BEDFELLOWS_FILES.reduce((sum, pin) => sum + pin.bytes, 0);

/** A file name with no path in it: letters, digits, `.`, `_` and `-`, not starting with `.`. */
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Where `pin` is served: `/models/<file>` on our own origin.
 *
 * @throws {Error} when its name could reach anything outside `/models/`.
 */
export function modelUrl(pin: PinnedFile): string {
  if (!FILE_NAME.test(pin.file))
    throw new Error(`${JSON.stringify(pin.file)} is not a model file name.`);
  return `/models/${pin.file}`;
}

/** `bytes`' SHA-256 in lowercase hex. */
async function hexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await sha256OfFile(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `pin`'s bytes, fetched from our own origin and checked against its size and
 * SHA-256.
 *
 * @throws {PinMismatchError} when what came back isn't the pinned file.
 * @throws {Error} when the server doesn't send it.
 */
export async function fetchPinned(
  pin: PinnedFile,
  fetchFile: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetchFile(modelUrl(pin), {
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`The model file ${pin.file} couldn’t be fetched.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== pin.bytes || (await hexOf(bytes)) !== pin.sha256) {
    throw new PinMismatchError(`The model file ${pin.file} isn’t the one this version pins.`);
  }
  return bytes;
}
