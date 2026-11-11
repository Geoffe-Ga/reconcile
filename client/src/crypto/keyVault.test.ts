import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  newPrfSalt,
  openVault,
  PRF_BYTES,
  sealVault,
  VAULT_INFO,
  VAULT_OVERHEAD,
  vaultKeyFromPrf,
} from './keyVault';

/** `vectors/keyVault.json`: one vault key and one sealed vault, computed outside @noble. */
interface VaultVector {
  readonly kind: 'key-vault';
  readonly prf: readonly number[];
  readonly prfSalt: readonly number[];
  readonly credentialId: readonly number[];
  readonly key: readonly number[];
  readonly sealed: readonly number[];
  readonly plaintext: string;
  readonly otherPrf: readonly number[];
}

const [vector] = Object.values(
  import.meta.glob<VaultVector>('./vectors/keyVault.json', { import: 'default', eager: true }),
);
if (vector === undefined) throw new Error('vectors/keyVault.json is missing.');

const PRF = Uint8Array.from(vector.prf);
const SALT = Uint8Array.from(vector.prfSalt);
const CREDENTIAL = Uint8Array.from(vector.credentialId);
const SEALED = Uint8Array.from(vector.sealed);

const prfs = fc.uint8Array({ minLength: 32, maxLength: 32 });
const credentials = fc.uint8Array({ minLength: 1, maxLength: 64 });
const plaintexts = fc.uint8Array({ maxLength: 512 });

/** HKDF-SHA-256 with a salt by the platform's WebCrypto: a second implementation. */
async function platformHkdf(prf: Uint8Array, salt: Uint8Array, info: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(prf), 'HKDF', false, [
    'deriveBits',
  ]);
  const params = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: Uint8Array.from(salt),
    info: Uint8Array.from(utf8ToBytes(info)),
  };
  return bytesToHex(new Uint8Array(await crypto.subtle.deriveBits(params, key, 256)));
}

/** `bytes` with one bit flipped at `index`. */
function flipped(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 1;
  return copy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('keyVault.json', () => {
  it('pins the vault key and opens a vault sealed outside @noble', () => {
    expect(vector.kind).toBe('key-vault');
    expect(VAULT_INFO).toBe('reconcile/v1/key-vault');

    const key = vaultKeyFromPrf(PRF, SALT);

    expect(Array.from(key)).toEqual(vector.key);
    const opened = openVault(key, CREDENTIAL, SEALED);
    expect(opened === null ? null : new TextDecoder().decode(opened)).toBe(vector.plaintext);
  });

  it('opens only with the same PRF output, salt and credential id', () => {
    const otherSalt = flipped(SALT, 0);
    const otherCredential = flipped(CREDENTIAL, CREDENTIAL.length - 1);

    expect(openVault(vaultKeyFromPrf(flipped(PRF, 5), SALT), CREDENTIAL, SEALED)).toBeNull();
    expect(openVault(vaultKeyFromPrf(PRF, otherSalt), CREDENTIAL, SEALED)).toBeNull();
    expect(openVault(vaultKeyFromPrf(PRF, SALT), otherCredential, SEALED)).toBeNull();
    expect(openVault(vaultKeyFromPrf(PRF, SALT), CREDENTIAL.subarray(1), SEALED)).toBeNull();
  });

  it('doesn’t open under another authenticator’s PRF output for the same salt', () => {
    const other = vaultKeyFromPrf(Uint8Array.from(vector.otherPrf), SALT);

    expect(openVault(other, CREDENTIAL, SEALED)).toBeNull();
  });

  it('fails with any one byte of the sealed vault flipped, nonce, ciphertext or tag', () => {
    const key = vaultKeyFromPrf(PRF, SALT);

    for (let index = 0; index < SEALED.length; index += 1) {
      expect(openVault(key, CREDENTIAL, flipped(SEALED, index))).toBeNull();
    }
  });

  it('fails when the vault is cut short or has a byte more', () => {
    const key = vaultKeyFromPrf(PRF, SALT);

    expect(openVault(key, CREDENTIAL, SEALED.subarray(0, SEALED.length - 1))).toBeNull();
    expect(openVault(key, CREDENTIAL, Uint8Array.of(...SEALED, 0))).toBeNull();
    expect(openVault(key, CREDENTIAL, SEALED.subarray(0, VAULT_OVERHEAD - 1))).toBeNull();
    expect(openVault(key, CREDENTIAL, new Uint8Array(0))).toBeNull();
  });
});

describe('vaultKeyFromPrf', () => {
  it('gives what WebCrypto’s HKDF gives with the PRF salt and the vault label', async () => {
    await fc.assert(
      fc.asyncProperty(prfs, prfs, async (prf, salt) => {
        expect(bytesToHex(vaultKeyFromPrf(prf, salt))).toBe(
          await platformHkdf(prf, salt, 'reconcile/v1/key-vault'),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('is never the PRF output itself', () => {
    fc.assert(
      fc.property(prfs, prfs, (prf, salt) => {
        expect(bytesToHex(vaultKeyFromPrf(prf, salt))).not.toBe(bytesToHex(prf));
      }),
    );
  });

  it.each([0, 31, 33, 64])('refuses a %i-byte PRF output or salt', (length) => {
    const wrong = new Uint8Array(length);
    const message = 'A PRF output and its salt are 32 bytes each.';

    expect(() => vaultKeyFromPrf(wrong, SALT)).toThrow(new RangeError(message));
    expect(() => vaultKeyFromPrf(PRF, wrong)).toThrow(new RangeError(message));
  });
});

describe('sealVault and openVault', () => {
  it('round-trip any plaintext under one key and credential id', () => {
    fc.assert(
      fc.property(prfs, credentials, plaintexts, (prf, credential, plaintext) => {
        const key = vaultKeyFromPrf(prf, SALT);

        const sealed = sealVault(key, credential, plaintext);

        expect(sealed).toHaveLength(plaintext.length + VAULT_OVERHEAD);
        expect(bytesToHex(openVault(key, credential, sealed) ?? new Uint8Array([1]))).toBe(
          bytesToHex(plaintext),
        );
      }),
    );
  });

  it('seals under a fresh 24-byte nonce from the platform’s CSPRNG each time', () => {
    const key = vaultKeyFromPrf(PRF, SALT);
    const plaintext = utf8ToBytes('{"format":1,"groups":{}}');
    const random = vi.spyOn(crypto, 'getRandomValues');

    const first = sealVault(key, CREDENTIAL, plaintext);
    const second = sealVault(key, CREDENTIAL, plaintext);

    expect(VAULT_OVERHEAD).toBe(40);
    expect(random).toHaveBeenCalledTimes(2);
    expect(bytesToHex(first.subarray(0, 24))).toBe(
      bytesToHex(random.mock.results[0]?.value as Uint8Array),
    );
    expect(bytesToHex(first)).not.toBe(bytesToHex(second));
  });

  it('never holds the plaintext in the clear', () => {
    const key = vaultKeyFromPrf(PRF, SALT);
    const secret = new Uint8Array(32).fill(0xab);

    const sealed = sealVault(key, CREDENTIAL, secret);

    expect(bytesToHex(sealed)).not.toContain(bytesToHex(secret.subarray(0, 8)));
  });

  it('refuses a key that isn’t 32 bytes', () => {
    expect(() => sealVault(new Uint8Array(16), CREDENTIAL, new Uint8Array(1))).toThrow(
      new RangeError('A vault key is 32 bytes.'),
    );
    expect(openVault(new Uint8Array(16), CREDENTIAL, SEALED)).toBeNull();
  });
});

describe('newPrfSalt', () => {
  it('is 32 bytes from the platform’s CSPRNG, new each time', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const salt = newPrfSalt();

    expect(PRF_BYTES).toBe(32);
    expect(salt).toHaveLength(32);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(salt));
    expect(new Set(Array.from({ length: 20 }, () => bytesToHex(newPrfSalt()))).size).toBe(20);
  });
});
