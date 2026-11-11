/**
 * Seat proofs (#100; ADR-0009, ADR-0036): how a coalition knows which member
 * group a participant came from, without learning who they are.
 *
 * A group that reconciles makes a seat: an Ed25519 keypair whose secret sits
 * in the group's reconcile Proposal, in its sealed log, and whose public key
 * the coalition's genesis names. Someone from that group joins the coalition
 * under a fresh key of their own, never their group key, and carries a proof:
 * the seat secret's signature over the coalition id's UTF-8, one 0x00 byte,
 * then the joiner's 32-byte public key, under the seat tag. The proof shows
 * the group, not the member: any holder of the seat secret can make one, and
 * nothing in it names the person.
 */
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { PUBLIC_KEY_BYTES, publicKeyOf, SEAT_CONTEXT, sign, verify } from './sign';

/** The byte between the coalition id and the joiner's key. */
const SEPARATOR = Uint8Array.of(0);

/** The public seat key of a 32-byte seat secret: what a coalition genesis names. */
export function seatKeyOf(seatSecret: Uint8Array): Uint8Array {
  return publicKeyOf(seatSecret);
}

/**
 * What a seat proof signs: the coalition id's UTF-8, 0x00, then the joiner's
 * 32-byte public key.
 */
export function seatProofMessage(coalitionId: string, joiner: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes(coalitionId), SEPARATOR, joiner);
}

/**
 * The 64-byte proof that `joiner` comes from the seat `seatSecret` makes, in
 * the coalition `coalitionId`.
 *
 * @throws {RangeError} when `joiner` isn't 32 bytes.
 */
export function signSeatProof(
  seatSecret: Uint8Array,
  coalitionId: string,
  joiner: Uint8Array,
): Uint8Array {
  if (joiner.length !== PUBLIC_KEY_BYTES) throw new RangeError('A joiner key is 32 bytes.');
  return sign(SEAT_CONTEXT, seatSecret, seatProofMessage(coalitionId, joiner));
}

/**
 * Whether `proof` is the seat `seatKey`'s proof for `joiner` in the coalition
 * `coalitionId`, under strict RFC 8032 rules. A key, joiner or proof of the
 * wrong length is refused, not thrown on.
 */
export function verifySeatProof(
  seatKey: Uint8Array,
  proof: Uint8Array,
  coalitionId: string,
  joiner: Uint8Array,
): boolean {
  if (joiner.length !== PUBLIC_KEY_BYTES) return false;
  return verify(SEAT_CONTEXT, seatKey, proof, seatProofMessage(coalitionId, joiner));
}
