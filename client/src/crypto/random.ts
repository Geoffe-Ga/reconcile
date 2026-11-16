/**
 * Random bytes for anything that needs a fair draw rather than a key: the
 * relay minute a carried score is cast at (#126), and the minute a forgotten
 * group's push registration is taken back (#356). The platform's CSPRNG
 * (`crypto.getRandomValues`), through @noble/hashes, so the relay can't
 * predict a minute from any earlier one.
 */
import { randomBytes as cryptoRandomBytes } from '@noble/hashes/utils.js';

/** `length` fresh random bytes from the platform's CSPRNG. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(cryptoRandomBytes(length));
}

/** A source of random bytes: {@link randomBytes} on a device, fixed bytes in a test. */
export type Random = (length: number) => Uint8Array;

/**
 * How many random bytes one {@link drawBelow} reads: 48 bits, so no whole
 * number below a span of up to 2^16, 45 days of minutes, is likelier than
 * another by more than one part in 2^32.
 */
const DRAW_BYTES = 6;

/**
 * A whole number drawn uniformly from 0 up to, but not including, `span`:
 * {@link DRAW_BYTES} bytes of `random`, read big-endian, modulo `span`.
 *
 * @throws {RangeError} when `span` isn't a safe whole number of at least 1.
 */
export function drawBelow(span: number, random: Random = randomBytes): number {
  if (!Number.isSafeInteger(span) || span < 1) {
    throw new RangeError('A draw needs a span of at least one whole number.');
  }
  return random(DRAW_BYTES).reduce((value, byte) => value * 256 + byte, 0) % span;
}
