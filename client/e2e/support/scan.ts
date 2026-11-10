/**
 * The scan behind relay-learns-nothing.spec.ts (#71): looks for canaries in
 * raw bytes, in every spelling a leak could take.
 *
 * A canary is checked as its own bytes (UTF-8 for text, raw for a key), as
 * hex in either case, and as standard and URL-safe base64 at all three byte
 * alignments. Base64 of bytes that start at an offset that isn't a multiple
 * of 3 within a longer run spells them differently, so each alignment drops
 * the canary's first bytes up to the next group of 3, and its tail past the
 * last whole group: what's left is spelled the same wherever it sits.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Something the relay must never hold, under a name for the report. */
export interface Canary {
  readonly label: string;
  readonly bytes: Uint8Array;
}

/** One way a canary could be written down: an encoding and the bytes it leaves. */
export interface Spelling {
  readonly encoding: string;
  readonly needle: Buffer;
}

/** A canary that turned up. */
export interface Finding {
  readonly label: string;
  readonly encoding: string;
  readonly file: string;
}

/** The shortest canary whose every spelling still has a few bytes left to look for. */
const MIN_CANARY_BYTES = 8;

/** A canary for `text`: its UTF-8 bytes. */
export function textCanary(label: string, text: string): Canary {
  return { label, bytes: Buffer.from(text, 'utf8') };
}

/** Canaries for a key or id: its raw bytes, and its base64url text, as events carry it. */
export function keyCanaries(label: string, bytes: Uint8Array): Canary[] {
  return [
    { label: `${label} (raw)`, bytes },
    textCanary(`${label} (base64url)`, Buffer.from(bytes).toString('base64url')),
  ];
}

/** Every spelling of `bytes` the scan looks for. */
export function spellings(bytes: Uint8Array): Spelling[] {
  if (bytes.length < MIN_CANARY_BYTES) {
    throw new RangeError(`A canary needs at least ${String(MIN_CANARY_BYTES)} bytes.`);
  }
  const raw = Buffer.from(bytes);
  const hex = raw.toString('hex');
  const found: Spelling[] = [
    { encoding: 'bytes', needle: raw },
    { encoding: 'hex', needle: Buffer.from(hex) },
    { encoding: 'HEX', needle: Buffer.from(hex.toUpperCase()) },
  ];
  for (let offset = 0; offset < 3; offset += 1) {
    const start = (3 - offset) % 3;
    const whole = raw.subarray(start, start + 3 * Math.floor((raw.length - start) / 3));
    for (const encoding of ['base64', 'base64url'] as const) {
      const needle = Buffer.from(whole.toString(encoding));
      found.push({ encoding: `${encoding} at offset ${String(offset)}`, needle });
    }
  }
  return found;
}

/** Every spelling of every canary in `haystack`, which came from `file`. */
export function findIn(haystack: Buffer, file: string, canaries: readonly Canary[]): Finding[] {
  return canaries.flatMap(({ label, bytes }) =>
    spellings(bytes)
      .filter(({ needle }) => haystack.includes(needle))
      .map(({ encoding }) => ({ label, encoding, file: basename(file) })),
  );
}

/** Every canary found in `files`, each read whole as raw bytes. A file that doesn't exist holds nothing. */
export function scan(files: readonly string[], canaries: readonly Canary[]): Finding[] {
  return files
    .filter((file) => existsSync(file))
    .flatMap((file) => findIn(readFileSync(file), file, canaries));
}

/** A finding as one line of a test report. */
export function describeFinding({ label, encoding, file }: Finding): string {
  return `${label}, as ${encoding}, in ${file}`;
}
