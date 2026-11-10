import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BOX_OVERHEAD,
  KX_KEY_BYTES,
  isUsableKxKey,
  kxPublicKeyOf,
  newKxKey,
  openBox,
  sealTo,
} from './box';
import { concat, local, utf8 } from '../test/bytes';

/** `vectors/box.json`: one box sealed and opened outside @noble. Each value is its bytes. */
interface BoxFile {
  readonly kind: 'box';
  readonly vectors: readonly {
    readonly name: string;
    readonly recipientSecret: readonly number[];
    readonly recipientPublic: readonly number[];
    readonly ephemeralSecret: readonly number[];
    readonly ephemeralPublic: readonly number[];
    readonly nonce: readonly number[];
    readonly info: string;
    readonly aad: readonly number[];
    readonly plaintext: readonly number[];
    readonly shared: readonly number[];
    readonly key: readonly number[];
    readonly box: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<BoxFile>('./vectors/box.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/box.json is missing.');
const [known] = file.vectors;
if (known === undefined) throw new Error('vectors/box.json holds no vector.');

const bytes = (values: readonly number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const INFO = 'reconcile/v1/test-box';
const AAD = utf8('who this box is for');

/** `box` with byte `at` XORed with 0x01. */
function flipped(box: Uint8Array, at: number): Uint8Array<ArrayBuffer> {
  const copy = Uint8Array.from(box);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

describe('box.json, sealed outside @noble', () => {
  it('opens to its plaintext under the recipient secret, info and AAD', () => {
    const opened = openBox(
      bytes(known.recipientSecret),
      bytes(known.box),
      known.info,
      bytes(known.aad),
    );
    expect(opened === null ? null : local(opened)).toEqual(bytes(known.plaintext));
  });

  it('is ephPub ‖ nonce ‖ XChaCha20-Poly1305 under HKDF(X25519, ephPub ‖ pub, info)', () => {
    // The same steps by hand with @noble's primitives, checked against the vector's intermediates.
    expect(local(x25519.getPublicKey(bytes(known.recipientSecret)))).toEqual(
      bytes(known.recipientPublic),
    );
    expect(local(x25519.getPublicKey(bytes(known.ephemeralSecret)))).toEqual(
      bytes(known.ephemeralPublic),
    );
    const shared = x25519.getSharedSecret(
      bytes(known.ephemeralSecret),
      bytes(known.recipientPublic),
    );
    expect(local(shared)).toEqual(bytes(known.shared));
    const salt = concat(bytes(known.ephemeralPublic), bytes(known.recipientPublic));
    const key = hkdf(sha256, shared, salt, utf8(known.info), 32);
    expect(local(key)).toEqual(bytes(known.key));
    const sealed = xchacha20poly1305(key, bytes(known.nonce), bytes(known.aad)).encrypt(
      bytes(known.plaintext),
    );
    expect(concat(bytes(known.ephemeralPublic), bytes(known.nonce), sealed)).toEqual(
      bytes(known.box),
    );
  });

  it('opens with nothing but the right secret, info and AAD', () => {
    const secret = bytes(known.recipientSecret);
    const box = bytes(known.box);
    const aad = bytes(known.aad);
    expect(openBox(newKxKey(), box, known.info, aad)).toBeNull();
    expect(openBox(secret, box, `${known.info}x`, aad)).toBeNull();
    expect(openBox(secret, box, known.info, concat(aad, Uint8Array.of(0)))).toBeNull();
    expect(openBox(secret, box, known.info, new Uint8Array(0))).toBeNull();
  });

  it('returns null when any one byte is flipped: the key, the nonce, the ciphertext or the tag', () => {
    const secret = bytes(known.recipientSecret);
    const aad = bytes(known.aad);
    for (let at = 0; at < known.box.length; at += 1) {
      expect(
        openBox(secret, flipped(bytes(known.box), at), known.info, aad),
        `byte ${String(at)}`,
      ).toBeNull();
    }
  });

  it('returns null for a box cut short of its overhead, or cut by one byte', () => {
    const secret = bytes(known.recipientSecret);
    const aad = bytes(known.aad);
    const box = bytes(known.box);
    expect(openBox(secret, box.subarray(0, BOX_OVERHEAD - 1), known.info, aad)).toBeNull();
    expect(openBox(secret, box.subarray(0, box.length - 1), known.info, aad)).toBeNull();
    expect(openBox(secret, new Uint8Array(0), known.info, aad)).toBeNull();
  });
});

describe('sealTo', () => {
  it('opens for its recipient, with a fresh ephemeral key and nonce each time', () => {
    const recipient = newKxKey();
    const plaintext = utf8('a new group secret, 32 bytes long');
    const first = sealTo(kxPublicKeyOf(recipient), plaintext, INFO, AAD);
    const second = sealTo(kxPublicKeyOf(recipient), plaintext, INFO, AAD);
    expect(first).toHaveLength(BOX_OVERHEAD + plaintext.length);
    expect(local(first.subarray(0, 32))).not.toEqual(local(second.subarray(0, 32)));
    expect(local(first.subarray(32, 56))).not.toEqual(local(second.subarray(32, 56)));
    for (const box of [first, second]) {
      const opened = openBox(recipient, box, INFO, AAD);
      expect(opened === null ? null : local(opened)).toEqual(plaintext);
    }
  });

  it('opens for its recipient alone, under its own info and AAD, for any plaintext', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.string(), (plaintext, label) => {
        const recipient = newKxKey();
        const box = sealTo(kxPublicKeyOf(recipient), plaintext, INFO, utf8(label));
        const opened = openBox(recipient, box, INFO, utf8(label));
        expect(opened === null ? null : local(opened)).toEqual(local(plaintext));
        expect(openBox(newKxKey(), box, INFO, utf8(label))).toBeNull();
        expect(openBox(recipient, box, INFO, utf8(`${label}!`))).toBeNull();
      }),
      { numRuns: 25 },
    );
  });

  it('refuses a low-order public key, whose shared secret would be all zeros', () => {
    expect(() => sealTo(new Uint8Array(32), utf8('secret'), INFO, AAD)).toThrow(RangeError);
    expect(() =>
      sealTo(Uint8Array.of(1, ...new Uint8Array(31)), utf8('secret'), INFO, AAD),
    ).toThrow('A box can’t be sealed to that key.');
  });

  it('refuses a public key of the wrong length', () => {
    expect(() => sealTo(new Uint8Array(31), utf8('secret'), INFO, AAD)).toThrow(RangeError);
  });
});

describe('keys', () => {
  it('makes a fresh 32-byte X25519 secret key each time, with its public key', () => {
    const [first, second] = [newKxKey(), newKxKey()];
    expect(first).toHaveLength(KX_KEY_BYTES);
    expect(local(first)).not.toEqual(local(second));
    expect(local(kxPublicKeyOf(first))).toEqual(local(x25519.getPublicKey(first)));
  });

  it('calls a public key usable unless it is the wrong length or of low order', () => {
    expect(isUsableKxKey(kxPublicKeyOf(newKxKey()))).toBe(true);
    expect(isUsableKxKey(bytes(known.recipientPublic))).toBe(true);
    expect(isUsableKxKey(new Uint8Array(32))).toBe(false);
    expect(isUsableKxKey(Uint8Array.of(1, ...new Uint8Array(31)))).toBe(false);
    expect(isUsableKxKey(new Uint8Array(31))).toBe(false);
    expect(isUsableKxKey(new Uint8Array(33).fill(9))).toBe(false);
  });

  it('opens nothing with a secret key of the wrong length, rather than throwing', () => {
    expect(openBox(new Uint8Array(31), bytes(known.box), known.info, bytes(known.aad))).toBeNull();
  });
});
