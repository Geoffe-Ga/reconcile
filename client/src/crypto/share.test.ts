import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from './base64url';
import { deriveMailboxId, deriveSealKey } from './groupKeys';
import { deriveInviteKey, deriveInviteMailboxId } from './invite';
import { signRecord, verifyRecord } from './record';
import {
  SHARE_KEY_INFO,
  SHARE_MAILBOX_INFO,
  SHARE_SEED_BYTES,
  deriveShareKey,
  deriveShareMailboxId,
  newShareSeed,
  openShareRecord,
  shareChannelOf,
  signShareRecord,
} from './share';
import { EVENT_CONTEXT, SHARE_CONTEXT, newSigningKeys, publicKeyOf, sign } from './sign';

/** `vectors/share.json`: fixed seeds' derivations and one signed copy, computed outside @noble. */
interface ShareFile {
  readonly kind: 'share';
  readonly infos: {
    readonly shareMailboxId: string;
    readonly shareKey: string;
    readonly record: string;
  };
  readonly derivations: readonly {
    readonly name: string;
    readonly seed: readonly number[];
    readonly shareMailboxId: readonly number[];
    readonly shareKey: readonly number[];
  }[];
  readonly records: readonly {
    readonly name: string;
    readonly secretKey: readonly number[];
    readonly publicKey: readonly number[];
    readonly copy: string;
    readonly record: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<ShareFile>('./vectors/share.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/share.json is missing.');

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });
const COPY = new TextEncoder().encode('{"v":1,"n":1,"title":"Me","text":"Real.\\n"}');

/** Bytes as hex, or null: TextEncoder's arrays come from another realm than @noble's. */
const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : bytesToHex(bytes);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('share.json', () => {
  it('names the labels the derivations and the record use', () => {
    expect(file.kind).toBe('share');
    expect(file.infos).toEqual({
      shareMailboxId: SHARE_MAILBOX_INFO,
      shareKey: SHARE_KEY_INFO,
      record: SHARE_CONTEXT,
    });
    expect([SHARE_MAILBOX_INFO, SHARE_KEY_INFO, SHARE_CONTEXT]).toEqual([
      'reconcile/v1/share-mailbox',
      'reconcile/v1/share-key',
      'reconcile/v1/share',
    ]);
  });

  it.each(file.derivations.map((vector) => [vector.name, vector] as const))(
    'pins the share mailbox id and seal key of %s',
    (_name, vector) => {
      const seed = Uint8Array.from(vector.seed);

      expect(deriveShareMailboxId(seed)).toBe(base64url(Uint8Array.from(vector.shareMailboxId)));
      expect(Array.from(deriveShareKey(seed))).toEqual(vector.shareKey);
      expect(shareChannelOf(seed)).toEqual({
        mailbox: base64url(Uint8Array.from(vector.shareMailboxId)),
        key: Uint8Array.from(vector.shareKey),
      });
    },
  );

  it.each(file.records.map((vector) => [vector.name, vector] as const))(
    'pins the record of %s, and it opens under that key only',
    (_name, vector) => {
      const secretKey = Uint8Array.from(vector.secretKey);
      const publicKey = Uint8Array.from(vector.publicKey);
      const copy = new TextEncoder().encode(vector.copy);

      const record = signShareRecord({ secretKey, publicKey }, copy);

      expect(Array.from(record)).toEqual(vector.record);
      expect(base64url(publicKeyOf(secretKey))).toBe(base64url(publicKey));
      expect(hex(openShareRecord(Uint8Array.from(vector.record), publicKey))).toBe(
        bytesToHex(copy),
      );
      expect(openShareRecord(Uint8Array.from(vector.record), newSigningKeys().publicKey)).toBe(
        null,
      );
    },
  );
});

describe('the share derivations', () => {
  it('differ from a group secret’s and an invite seed’s, so a share names and opens nothing else', () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const mailbox = deriveShareMailboxId(seed);
        const key = deriveShareKey(seed);

        expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(key).toHaveLength(32);
        for (const other of [deriveMailboxId(seed), deriveInviteMailboxId(seed), base64url(seed)]) {
          expect(mailbox).not.toBe(other);
        }
        for (const other of [deriveSealKey(seed), deriveInviteKey(seed), seed]) {
          expect(bytesToHex(key)).not.toBe(bytesToHex(other));
        }
        expect(base64url(key)).not.toBe(mailbox);
      }),
      { numRuns: 50 },
    );
  });

  it.each([0, 16, 31, 33])('refuse a %i-byte seed', (length) => {
    const seed = new Uint8Array(length);
    const refusal = new RangeError('A share seed is 32 bytes.');

    expect(() => deriveShareMailboxId(seed)).toThrow(refusal);
    expect(() => deriveShareKey(seed)).toThrow(refusal);
    expect(() => shareChannelOf(seed)).toThrow(refusal);
  });
});

describe('newShareSeed', () => {
  it('is 32 bytes from the platform’s CSPRNG, new each time', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const seed = newShareSeed();

    expect(SHARE_SEED_BYTES).toBe(32);
    expect(seed).toHaveLength(32);
    expect(random).toHaveBeenCalledTimes(1);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(seed));
    const made = Array.from({ length: 20 }, () => base64url(newShareSeed()));
    expect(new Set(made).size).toBe(20);
  });
});

describe('share records', () => {
  const keys = newSigningKeys();
  const record = signShareRecord(keys, COPY);

  it('are the public key, the signature, then the copy', () => {
    expect(record).toHaveLength(32 + 64 + COPY.length);
    expect(bytesToHex(record.subarray(0, 32))).toBe(bytesToHex(keys.publicKey));
    expect(bytesToHex(record.subarray(96))).toBe(bytesToHex(COPY));
    expect(bytesToHex(record.subarray(32, 96))).toBe(
      bytesToHex(sign(SHARE_CONTEXT, keys.secretKey, COPY)),
    );
  });

  it('open only under the key the link names', () => {
    expect(hex(openShareRecord(record, keys.publicKey))).toBe(bytesToHex(COPY));
    expect(openShareRecord(record, newSigningKeys().publicKey)).toBe(null);
  });

  it('never open when the key inside isn’t the link’s, even with a valid signature by it', () => {
    const other = newSigningKeys();
    const forged = signShareRecord(other, COPY);

    expect(openShareRecord(forged, keys.publicKey)).toBe(null);
    expect(hex(openShareRecord(forged, other.publicKey))).toBe(bytesToHex(COPY));
  });

  it('never open with one byte changed anywhere', () => {
    for (const index of [0, 31, 32, 95, 96, record.length - 1]) {
      const flipped = Uint8Array.from(record);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      expect(openShareRecord(flipped, keys.publicKey)).toBe(null);
    }
  });

  it('refuse bytes too short to hold a key and a signature, and a key of the wrong length', () => {
    expect(openShareRecord(record.subarray(0, 95), keys.publicKey)).toBe(null);
    expect(openShareRecord(new Uint8Array(0), keys.publicKey)).toBe(null);
    expect(openShareRecord(record, keys.publicKey.subarray(0, 31))).toBe(null);
  });

  it('are never an event record, nor the other way round', () => {
    const event = signRecord(keys, COPY);

    expect(bytesToHex(event)).not.toBe(bytesToHex(record));
    expect(openShareRecord(event, keys.publicKey)).toBe(null);
    expect(verifyRecord(record)).toBe(null);
    expect(bytesToHex(sign(EVENT_CONTEXT, keys.secretKey, COPY))).not.toBe(
      bytesToHex(record.subarray(32, 96)),
    );
  });
});
