/**
 * Unpadded base64url (RFC 4648 §5), the one text form of the app's keys and
 * ids: an event's `author` and id, a mailbox id and the tracer's invite.
 *
 * It lives in src/crypto so the key derivations here can name a mailbox
 * without reaching up into the engine; the engine re-exports it.
 */

/** Encodes bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url, with or without padding, to bytes. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
