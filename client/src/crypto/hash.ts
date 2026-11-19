/**
 * SHA-256, for the engine's event ids and name suffixes (spec §3–§4).
 *
 * Only src/crypto imports `@noble/*` (spec §2), so the engine hashes through here.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

/** The 32-byte SHA-256 digest of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/**
 * The SHA-256 digest of a large file's `bytes`, such as the Bedfellows model's
 * (#476): through the platform's WebCrypto, several times faster on a phone,
 * where the context has it (any https page, the deployed app included), and
 * through @noble/hashes where it doesn't (a page served over plain http, such
 * as the model-measuring page on a home network).
 */
export async function sha256OfFile(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) return nobleSha256(bytes);
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}
