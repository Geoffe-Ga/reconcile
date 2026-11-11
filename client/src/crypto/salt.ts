/**
 * Ballot salts (#111; docs/spec/phase-1-spec.md §4): 16 random bytes on every
 * ballot, so the commitment a result carries can't be tested against guessed
 * ballots once the ballots themselves are gone.
 */
import { randomBytes } from '@noble/hashes/utils.js';

/** A ballot salt's length in bytes. */
export const BALLOT_SALT_BYTES = 16;

/** A fresh ballot salt from the platform's CSPRNG (`crypto.getRandomValues`). */
export function newBallotSalt(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(BALLOT_SALT_BYTES));
}
