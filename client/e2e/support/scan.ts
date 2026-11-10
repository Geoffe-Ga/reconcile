/**
 * The scan behind relay-learns-nothing.spec.ts (#71): looks for canaries in
 * raw bytes, in every spelling a leak could take.
 *
 * A canary is checked in every spelling `src/test/scan.ts` lists, the one
 * list the unit tests scan with too: its own bytes, hex in either case, and
 * standard and URL-safe base64 at all three byte alignments.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { spellings as spellingsOf } from '../../src/test/scan';

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
  return spellingsOf(bytes).map(({ encoding, needle }) => ({
    encoding,
    needle: Buffer.from(needle),
  }));
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
