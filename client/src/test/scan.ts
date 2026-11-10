/**
 * Canary spellings for byte scans, shared by the unit tests and the
 * end-to-end scan (`e2e/support/scan.ts`, #71): every way a leak could write
 * a canary down, with nothing but the platform's own `btoa`.
 *
 * A canary is checked as its own bytes (UTF-8 for text, raw for a key), as
 * hex in either case, and as standard and URL-safe base64 at all three byte
 * alignments. Base64 of bytes that start at an offset that isn't a multiple
 * of 3 within a longer run spells them differently, so each alignment drops
 * the canary's first bytes up to the next group of 3, and its tail past the
 * last whole group: what's left is spelled the same wherever it sits.
 */
import { base64url } from '../crypto/base64url';
import { contains } from './bytes';

/** One way a canary could be written down: an encoding and the bytes it leaves. */
export interface Spelling {
  readonly encoding: string;
  readonly needle: Uint8Array;
}

/** Something a scanned file must never hold, under a name for the report. */
export interface Canary {
  readonly label: string;
  readonly bytes: Uint8Array;
}

/** The shortest canary whose every spelling still has a few bytes left to look for. */
export const MIN_CANARY_BYTES = 8;

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Standard, padded base64 of `bytes`. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Every spelling of `bytes` a scan looks for. */
export function spellings(bytes: Uint8Array): Spelling[] {
  if (bytes.length < MIN_CANARY_BYTES) {
    throw new RangeError(`A canary needs at least ${String(MIN_CANARY_BYTES)} bytes.`);
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const found: Spelling[] = [
    { encoding: 'bytes', needle: bytes },
    { encoding: 'hex', needle: ascii(hex) },
    { encoding: 'HEX', needle: ascii(hex.toUpperCase()) },
  ];
  for (let offset = 0; offset < 3; offset += 1) {
    const start = (3 - offset) % 3;
    const whole = bytes.subarray(start, start + 3 * Math.floor((bytes.length - start) / 3));
    found.push({ encoding: `base64 at offset ${String(offset)}`, needle: ascii(base64(whole)) });
    found.push({
      encoding: `base64url at offset ${String(offset)}`,
      needle: ascii(base64url(whole)),
    });
  }
  return found;
}

/** A canary for `text`: its UTF-8 bytes. */
export function textCanary(label: string, text: string): Canary {
  return { label, bytes: Uint8Array.from(new TextEncoder().encode(text)) };
}

/** Canaries for a key or id: its raw bytes, and its base64url text, as events carry it. */
export function keyCanaries(label: string, bytes: Uint8Array): Canary[] {
  return [{ label: `${label} (raw)`, bytes }, textCanary(`${label} (base64url)`, base64url(bytes))];
}

/** Each canary in `haystack`, in each spelling, as "label, as encoding" lines. */
export function findCanaries(haystack: Uint8Array, canaries: readonly Canary[]): string[] {
  return canaries.flatMap(({ label, bytes }) =>
    spellings(bytes)
      .filter(({ needle }) => contains(haystack, needle))
      .map(({ encoding }) => `${label}, as ${encoding}`),
  );
}
