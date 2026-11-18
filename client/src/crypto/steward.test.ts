import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import { kxPublicKeyOf } from './box';
import { publicKeyOf } from './sign';
import {
  STEWARD_BOX_INFO,
  STEWARD_SECRET_BYTES,
  STEWARD_SIGN_INFO,
  stewardKeysOf,
  stewardSecretFrom,
} from './steward';

/** `vectors/steward.json`: the steward's two keys from one secret, made outside @noble. */
interface StewardFile {
  readonly kind: 'steward';
  readonly signInfo: string;
  readonly boxInfo: string;
  readonly seed: readonly number[];
  readonly signSecret: readonly number[];
  readonly signPublic: readonly number[];
  readonly boxSecret: readonly number[];
  readonly boxPublic: readonly number[];
}

const [file] = Object.values(
  import.meta.glob<StewardFile>('./vectors/steward.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/steward.json is missing.');

const bytes = (list: readonly number[]) => Uint8Array.from(list);

describe('steward.json, made outside @noble', () => {
  it('derives both key pairs from the secret under their labels', () => {
    expect(file.kind).toBe('steward');
    expect(STEWARD_SIGN_INFO).toBe(file.signInfo);
    expect(STEWARD_BOX_INFO).toBe(file.boxInfo);

    const keys = stewardKeysOf(bytes(file.seed));

    expect(keys.signing.secretKey).toEqual(bytes(file.signSecret));
    expect(keys.signing.publicKey).toEqual(bytes(file.signPublic));
    expect(keys.box.secretKey).toEqual(bytes(file.boxSecret));
    expect(keys.box.publicKey).toEqual(bytes(file.boxPublic));
  });

  it('pairs each public half with its secret on its own curve', () => {
    const keys = stewardKeysOf(new Uint8Array(32).fill(7));

    expect(publicKeyOf(keys.signing.secretKey)).toEqual(keys.signing.publicKey);
    expect(kxPublicKeyOf(keys.box.secretKey)).toEqual(keys.box.publicKey);
    expect(keys.signing.secretKey).not.toEqual(keys.box.secretKey);
  });

  it('refuses a secret of any length but 32 bytes', () => {
    expect(STEWARD_SECRET_BYTES).toBe(32);
    expect(() => stewardKeysOf(new Uint8Array(31))).toThrow(RangeError);
    expect(() => stewardKeysOf(new Uint8Array(33))).toThrow(RangeError);
  });
});

describe('stewardSecretFrom', () => {
  it('reads the secret the script prints: 43 characters of canonical base64url', () => {
    const seed = bytes(file.seed);

    expect(stewardSecretFrom(base64url(seed))).toEqual(seed);
    expect(stewardSecretFrom(`  ${base64url(seed)}\n`)).toEqual(seed);
  });

  it.each([
    ['nothing', ''],
    ['too short', 'AAAA'],
    ['a non-canonical last character', `${'A'.repeat(42)}B`],
    ['padding', `${'A'.repeat(43)}=`],
    ['standard base64', `${'A'.repeat(42)}+`],
    ['spaces inside', `${'A'.repeat(21)} ${'A'.repeat(21)}`],
  ])('refuses %s', (_, text) => {
    expect(stewardSecretFrom(text)).toBeNull();
  });
});
