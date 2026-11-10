/**
 * Invite links (spec §3 "Invite seed" and §9): `${origin}/#join/${seed}`.
 *
 * The link carries only the invite seed, 32 random bytes in 43 base64url
 * characters. The invite mailbox id and the key its envelope is sealed under
 * derive from the seed (`crypto/invite.ts`); the group secret travels inside
 * the sealed envelope, never in the link. Everything that grants access sits
 * after `#`, which browsers never send to a server, and the Join screen
 * removes it from the address bar once read.
 */
import { base64url, fromBase64url } from '../engine/event';
import { parseRoute, routeHref } from './router';

const PAYLOAD = /^[A-Za-z0-9_-]{43}$/;

/** The link to send: the app's origin, then the seed after `#join/`. */
export function inviteLink(origin: string, seed: Uint8Array): string {
  return `${origin}/${routeHref({ name: 'join', payload: base64url(seed) })}`;
}

/** 43 base64url characters as the 32-byte seed, or null for anything else. */
export function parseInvitePayload(payload: string): Uint8Array | null {
  if (!PAYLOAD.test(payload)) return null;
  const seed = fromBase64url(payload);
  // Re-encoding catches a final character whose spare bits aren't zero.
  return base64url(seed) === payload ? seed : null;
}

/** The fragment of `text` when it's an absolute URL, else null. */
function fragmentOf(text: string): string | null {
  try {
    return new URL(text).hash;
  } catch {
    return null;
  }
}

/**
 * The 32-byte seed in a pasted invite, or null: the whole link, from any
 * origin, or just the bare 43-character seed. Start's paste field and the
 * Join screen both read invites through it.
 */
export function parseInviteLink(text: string): Uint8Array | null {
  const trimmed = text.trim();
  const hash = fragmentOf(trimmed);
  if (hash === null) return parseInvitePayload(trimmed);
  const route = parseRoute(hash);
  return route.name === 'join' && route.payload !== null ? parseInvitePayload(route.payload) : null;
}
