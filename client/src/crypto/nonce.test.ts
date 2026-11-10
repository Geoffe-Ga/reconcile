import { describe, expect, it } from 'vitest';

import { fromBase64url } from './base64url';
import { EVENT_NONCE_BYTES, newEventNonce } from './nonce';

describe('newEventNonce (#119)', () => {
  it('is 16 random bytes in unpadded base64url', () => {
    const nonce = newEventNonce();
    expect(EVENT_NONCE_BYTES).toBe(16);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fromBase64url(nonce)).toHaveLength(EVENT_NONCE_BYTES);
  });

  it('never repeats', () => {
    const nonces = new Set(Array.from({ length: 200 }, newEventNonce));
    expect(nonces.size).toBe(200);
  });
});
