import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from './base64url';
import {
  GROUP_SECRET_BYTES,
  MAILBOX_INFO,
  SEAL_KEY_INFO,
  deriveMailboxId,
  deriveSealKey,
  newGroupSecret,
} from './groupKeys';

/** `vectors/derive.json`: one fixed secret's mailbox id and seal key, computed outside @noble. */
interface DeriveFile {
  readonly kind: 'derive';
  readonly infos: { readonly mailboxId: string; readonly sealKey: string };
  /** Each value is its bytes; the mailbox id is the base64url of its bytes. */
  readonly vectors: readonly {
    readonly name: string;
    readonly secret: readonly number[];
    readonly mailboxId: readonly number[];
    readonly sealKey: readonly number[];
  }[];
}

const [derive] = Object.values(
  import.meta.glob<DeriveFile>('./vectors/derive.json', { import: 'default', eager: true }),
);
if (derive === undefined) throw new Error('vectors/derive.json is missing.');

const secrets = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** HKDF-SHA-256 with an empty salt by the platform's WebCrypto: a second implementation. */
async function platformHkdf(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const params = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: Uint8Array.from(new TextEncoder().encode(info)),
  };
  return new Uint8Array(await crypto.subtle.deriveBits(params, key, 256));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('derive.json', () => {
  it('names the two HKDF labels the derivations use', () => {
    expect(derive.kind).toBe('derive');
    expect(derive.infos).toEqual({ mailboxId: MAILBOX_INFO, sealKey: SEAL_KEY_INFO });
    expect([MAILBOX_INFO, SEAL_KEY_INFO]).toEqual([
      'reconcile/v1/mailbox',
      'reconcile/v1/seal-key',
    ]);
  });

  it.each(derive.vectors.map((vector) => [vector.name, vector] as const))(
    'pins the mailbox id and seal key of %s',
    (_name, vector) => {
      const secret = Uint8Array.from(vector.secret);

      expect(deriveMailboxId(secret)).toBe(base64url(Uint8Array.from(vector.mailboxId)));
      expect(Array.from(deriveSealKey(secret))).toEqual(vector.sealKey);
    },
  );
});

describe('deriveMailboxId and deriveSealKey', () => {
  it('give what WebCrypto’s HKDF gives with an empty salt and their labels, for any secret', async () => {
    await fc.assert(
      fc.asyncProperty(secrets, async (secret) => {
        expect(deriveMailboxId(secret)).toBe(base64url(await platformHkdf(secret, MAILBOX_INFO)));
        expect(bytesToHex(deriveSealKey(secret))).toBe(
          bytesToHex(await platformHkdf(secret, SEAL_KEY_INFO)),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('make a 43-character base64url mailbox id and a 32-byte key, neither of them the secret', () => {
    fc.assert(
      fc.property(secrets, (secret) => {
        const mailbox = deriveMailboxId(secret);
        const key = deriveSealKey(secret);

        expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(key).toHaveLength(32);
        expect(mailbox).not.toBe(base64url(secret));
        expect(mailbox).not.toBe(base64url(key));
        expect(bytesToHex(key)).not.toBe(bytesToHex(secret));
      }),
    );
  });

  it('give unrelated values for secrets one bit apart', () => {
    const one = new Uint8Array(32);
    const two = Uint8Array.from(one);
    two[31] = 1;

    expect(deriveMailboxId(one)).not.toBe(deriveMailboxId(two));
    expect(bytesToHex(deriveSealKey(one))).not.toBe(bytesToHex(deriveSealKey(two)));
  });

  it.each([0, 16, 31, 33, 64])('refuse a %i-byte secret', (length) => {
    const secret = new Uint8Array(length);

    expect(() => deriveMailboxId(secret)).toThrow(new RangeError('A group secret is 32 bytes.'));
    expect(() => deriveSealKey(secret)).toThrow(new RangeError('A group secret is 32 bytes.'));
  });
});

describe('newGroupSecret', () => {
  it('is 32 bytes from the platform’s CSPRNG', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const secret = newGroupSecret();

    expect(GROUP_SECRET_BYTES).toBe(32);
    expect(secret).toHaveLength(32);
    expect(random).toHaveBeenCalledTimes(1);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(secret));
  });

  it('is new each time, so no two groups share a mailbox', () => {
    const made = Array.from({ length: 20 }, () => newGroupSecret());

    expect(new Set(made.map(bytesToHex)).size).toBe(20);
    expect(new Set(made.map(deriveMailboxId)).size).toBe(20);
  });
});
