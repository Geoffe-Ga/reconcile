/**
 * A test-only seal that frames and pads like the real one (`src/crypto/seal.ts`)
 * but encrypts nothing.
 *
 * Its blobs have the real seal's layout and sizes: a zero-filled nonce slot,
 * the framed body in the clear, then a zero-filled tag slot. Tests use it to
 * check that the real seal keeps the stub's blob sizes, and to show that the
 * relay-learns-nothing e2e catches readable blobs. It lives in src/test, so
 * dependency-cruiser's `test-helpers-stay-in-tests` keeps the app from ever
 * importing it.
 */

import { NONCE_BYTES, TAG_BYTES, frameBody, isBlobSize, isZero, unframeBody } from '../crypto/seal';
import type { Seal } from '../crypto/seal';

/** Seal and open without encryption; the mailbox and key play no part. */
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
