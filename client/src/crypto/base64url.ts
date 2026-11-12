/**
 * Unpadded base64url (RFC 4648 §5), the one text form of the app's keys and
 * ids: an event's `author` and id, a mailbox id and the tracer's invite.
 *
 * It lives in src/crypto so the key derivations here can name a mailbox
 * without reaching up into the engine; the engine re-exports it.
 */

/**
 * Bytes per `String.fromCharCode` call: well under every engine's argument
 * limit, and far faster than one call per byte for a backup's megabytes (#97).
 */
const CHUNK = 0x8000;

/** The Latin-1 string whose code units are `bytes`, one character per byte. */
function binaryOf(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK) {
    // `apply` reads any array-like, a typed array included, without the
    // iterator a spread would run: about 7 times faster on 12 MB. TypeScript
    // types its arguments as an array, so the chunk is cast to one.
    const chunk = bytes.subarray(at, at + CHUNK) as unknown as number[];
    parts.push(String.fromCharCode.apply(null, chunk));
  }
  return parts.join('');
}

/** Encodes bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  return btoa(binaryOf(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url, with or without padding, to bytes. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The bytes `value` spells in canonical unpadded base64url, or null for
 * anything else: not a string, padding, another alphabet, whitespace, spare
 * bits set in the last character, or a length no base64 has. Each byte string
 * has exactly one spelling it accepts.
 */
export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64url(value);
    return base64url(bytes) === value ? bytes : null;
  } catch {
    // A length no base64 has, such as one character.
    return null;
  }
}
