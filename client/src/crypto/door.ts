/**
 * A group's front door: its keys, what derives from them, its signed page and
 * the padded boxes that carry applications and replies (#121; ADR-0038,
 * ADR-0019; docs/spec/phase-1-spec.md §4, Opt-ins).
 *
 * Opening a door makes two secrets on the proposer's device
 * ({@link newDoorSecrets}): an Ed25519 key that signs the door's page, whose
 * public half is the door's address, and an X25519 key that opens the
 * applications sealed to it. Both travel only inside the group's sealed log.
 *
 * Everything public derives from the address, through the same HKDF as a
 * group secret's (`hkdf.ts`), each under a label of its own:
 *
 * ```
 * page mailbox = base64url(HKDF(address, "reconcile/v1/door-page"))
 * page key     = HKDF(address, "reconcile/v1/door-page-key")
 * inbox        = base64url(HKDF(address, "reconcile/v1/door-inbox"))
 * reply mailbox = base64url(HKDF(reply seed, "reconcile/v1/door-reply"))
 * ```
 *
 * so whoever holds the link can read the page and post to the inbox, and the
 * relay, which never sees the address, can tie neither to the group, nor to
 * one another. A page counts only when the door's key signed it, under a tag
 * of its own (`sign.ts`), so a reader who could seal one into the page
 * mailbox still can't forge one.
 *
 * Applications and replies are boxes (`box.ts`) whose plaintext is framed as
 * a seal's body is: a 4-byte big-endian length, the plaintext, then zeros,
 * sized so the whole box is exactly one of the four blob sizes the relay
 * takes, and bound to the mailbox it goes to as the AAD. An application is
 * sealed to the page's `box` key, so only the members' devices open it; a
 * reply is sealed to a key only the applicant's device holds.
 * `vectors/door.json` pins all of it, computed outside @noble.
 */
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';
import { BOX_OVERHEAD, kxPublicKeyOf, openBox, sealTo } from './box';
import { sha256 } from './hash';
import { hkdf32 } from './hkdf';
import { openTagged, signTagged } from './record';
import { BLOB_SIZES, isBlobSize, PayloadTooLarge, unframeBody } from './seal';
import { DOOR_PAGE_CONTEXT, publicKeyOf, type SigningKeys } from './sign';

/** A door secret's length in bytes, either kind, and a reply seed's. */
export const DOOR_SECRET_BYTES = 32;

/** The HKDF label of a door's page mailbox id. */
export const DOOR_PAGE_INFO = 'reconcile/v1/door-page';

/** The HKDF label of the key a door's page is sealed under. */
export const DOOR_PAGE_KEY_INFO = 'reconcile/v1/door-page-key';

/** The HKDF label of a door's inbox mailbox id. */
export const DOOR_INBOX_INFO = 'reconcile/v1/door-inbox';

/** The HKDF label of a reply mailbox id, derived from the applicant's reply seed. */
export const DOOR_REPLY_INFO = 'reconcile/v1/door-reply';

/** The box label of an application, sealed to the door's `box` key. */
export const APPLICATION_INFO = 'reconcile/v1/door-application';

/** The box label of a reply, sealed to the applicant's reply key. */
export const REPLY_INFO = 'reconcile/v1/door-reply-box';

/** The bytes before a padded box's plaintext: its 4-byte length. */
const LENGTH_BYTES = 4;

/**
 * The largest plaintext a padded box carries: the largest blob, 65,536
 * bytes, less the box's 72 and the frame's 4-byte length, so 65,460. What an
 * application may hold is measured against it (#425).
 */
export const MAX_PADDED_PLAINTEXT = Math.max(...BLOB_SIZES) - BOX_OVERHEAD - LENGTH_BYTES;

/** A door's two secrets, as the proposer's device draws them. */
export interface DoorSecrets {
  /** The Ed25519 secret key (RFC 8032 seed) the page is signed with. */
  readonly sign: Uint8Array<ArrayBuffer>;
  /** The X25519 secret key that opens the applications. */
  readonly box: Uint8Array<ArrayBuffer>;
}

/** A door's keys: the page's signing pair, and the box pair applications are sealed to. */
export interface DoorKeys {
  readonly signing: SigningKeys;
  readonly boxSecret: Uint8Array;
  readonly boxPublic: Uint8Array;
}

/** Where a door's page and applications go, and the key its page is sealed under. */
export interface DoorChannels {
  /** The page mailbox id. */
  readonly page: string;
  /** The XChaCha20-Poly1305 key the page's copies are sealed under. */
  readonly pageKey: Uint8Array;
  /** The inbox mailbox id, where applications go. */
  readonly inbox: string;
}

/** A new door's two secrets: 32 bytes each from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newDoorSecrets(): DoorSecrets {
  return {
    sign: Uint8Array.from(randomBytes(DOOR_SECRET_BYTES)),
    box: Uint8Array.from(randomBytes(DOOR_SECRET_BYTES)),
  };
}

/** A new reply seed: 32 bytes from the platform's CSPRNG. */
export function newReplySeed(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(DOOR_SECRET_BYTES));
}

/** The keys a door's two secrets make: any 32 bytes are a secret of either kind. */
export function doorKeysOf(sign: Uint8Array, box: Uint8Array): DoorKeys {
  return {
    signing: { secretKey: sign, publicKey: publicKeyOf(sign) },
    boxSecret: box,
    boxPublic: kxPublicKeyOf(box),
  };
}

/**
 * The page mailbox, page key and inbox that a door's address derives.
 *
 * @throws {RangeError} when `address` isn't 32 bytes.
 */
export function doorChannelsOf(address: Uint8Array): DoorChannels {
  if (address.length !== DOOR_SECRET_BYTES) throw new RangeError('A door key is 32 bytes.');
  return {
    page: base64url(hkdf32(address, DOOR_PAGE_INFO)),
    pageKey: hkdf32(address, DOOR_PAGE_KEY_INFO),
    inbox: base64url(hkdf32(address, DOOR_INBOX_INFO)),
  };
}

/**
 * The reply mailbox id a reply seed derives.
 *
 * @throws {RangeError} when `seed` isn't 32 bytes.
 */
export function replyMailboxOf(seed: Uint8Array): string {
  if (seed.length !== DOOR_SECRET_BYTES) throw new RangeError('A reply seed is 32 bytes.');
  return base64url(hkdf32(seed, DOOR_REPLY_INFO));
}

/** The record for one copy of a door's page: the door's public key ‖ its signature ‖ the page. */
export function signDoorRecord(keys: SigningKeys, page: Uint8Array): Uint8Array<ArrayBuffer> {
  return signTagged(DOOR_PAGE_CONTEXT, keys, page);
}

/**
 * The page inside `record` when its key is exactly `address`, the one the
 * link names, and its signature verifies under the door-page tag; otherwise
 * null.
 */
export function openDoorRecord(record: Uint8Array, address: Uint8Array): Uint8Array | null {
  return openTagged(DOOR_PAGE_CONTEXT, record, address);
}

/**
 * `plaintext` framed for a padded box: its length, the plaintext, then zeros,
 * so the box around it is exactly the smallest blob size that fits.
 *
 * @throws {PayloadTooLarge} when it is too large for the largest blob.
 */
function framed(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = BLOB_SIZES.find((candidate) => {
    return plaintext.length + LENGTH_BYTES + BOX_OVERHEAD <= candidate;
  });
  if (size === undefined) throw new PayloadTooLarge(plaintext.length);
  const body = new Uint8Array(size - BOX_OVERHEAD);
  new DataView(body.buffer).setUint32(0, plaintext.length);
  body.set(plaintext, LENGTH_BYTES);
  return body;
}

/**
 * Seals `plaintext` to the X25519 `publicKey` for `mailbox`, under `info`,
 * as a box of exactly one of the four blob sizes.
 *
 * @throws {PayloadTooLarge} when it is too large for the largest blob.
 * @throws {RangeError} when `publicKey` isn't a key a box can be sealed to.
 */
export function sealPadded(
  publicKey: Uint8Array,
  plaintext: Uint8Array,
  info: string,
  mailbox: string,
): Uint8Array<ArrayBuffer> {
  return sealTo(publicKey, framed(plaintext), info, utf8ToBytes(mailbox));
}

/**
 * The plaintext in a padded box for the holder of `secretKey`, read from
 * `mailbox` under `info`, or null: a blob of another size, one that doesn't
 * open, or a frame whose length runs past it or whose padding isn't zeros.
 */
export function openPadded(
  secretKey: Uint8Array,
  blob: Uint8Array,
  info: string,
  mailbox: string,
): Uint8Array | null {
  if (!isBlobSize(blob.length)) return null;
  const body = openBox(secretKey, blob, info, utf8ToBytes(mailbox));
  return body === null ? null : unframeBody(body);
}

/**
 * An application's id: the SHA-256 of its sealed blob, in unpadded base64url,
 * as every member's device reads it from the inbox, and as a `door-invited`
 * names it (engine/frontDoor.ts).
 */
export function applicationIdOf(blob: Uint8Array): string {
  return base64url(sha256(blob));
}
