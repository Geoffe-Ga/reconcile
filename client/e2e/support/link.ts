/**
 * Linking a second device (#96) as the e2e spec checks it, from outside the
 * app: Node's own X25519 and HKDF redo spec §3's derivations, so the number
 * both screens show, the key K the bundle travels under and every secret in
 * between can be named and looked for in what reached the relay.
 *
 * The one-time keys exist only in each page's memory, so an init script
 * keeps every 32-byte value the page's CSPRNG hands out; the spec finds `e_A`
 * among them by the code's commitment and `e_B` by the number on screen.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';

import type { Page } from '@playwright/test';

/** The name the init script keeps the page's 32-byte random values under, in hex. */
export const RANDOM_NAME = 'e2eLinkRandom';

/** DER before a raw X25519 private key (PKCS #8) and public key (SPKI). */
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * Runs in the page before the app, as `addInitScript(recordRandom, RANDOM_NAME)`:
 * keeps a hex copy of every 32-byte value `crypto.getRandomValues` fills
 * under `name`. It changes nothing the app sees.
 */
export function recordRandom(name: string): void {
  const seen: string[] = [];
  Reflect.set(window, name, seen);
  const fill = crypto.getRandomValues.bind(crypto);
  const record = <T extends ArrayBufferView<ArrayBuffer>>(array: T): T => {
    const filled = fill(array);
    if (array.byteLength === 32) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      seen.push(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
    return filled;
  };
  crypto.getRandomValues = record;
}

/** Every 32-byte random value `page` has made so far. */
export async function randomsOf(page: Page): Promise<Buffer[]> {
  const seen = await page.evaluate((name) => Reflect.get(window, name) as string[], RANDOM_NAME);
  return seen.map((hex) => Buffer.from(hex, 'hex'));
}

/** The X25519 public key of the raw 32-byte `secret`. */
export function x25519Public(secret: Uint8Array): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, secret]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
}

/** X25519 of the raw `secret` with the raw `publicKey`. */
function x25519(secret: Uint8Array, publicKey: Uint8Array): Buffer {
  return diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.concat([PKCS8_X25519, secret]),
      format: 'der',
      type: 'pkcs8',
    }),
    publicKey: createPublicKey({
      key: Buffer.concat([SPKI_X25519, publicKey]),
      format: 'der',
      type: 'spki',
    }),
  });
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** What a code holds: the seed, and the commitment to the existing device's key. */
export function codeParts(code: string): { seed: Buffer; commitment: Buffer } {
  const bytes = Buffer.from(code.replace(/^RL1\./, ''), 'base64url');
  return { seed: bytes.subarray(0, 32), commitment: bytes.subarray(32) };
}

/** Everything spec §3 derives for a link between `secretA` and `secretB` under `seed`. */
export interface LinkSecrets {
  readonly publicA: Buffer;
  readonly publicB: Buffer;
  readonly pairingMailbox: string;
  readonly pairingKey: Buffer;
  readonly number: string;
  readonly key: Buffer;
  readonly bundleMailbox: string;
}

/** Spec §3's derivations, by Node's crypto. */
export function linkSecrets(seed: Buffer, secretA: Buffer, secretB: Buffer): LinkSecrets {
  const publicA = x25519Public(secretA);
  const publicB = x25519Public(secretB);
  const ikm = x25519(secretA, publicB);
  const salt = sha256(Buffer.concat([Buffer.from('reconcile/v1/link'), seed, publicA, publicB]));
  const number = hkdf(ikm, salt, 'reconcile/v1/link-number', 4).readUInt32BE(0) % 1_000_000;
  const key = hkdf(ikm, salt, 'reconcile/v1/link-key', 32);
  return {
    publicA,
    publicB,
    pairingMailbox: hkdf(seed, Buffer.alloc(0), 'reconcile/v1/link-mailbox', 32).toString(
      'base64url',
    ),
    pairingKey: hkdf(seed, Buffer.alloc(0), 'reconcile/v1/link-seal', 32),
    number: String(number).padStart(6, '0'),
    key,
    bundleMailbox: hkdf(key, Buffer.alloc(0), 'reconcile/v1/link-bundle', 32).toString('base64url'),
  };
}

/**
 * The one-time secrets behind `code` and `number`: `e_A` is the existing
 * device's random value whose public key hashes to the code's commitment,
 * and `e_B` the new device's whose link shows `number`.
 */
export function findLinkKeys(
  code: string,
  number: string,
  randomsA: readonly Buffer[],
  randomsB: readonly Buffer[],
): { secretA: Buffer; secretB: Buffer; secrets: LinkSecrets } {
  const { seed, commitment } = codeParts(code);
  const secretA = randomsA.find((value) => sha256(x25519Public(value)).equals(commitment));
  if (secretA === undefined) throw new Error('No random value on A makes the committed key.');
  const secretB = randomsB.find((value) => linkSecrets(seed, secretA, value).number === number);
  if (secretB === undefined) throw new Error('No random value on B makes the number shown.');
  return { secretA, secretB, secrets: linkSecrets(seed, secretA, secretB) };
}
