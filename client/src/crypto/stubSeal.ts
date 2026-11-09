// STUB(seal): frames and pads like the real seal but encrypts nothing. #71
// replaces it with XChaCha20-Poly1305 under a key derived from the group
// secret. Until then the relay stores readable event bytes, so the tracer must
// carry throwaway text only.

/**
 * The tracer's stand-in for the real seal (#71).
 *
 * Its blobs have the real seal's layout and sizes, so swapping in the real
 * one changes no caller and no blob size: a zero-filled nonce slot, the framed
 * body in the clear, then a zero-filled tag slot.
 */

import { NONCE_BYTES, TAG_BYTES, frameBody, isBlobSize, isZero, unframeBody } from './seal';
import type { Seal } from './seal';

/** Seal and open without encryption; the mailbox and key play no part yet. */
export const stubSeal: Seal = {
  seal(_mailbox, _key, plaintext) {
    const body = frameBody(plaintext);
    const blob = new Uint8Array(NONCE_BYTES + body.length + TAG_BYTES);
    blob.set(body, NONCE_BYTES);
    return blob;
  },

  open(_mailbox, _key, blob) {
    if (!isBlobSize(blob.length)) {
      return null;
    }
    const tagStart = blob.length - TAG_BYTES;
    if (!isZero(blob.subarray(0, NONCE_BYTES)) || !isZero(blob.subarray(tagStart))) {
      return null;
    }
    return unframeBody(blob.subarray(NONCE_BYTES, tagStart));
  },
};
