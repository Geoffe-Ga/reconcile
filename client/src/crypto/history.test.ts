import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  HISTORY_INFO,
  HISTORY_SEALED_BYTES,
  MAX_HISTORY_PLAINTEXT,
  openHistory,
  sealHistory,
} from './history';
import { sealVault } from './keyVault';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

const keys = fc.uint8Array({ minLength: 32, maxLength: 32 });
const plaintexts = fc.uint8Array({ maxLength: 2048 });

/** HKDF-SHA-256 with an empty salt by the platform's WebCrypto: a second implementation. */
async function platformHkdf(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const params = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: Uint8Array.from(utf8ToBytes(info)),
  };
  return new Uint8Array(await crypto.subtle.deriveBits(params, key, 256));
}

describe('the Bedfellows history seal (#480)', () => {
  it('is exactly 64 KiB, however much it holds, so its size says nothing', () => {
    expect(HISTORY_SEALED_BYTES).toBe(65536);
    for (const length of [0, 1, 300, MAX_HISTORY_PLAINTEXT]) {
      expect(sealHistory(KEY, new Uint8Array(length)).length).toBe(HISTORY_SEALED_BYTES);
    }
  });

  it('opens to exactly what it sealed, under the same key', () => {
    fc.assert(
      fc.property(keys, plaintexts, (key, plaintext) => {
        expect(openHistory(key, sealHistory(key, plaintext))).toEqual(plaintext);
      }),
    );
  });

  it('seals under a fresh nonce each time', () => {
    const plaintext = Uint8Array.of(1, 2, 3);
    expect(sealHistory(KEY, plaintext)).not.toEqual(sealHistory(KEY, plaintext));
  });

  it('opens under no other key, and not once any byte changes', () => {
    const sealed = sealHistory(KEY, utf8ToBytes('{"entries":[]}'));
    expect(openHistory(OTHER_KEY, sealed)).toBeNull();
    for (const index of [0, 23, 24, 1000, HISTORY_SEALED_BYTES - 1]) {
      const changed = Uint8Array.from(sealed);
      changed[index] = (changed[index] ?? 0) ^ 1;
      expect(openHistory(KEY, changed)).toBeNull();
    }
  });

  it('answers null for a sealed history of any other length', () => {
    const sealed = sealHistory(KEY, Uint8Array.of(7));
    expect(openHistory(KEY, sealed.subarray(0, HISTORY_SEALED_BYTES - 1))).toBeNull();
    expect(openHistory(KEY, new Uint8Array(0))).toBeNull();
    expect(openHistory(KEY, Uint8Array.from([...sealed, 0]))).toBeNull();
  });

  it('never opens the key vault, sealed under the same key, nor the vault the history', () => {
    const vault = sealVault(KEY, Uint8Array.of(1), new Uint8Array(HISTORY_SEALED_BYTES - 40));
    expect(vault.length).toBe(HISTORY_SEALED_BYTES);
    expect(openHistory(KEY, vault)).toBeNull();
  });

  it('seals under HKDF of the vault key with its own label, and the label as associated data', async () => {
    expect(HISTORY_INFO).toBe('reconcile/v1/bedfellows-history');
    const plaintext = utf8ToBytes('kept');
    const sealed = sealHistory(KEY, plaintext);
    const subkey = await platformHkdf(KEY, HISTORY_INFO);
    const body = xchacha20poly1305(
      subkey,
      sealed.subarray(0, 24),
      utf8ToBytes(HISTORY_INFO),
    ).decrypt(sealed.subarray(24));
    expect(new DataView(body.buffer, body.byteOffset).getUint32(0)).toBe(plaintext.length);
    expect(body.subarray(4, 4 + plaintext.length)).toEqual(plaintext);
    expect(body.subarray(4 + plaintext.length).every((byte) => byte === 0)).toBe(true);
  });

  it('refuses a plaintext too long for the slot, and a key that isn’t 32 bytes', () => {
    expect(() => sealHistory(KEY, new Uint8Array(MAX_HISTORY_PLAINTEXT + 1))).toThrow(RangeError);
    expect(() => sealHistory(new Uint8Array(31), Uint8Array.of(1))).toThrow(RangeError);
    expect(openHistory(new Uint8Array(31), sealHistory(KEY, Uint8Array.of(1)))).toBeNull();
  });
});
