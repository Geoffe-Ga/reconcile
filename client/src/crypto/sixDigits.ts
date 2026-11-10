/**
 * A link's confirmation number (#96; spec §3 "Second device"): 4 derived
 * bytes read as a big-endian unsigned 32-bit number, mod 10^6, written as
 * six digits with any leading zeros kept. Both devices show it, and the
 * person checks they match before anything is sent.
 */

/** How many bytes the number reads. */
const NUMBER_BYTES = 4;

/** How many digits it shows. */
const DIGITS = 6;

/** 10^6: the number of six-digit numbers. */
const MODULUS = 1_000_000;

/**
 * The six digits of `bytes`: u32be(bytes) mod 10^6, zero-padded.
 *
 * @throws {RangeError} unless `bytes` is exactly 4 bytes.
 */
export function sixDigits(bytes: Uint8Array): string {
  if (bytes.length !== NUMBER_BYTES) throw new RangeError('A link number comes from 4 bytes.');
  const value = new DataView(bytes.buffer, bytes.byteOffset, NUMBER_BYTES).getUint32(0);
  return String(value % MODULUS).padStart(DIGITS, '0');
}
