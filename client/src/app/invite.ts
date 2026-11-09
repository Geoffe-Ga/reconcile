// STUB(invite): the tracer's invite carries the group's mailbox id and stub
// secret in the link itself. #73 replaces it with a random seed, a 2-day
// invite mailbox holding the whole log, a preview, the inviter's token and
// the leaked-link warning.

/**
 * Invite links (spec §3 and §9): `${origin}/#/join/${mailbox}.${secret}`.
 *
 * Everything that grants access sits after `#`, which browsers never send to
 * a server. The Join screen removes it from the address bar once read.
 */
import { base64url } from '../engine/event';
import { parseRoute } from './router';

/** What an invite hands over: the group's mailbox at the relay and its secret. */
export interface Invite {
  /** The group's mailbox id: 32 random bytes as 43 base64url characters. */
  readonly mailbox: string;
  /** STUB(seal): the 32-byte group secret, used as the seal key until #71. */
  readonly secret: Uint8Array;
}

const KEY_BYTES = 32;
const PART = /^[A-Za-z0-9_-]{43}$/;

/** A new group's mailbox id and secret, from the browser's CSPRNG. */
export function newInvite(): Invite {
  const mailbox = base64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
  return { mailbox, secret: crypto.getRandomValues(new Uint8Array(KEY_BYTES)) };
}

/** The part of the link after `#/join/`. */
export function invitePayload(invite: Invite): string {
  return `${invite.mailbox}.${base64url(invite.secret)}`;
}

/** The link to send: the app's origin, then the payload after `#`. */
export function inviteLink(origin: string, invite: Invite): string {
  return `${origin}/#/join/${invitePayload(invite)}`;
}

/** 43 base64url characters as 32 bytes, or null unless they encode exactly that. */
function decodeKey(text: string): Uint8Array | null {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Re-encoding catches a final character whose spare bits aren't zero.
  return base64url(bytes) === text ? bytes : null;
}

/** Reads `mailbox.secret`, or returns null for anything else. */
export function parseInvitePayload(payload: string): Invite | null {
  const parts = payload.split('.');
  const [mailbox, key] = parts;
  if (parts.length !== 2 || mailbox === undefined || key === undefined) return null;
  if (!PART.test(mailbox) || !PART.test(key)) return null;
  const secret = decodeKey(key);
  return secret === null ? null : { mailbox, secret };
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
