import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { sha256, sha256OfFile } from './hash';
import { utf8 } from '../test/bytes';

/** Lower-case hex of `bytes`. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 by the platform's WebCrypto: an implementation independent of @noble/hashes. */
async function platformSha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))));
}

describe('sha256', () => {
  it('starts like the FIPS 180-2 digests of "" (e3b0c442…) and "abc" (ba7816bf…)', () => {
    expect(hex(sha256(new Uint8Array(0))).slice(0, 8)).toBe('e3b0c442');
    expect(hex(sha256(utf8('abc'))).slice(0, 8)).toBe('ba7816bf');
  });

  it('gives the 32-byte digest WebCrypto gives, for any bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), async (bytes) => {
        const digest = sha256(bytes);
        expect(digest).toHaveLength(32);
        expect(hex(digest)).toBe(await platformSha256(bytes));
      }),
    );
  });
});

describe('sha256OfFile (#476)', () => {
  it('gives the same digest as sha256, through WebCrypto where the context has it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), async (bytes) => {
        expect(hex(await sha256OfFile(bytes))).toBe(hex(sha256(bytes)));
      }),
    );
  });

  it('falls back to @noble/hashes where WebCrypto is missing, as on a phone over plain http', async () => {
    vi.stubGlobal('crypto', {});
    try {
      expect(hex(await sha256OfFile(utf8('abc'))).slice(0, 8)).toBe('ba7816bf');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
