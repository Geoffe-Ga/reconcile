/**
 * Random bytes for anything that needs a fair draw rather than a key (#126):
 * the relay minute a carried score is cast at. The platform's CSPRNG
 * (`crypto.getRandomValues`), through @noble/hashes, so the relay can't
 * predict a minute from any earlier one.
 */
import { randomBytes as cryptoRandomBytes } from '@noble/hashes/utils.js';

/** `length` fresh random bytes from the platform's CSPRNG. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(cryptoRandomBytes(length));
}
