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
