/**
 * Byte helpers for tests.
 *
 * Under jsdom, `TextEncoder` and `structuredClone` (which fake-indexeddb uses)
 * return typed arrays from jsdom's realm, which never deep-equal the test's
 * own `Uint8Array`s. These helpers keep every array in the test's realm.
 */

/** `text` as UTF-8 bytes, in the test's realm. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(text));
}

/** `bytes` decoded as UTF-8. */
export function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A copy of `bytes` in the test's realm, so `toEqual` can compare it. */
export function local(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

/** Hex as bytes, in the test's realm. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** The bytes of `parts`, one after another, in the test's realm. */
export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}
