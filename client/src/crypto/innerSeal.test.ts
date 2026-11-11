import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import { deriveCoalitionEntryId } from './card';
import { deriveSealKey } from './groupKeys';
import { hkdf32 } from './hkdf';
import {
  INNER_SEAL_INFO,
  innerSealKey,
  openSeatSecrets,
  SEALED_FIELD_CHARS,
  SEALED_SECRETS_BYTES,
  sealSeatSecrets,
} from './innerSeal';
import { seal } from './seal';

/** `vectors/innerSeal.json`: fixed inners' keys, and one sealed field, computed outside @noble. */
interface InnerSealFile {
  readonly kind: 'inner-seal';
  readonly info: string;
  readonly derivations: readonly {
    readonly inner: readonly number[];
    readonly key: readonly number[];
  }[];
  readonly opens: {
    readonly inner: readonly number[];
    readonly coalitionId: string;
    readonly sealed: readonly number[];
    readonly secret: readonly number[];
    readonly innerAbove: readonly number[];
    readonly seat: readonly number[];
  };
}

const [file] = Object.values(
  import.meta.glob<InnerSealFile>('./vectors/innerSeal.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/innerSeal.json is missing.');

const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const secrets = fc.record({ secret: bytes32, inner: bytes32, seat: bytes32 });
const ID = 'the-lower-coalition-genesis-id';

describe('innerSeal.json', () => {
  it('names the label the app uses', () => {
    expect(file.info).toBe(INNER_SEAL_INFO);
    expect(INNER_SEAL_INFO).toBe('reconcile/v1/inner-seal');
  });

  it.each(file.derivations.map((d, i) => [i, d] as const))(
    'derives the seal key of inner %i as Python’s hmac does',
    (_i, { inner, key }) => {
      expect([...innerSealKey(Uint8Array.from(inner))]).toEqual(key);
    },
  );

  it('opens the field sealed outside @noble to its three secrets', () => {
    const { inner, coalitionId, sealed, secret, innerAbove, seat } = file.opens;
    const opened = openSeatSecrets(
      coalitionId,
      Uint8Array.from(inner),
      base64url(Uint8Array.from(sealed)),
    );
    expect(opened).not.toBeNull();
    expect([...(opened?.secret ?? [])]).toEqual(secret);
    expect([...(opened?.inner ?? [])]).toEqual(innerAbove);
    expect([...(opened?.seat ?? [])]).toEqual(seat);
  });
});

describe('sealSeatSecrets and openSeatSecrets', () => {
  it('round-trip any secrets, in a field of exactly one 1,024-byte blob', () => {
    fc.assert(
      fc.property(bytes32, secrets, (inner, held) => {
        const sealed = sealSeatSecrets(ID, inner, held);
        expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(sealed).toHaveLength(SEALED_FIELD_CHARS);
        expect(SEALED_FIELD_CHARS).toBe(1366);
        expect(SEALED_SECRETS_BYTES).toBe(1024);
        expect(openSeatSecrets(ID, inner, sealed)).toEqual(held);
      }),
      { numRuns: 25 },
    );
  });

  it('never opens under another inner, another coalition, or any key a follower holds', () => {
    fc.assert(
      fc.property(bytes32, bytes32, secrets, (inner, followerSecret, held) => {
        const sealed = sealSeatSecrets(ID, inner, held);
        // Under a key a follower of the lower coalition can derive, its secret's, nothing opens.
        expect(openSeatSecrets(ID, followerSecret, sealed)).toBeNull();
        expect(openSeatSecrets(`${ID}x`, inner, sealed)).toBeNull();
        // The follower's own keys: the secret itself, the coalition seal key and the entry id.
        const followerKeys = [
          followerSecret,
          deriveSealKey(followerSecret),
          hkdf32(followerSecret, INNER_SEAL_INFO),
        ];
        for (const key of followerKeys) expect(openSeatSecrets(ID, key, sealed)).toBeNull();
        expect(deriveCoalitionEntryId(followerSecret)).not.toBe(base64url(innerSealKey(inner)));
      }),
      { numRuns: 25 },
    );
  });

  it('opens nothing from a damaged field, or one that isn’t base64url', () => {
    const inner = new Uint8Array(32).fill(7);
    const held = {
      secret: new Uint8Array(32).fill(1),
      inner: new Uint8Array(32).fill(2),
      seat: new Uint8Array(32).fill(3),
    };
    const sealed = sealSeatSecrets(ID, inner, held);
    const flipped = `${sealed.slice(0, 40)}${sealed[40] === 'A' ? 'B' : 'A'}${sealed.slice(41)}`;
    expect(openSeatSecrets(ID, inner, flipped)).toBeNull();
    expect(openSeatSecrets(ID, inner, 'not base64url!')).toBeNull();
    expect(openSeatSecrets(ID, inner, sealed.slice(0, 100))).toBeNull();
  });

  it('opens only a field holding exactly 96 bytes', () => {
    const inner = new Uint8Array(32).fill(9);
    const key = innerSealKey(inner);
    for (const length of [95, 97]) {
      const sealed = base64url(seal(ID, key, new Uint8Array(length)));
      expect(openSeatSecrets(ID, inner, sealed)).toBeNull();
    }
    expect(openSeatSecrets(ID, inner, base64url(seal(ID, key, new Uint8Array(96))))).not.toBeNull();
  });

  it('refuses an inner or a secret that isn’t 32 bytes', () => {
    const held = {
      secret: new Uint8Array(32),
      inner: new Uint8Array(32),
      seat: new Uint8Array(32),
    };
    expect(() => innerSealKey(new Uint8Array(31))).toThrow(RangeError);
    expect(() => sealSeatSecrets(ID, new Uint8Array(33), held)).toThrow(RangeError);
    expect(() =>
      sealSeatSecrets(ID, new Uint8Array(32), { ...held, secret: new Uint8Array(1) }),
    ).toThrow(RangeError);
  });
});
