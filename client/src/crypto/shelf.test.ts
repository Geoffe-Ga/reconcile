import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import { signDoorRecord } from './door';
import { SHELF_CONTEXT, signShelfRecord, verifyShelfRecord } from './shelf';
import { DOOR_PAGE_CONTEXT, newSigningKeys, publicKeyOf, sign, SIGNATURE_BYTES } from './sign';

/**
 * `vectors/shelf.json`: signed shelf records, made outside @noble. Every value
 * is its bytes, so no high-entropy text sits in the repository: a door's
 * address is its public key in unpadded base64url.
 */
interface ShelfFile {
  readonly kind: 'shelf';
  readonly tag: string;
  readonly doors: readonly {
    readonly name: string;
    readonly signSecret: readonly number[];
    readonly signPublic: readonly number[];
  }[];
  readonly records: readonly {
    readonly name: string;
    readonly door: number;
    readonly message: readonly number[];
    readonly record: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<ShelfFile>('./vectors/shelf.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/shelf.json is missing.');

const bytes = (list: readonly number[]) => Uint8Array.from(list);

/** The vector's door `index`, as keys. */
function doorOf(index: number) {
  const door = file?.doors[index];
  if (door === undefined) throw new Error(`No door ${String(index)} in shelf.json.`);
  return {
    keys: { secretKey: bytes(door.signSecret), publicKey: bytes(door.signPublic) },
    address: base64url(bytes(door.signPublic)),
  };
}

/** `bytes` with the byte at `at` flipped. */
function flipped(record: Uint8Array, at: number): Uint8Array {
  const copy = record.slice();
  copy[at] = (copy[at] ?? 0) ^ 1;
  return copy;
}

describe('shelf.json, made outside @noble', () => {
  it('names the tag every shelf record is signed under', () => {
    expect(file.kind).toBe('shelf');
    expect(file.tag).toBe(SHELF_CONTEXT);
    expect(SHELF_CONTEXT).toBe('reconcile/v1/shelf');
  });

  it.each(file.doors.map((door) => [door.name, door] as const))(
    'pins the public key of %s, whose unpadded base64url is its address',
    (_name, door) => {
      expect(Array.from(publicKeyOf(bytes(door.signSecret)))).toEqual(door.signPublic);
      expect(base64url(bytes(door.signPublic))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    },
  );

  it.each(file.records.map((vector) => [vector.name, vector] as const))(
    'signs %s to the same bytes, and verifies them under its address',
    (_name, vector) => {
      const { keys, address } = doorOf(vector.door);
      const message = bytes(vector.message);

      expect(Array.from(signShelfRecord(keys, message))).toEqual(vector.record);
      expect(verifyShelfRecord(bytes(vector.record), address)).toEqual(message);
    },
  );

  it('serializes each message’s body to the same compact UTF-8 JSON Python made', () => {
    for (const vector of file.records) {
      const message = bytes(vector.message);
      const body: unknown = JSON.parse(new TextDecoder().decode(message));
      expect(bytesToHex(utf8ToBytes(JSON.stringify(body)))).toBe(bytesToHex(message));
    }
  });
});

describe('verifyShelfRecord', () => {
  const [vector] = file.records;
  if (vector === undefined) throw new Error('shelf.json has no record.');
  const record = bytes(vector.record);
  const { address } = doorOf(vector.door);

  it('refuses a record under any other address', () => {
    expect(verifyShelfRecord(record, doorOf(1).address)).toBeNull();
    expect(verifyShelfRecord(record, base64url(newSigningKeys().publicKey))).toBeNull();
  });

  it('refuses a record with any byte changed (fast-check)', () => {
    fc.assert(
      fc.property(fc.nat({ max: record.length - 1 }), (at) => {
        expect(verifyShelfRecord(flipped(record, at), address)).toBeNull();
      }),
    );
  });

  it('refuses an address that isn’t a canonical 32-byte key', () => {
    const spare = `${address.slice(0, 42)}${address.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [address.slice(1), `${address}A`, spare, `${address.slice(0, 42)}+`, '']) {
      expect(verifyShelfRecord(record, bad)).toBeNull();
    }
  });

  it('refuses bytes that hold a signature and nothing signed, or less', () => {
    const { keys } = doorOf(0);
    const empty = signShelfRecord(keys, new Uint8Array(0));
    expect(empty).toHaveLength(SIGNATURE_BYTES);
    expect(verifyShelfRecord(empty, address)).toBeNull();
    expect(verifyShelfRecord(record.subarray(0, 10), address)).toBeNull();
  });

  it('refuses a door page’s signature, and a shelf record never opens as a page', () => {
    const { keys } = doorOf(0);
    const message = bytes(vector.message);
    const asPage = new Uint8Array([
      ...sign(DOOR_PAGE_CONTEXT, keys.secretKey, message),
      ...message,
    ]);
    expect(verifyShelfRecord(asPage, address)).toBeNull();
    expect(signDoorRecord(keys, message).subarray(32)).not.toEqual(record);
  });

  it('round-trips any message under a fresh key, and returns bytes of its own (fast-check)', () => {
    const keys = newSigningKeys();
    const own = base64url(keys.publicKey);
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), (message) => {
        const signed = signShelfRecord(keys, message);
        const opened = verifyShelfRecord(signed, own);
        expect(opened).toEqual(message);
        signed.fill(0);
        expect(opened).toEqual(message);
      }),
    );
  });
});
