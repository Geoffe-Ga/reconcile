/**
 * A vote link's token (#472, ADR-0079 §1; spec §9).
 *
 * A vote link is `#vote/{token}`. The token is the first 16 bytes of
 * HKDF-SHA-256 of the group's secret, with an empty salt, under the info
 * {@link VOTE_LINK_LABEL}, a 0x00 byte and the Proposal's event id, in
 * unpadded base64url: 22 characters. Only a device that holds the group's
 * secret can make or match one, so a link names no group and no Proposal,
 * and one coalition motion's links in two groups have nothing in common.
 * The token is never stored or sent: a device computes it when it shares or
 * opens a link. `vectors/vote-link.json`, computed with Node's own `crypto`,
 * pins it outside @noble.
 */
import { base64url } from './base64url';
import { GROUP_SECRET_BYTES } from './groupKeys';
import { hkdfSalted } from './hkdf';

/** The HKDF label of a vote link's token (spec §3), so it never coincides with another derivation. */
export const VOTE_LINK_LABEL = 'reconcile/v1/vote-link';

/** The bytes a token takes from HKDF. */
const TOKEN_BYTES = 16;

/** A token's length in unpadded base64url: 16 bytes make 22 characters. */
export const VOTE_TOKEN_LENGTH = 22;

/** A token as a link spells it: 22 unpadded base64url characters. */
export const VOTE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** An event id as an event spells it: 32 bytes in unpadded base64url. */
const EVENT_ID = /^[A-Za-z0-9_-]{43}$/;

/** HKDF's info for `proposal`'s token: the label's UTF-8, a 0x00 byte, then the id's UTF-8. */
export function voteLinkInfo(proposal: string): Uint8Array {
  const encoder = new TextEncoder();
  const label = encoder.encode(VOTE_LINK_LABEL);
  const id = encoder.encode(proposal);
  const info = new Uint8Array(label.length + 1 + id.length);
  info.set(label, 0);
  info.set(id, label.length + 1);
  return info;
}

/**
 * The token of a link to `proposal` in the group whose secret is `secret`.
 *
 * @throws {RangeError} when `secret` isn't 32 bytes, or `proposal` isn't an event id.
 */
export function voteToken(secret: Uint8Array, proposal: string): string {
  if (secret.length !== GROUP_SECRET_BYTES) throw new RangeError('A group secret is 32 bytes.');
  if (!EVENT_ID.test(proposal)) throw new RangeError('A vote link needs a Proposal’s event id.');
  return base64url(hkdfSalted(secret, new Uint8Array(0), voteLinkInfo(proposal), TOKEN_BYTES));
}
