// STUB(invite): the tracer's invite carries the group secret itself in the
// link. #73 replaces it with a random seed, a 2-day invite mailbox holding the
// whole log, a preview, the inviter's token and the leaked-link warning.

/**
 * Invite links (spec §3 and §9): `${origin}/#/join/${secret}`.
 *
 * The link carries only the group secret, in 43 base64url characters; the
 * joiner derives the mailbox id and seal key from it (`crypto/groupKeys.ts`).
 * Everything that grants access sits after `#`, which browsers never send to
 * a server. The Join screen removes it from the address bar once read.
 */
import { base64url, fromBase64url } from '../engine/event';
import { parseRoute } from './router';

/** What an invite hands over: the group's secret. */
export interface Invite {
  /** The 32-byte group secret, from which the joiner derives the mailbox and seal key. */
  readonly secret: Uint8Array;
}

const PAYLOAD = /^[A-Za-z0-9_-]{43}$/;

/** The part of the link after `#/join/`: the secret in base64url. */
export function invitePayload(invite: Invite): string {
  return base64url(invite.secret);
}

/** The link to send: the app's origin, then the payload after `#`. */
export function inviteLink(origin: string, invite: Invite): string {
  return `${origin}/#/join/${invitePayload(invite)}`;
}

/** 43 base64url characters as 32 bytes, or null unless they encode exactly that. */
function decodeKey(text: string): Uint8Array | null {
  const bytes = fromBase64url(text);
  // Re-encoding catches a final character whose spare bits aren't zero.
  return base64url(bytes) === text ? bytes : null;
}

/** Reads a 43-character secret, or returns null for anything else. */
export function parseInvitePayload(payload: string): Invite | null {
  if (!PAYLOAD.test(payload)) return null;
  const secret = decodeKey(payload);
  return secret === null ? null : { secret };
}

/** The fragment of `text` when it's an absolute URL, else null. */
function fragmentOf(text: string): string | null {
  try {
    return new URL(text).hash;
  } catch {
    return null;
  }
}

/** Reads a pasted invite: the whole link, from any origin, or just its payload. */
export function parseInviteLink(text: string): Invite | null {
  const trimmed = text.trim();
  const hash = fragmentOf(trimmed);
  if (hash === null) return parseInvitePayload(trimmed);
  const route = parseRoute(hash);
  return route.name === 'join' && route.payload !== null ? parseInvitePayload(route.payload) : null;
}
