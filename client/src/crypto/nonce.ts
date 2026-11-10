/**
 * Event nonces (#119): random bytes an event carries only so that its bytes,
 * and so its id, are its own. Two devices holding one membership key (#78)
 * that claim the same chat bot notice in the same millisecond would otherwise
 * sign identical bytes, and each would take the other's claim for its own.
 */
import { randomBytes } from '@noble/hashes/utils.js';

import { base64url } from './base64url';

/** How many random bytes a nonce holds: 128 bits, so two never meet. */
export const EVENT_NONCE_BYTES = 16;

/** A new nonce: {@link EVENT_NONCE_BYTES} from the platform's CSPRNG, in unpadded base64url. */
export function newEventNonce(): string {
  return base64url(randomBytes(EVENT_NONCE_BYTES));
}
