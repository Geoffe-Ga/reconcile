/**
 * The key vault's record (#95): what it holds once opened, and that it opens
 * only under the key it was sealed with, for the passkey it names.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { openVault, sealVault, vaultKeyFromPrf } from '../crypto/keyVault';
import { local, text, utf8 } from '../test/bytes';
import {
  decodeVaultKeys,
  encodeVaultKeys,
  type GroupKeys,
  newVault,
  openKeys,
  resealKeys,
  VAULT_FORMAT,
  type VaultKeys,
  type VaultRecord,
} from './vault';

const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
const OTHER_KEY = vaultKeyFromPrf(new Uint8Array(32).fill(3), new Uint8Array(32).fill(2));
const LOCK = { credentialId: Uint8Array.of(9, 8, 7), prfSalt: new Uint8Array(32).fill(2) };

const keysOf = (fill: number): GroupKeys => ({
  secret: new Uint8Array(32).fill(fill),
  signingKey: new Uint8Array(32).fill(fill + 1),
});

/** 32 zero bytes and 32 one bytes, as the vault spells them. */
const ZEROS = base64url(new Uint8Array(32));
const ONES = base64url(new Uint8Array(32).fill(1));

/** One valid entry for `groupId`, holding {@link ZEROS} and {@link ONES}. */
const entry = (groupId: string) => ({ groupId, secret: ZEROS, signingKey: ONES });

/** A vault plaintext holding `groups`, under `format`. */
const vaultJson = (groups: readonly unknown[], format = 1): string =>
  JSON.stringify({ format, groups });

/** A vault's contents holding only `groups`, as a device without a relay backup key has. */
const only = (groups: Map<string, GroupKeys>): VaultKeys => ({ groups });

/** The groups' entries with their bytes in the test's realm, so `toEqual` can compare them. */
function comparable(keys: VaultKeys | Map<string, GroupKeys> | null | undefined) {
  if (keys === null || keys === undefined) return null;
  const groups = keys instanceof Map ? keys : keys.groups;
  return [...groups].map(([id, { secret, signingKey }]) => [id, local(secret), local(signingKey)]);
}

describe('encodeVaultKeys and decodeVaultKeys', () => {
  it('write each group’s keys as unpadded base64url JSON, under a format number', () => {
    const keys = new Map([['group-1', keysOf(0)]]);

    const json: unknown = JSON.parse(text(encodeVaultKeys(only(keys))));

    expect(VAULT_FORMAT).toBe(1);
    expect(json).toEqual({
      format: 1,
      groups: [{ groupId: 'group-1', secret: ZEROS, signingKey: ONES }],
    });
    expect(ZEROS).toBe('A'.repeat(43));
  });

  it('round-trip any groups’ keys, even a group id like __proto__', () => {
    const ids = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 8 });
    const key = fc.uint8Array({ minLength: 32, maxLength: 32 });
    fc.assert(
      fc.property(
        ids,
        fc.array(fc.tuple(key, key), { minLength: 8, maxLength: 8 }),
        (names, pairs) => {
          const keys = new Map(
            [...names, '__proto__'].map((id, i) => {
              const [secret, signingKey] = pairs[i % pairs.length] ?? [KEY, KEY];
              return [id, { secret, signingKey }] as const;
            }),
          );

          expect(comparable(decodeVaultKeys(encodeVaultKeys(only(keys))))).toEqual(
            comparable(keys),
          );
        },
      ),
    );
  });

  it.each([
    ['not JSON', 'nope'],
    ['another format', vaultJson([], 2)],
    ['no groups', '{"format":1}'],
    ['groups that isn’t a list', '{"format":1,"groups":{}}'],
    ['a group that isn’t an object', vaultJson([1])],
    ['a group id that isn’t text', vaultJson([{ ...entry('g'), groupId: 1 }])],
    ['a short secret', vaultJson([{ ...entry('g'), secret: ZEROS.slice(0, 4) }])],
    ['a padded key', vaultJson([{ ...entry('g'), secret: `${ZEROS}=` }])],
    ['a key that isn’t base64url', vaultJson([{ ...entry('g'), secret: `${ZEROS.slice(1)}!` }])],
    ['a missing signing key', vaultJson([{ groupId: 'g', secret: ZEROS }])],
    ['one group twice', vaultJson([entry('g'), entry('g')])],
  ])('read nothing from %s', (_name, json) => {
    expect(decodeVaultKeys(utf8(json))).toBeNull();
  });

  it('reads nothing from bytes that aren’t UTF-8', () => {
    expect(decodeVaultKeys(Uint8Array.of(0xff, 0xfe))).toBeNull();
  });

  it('carries a group’s encryption key (#98) when it has one, and reads a bad one as nothing', () => {
    const kx = new Uint8Array(32).fill(0xc5);
    const keys = new Map([['g', { ...keysOf(0), kxKey: kx }]]);

    const decoded = decodeVaultKeys(encodeVaultKeys(only(keys)));

    expect(local(decoded?.groups.get('g')?.kxKey ?? new Uint8Array())).toEqual(local(kx));
    expect(
      decodeVaultKeys(encodeVaultKeys(only(new Map([['g', keysOf(0)]]))))?.groups.get('g')?.kxKey,
    ).toBeUndefined();
    expect(decodeVaultKeys(utf8(vaultJson([{ ...entry('g'), kxKey: ZEROS.slice(2) }])))).toBeNull();
    expect(decodeVaultKeys(utf8(vaultJson([{ ...entry('g'), kxKey: 7 }])))).toBeNull();
  });

  it('carries the device’s relay backup key (#97) beside the groups, and reads a bad one as nothing', () => {
    const backupKey = new Uint8Array(32).fill(0xb7);
    const keys: VaultKeys = { groups: new Map([['g', keysOf(0)]]), backupKey };

    const json: unknown = JSON.parse(text(encodeVaultKeys(keys)));
    const decoded = decodeVaultKeys(encodeVaultKeys(keys));

    expect(json).toEqual({
      format: 1,
      groups: [{ groupId: 'g', secret: ZEROS, signingKey: ONES }],
      backupKey: base64url(backupKey),
    });
    expect(local(decoded?.backupKey ?? new Uint8Array())).toEqual(local(backupKey));
    expect(comparable(decoded)).toEqual(comparable(keys));
    expect(decodeVaultKeys(encodeVaultKeys(only(new Map())))).toEqual({ groups: new Map() });
    const withKey = (backup: unknown) =>
      JSON.stringify({ format: 1, groups: [], backupKey: backup });
    expect(decodeVaultKeys(utf8(withKey(ZEROS.slice(2))))).toBeNull();
    expect(decodeVaultKeys(utf8(withKey(`${ZEROS}=`)))).toBeNull();
    expect(decodeVaultKeys(utf8(withKey(7)))).toBeNull();
    expect(decodeVaultKeys(utf8(withKey(null)))).toBeNull();
    expect(local(decodeVaultKeys(utf8(withKey(ONES)))?.backupKey ?? new Uint8Array())).toEqual(
      local(new Uint8Array(32).fill(1)),
    );
  });

  it('reads the valid entry these tests break, so each refusal is the change’s', () => {
    expect(comparable(decodeVaultKeys(utf8(vaultJson([entry('g')]))))).toEqual(
      comparable(new Map([['g', keysOf(0)]])),
    );
  });
});

describe('newVault, openKeys and resealKeys', () => {
  it('seal an empty vault for the passkey, which opens to no keys', () => {
    const vault = newVault(LOCK, KEY);

    expect(Object.keys(vault).sort()).toEqual(['credentialId', 'id', 'prfSalt', 'sealed']);
    expect(vault.id).toBe('vault');
    expect(local(vault.credentialId)).toEqual(local(LOCK.credentialId));
    expect(local(vault.prfSalt)).toEqual(local(LOCK.prfSalt));
    expect(comparable(openKeys(vault, KEY))).toEqual([]);
    expect(openKeys(vault, KEY)?.backupKey).toBeUndefined();
  });

  it('keep the keys sealed under the vault key, with the credential id as associated data', () => {
    const keys = new Map([['group-1', keysOf(5)]]);

    const vault = resealKeys(newVault(LOCK, KEY), KEY, only(keys));

    const opened = openVault(KEY, LOCK.credentialId, vault.sealed);
    expect(decodeVaultKeys(opened ?? new Uint8Array(0))?.groups.get('group-1')?.secret[0]).toBe(5);
    expect(openVault(KEY, Uint8Array.of(9, 8), vault.sealed)).toBeNull();
    expect(comparable(openKeys(vault, KEY))).toEqual(comparable(keys));
  });

  it('open nothing under another key, a changed byte, or a vault that holds no keys', () => {
    const vault = resealKeys(newVault(LOCK, KEY), KEY, only(new Map([['g', keysOf(1)]])));
    const changed = Uint8Array.from(vault.sealed);
    changed[30] = (changed[30] ?? 0) ^ 1;
    const notKeys: VaultRecord = {
      ...vault,
      sealed: sealVault(KEY, LOCK.credentialId, utf8('{}')),
    };

    expect(openKeys(vault, OTHER_KEY)).toBeNull();
    expect(openKeys({ ...vault, sealed: changed }, KEY)).toBeNull();
    expect(openKeys({ ...vault, credentialId: Uint8Array.of(1) }, KEY)).toBeNull();
    expect(openKeys(notKeys, KEY)).toBeNull();
  });

  it('reseal under a fresh nonce each time', () => {
    const keys = new Map([['g', keysOf(1)]]);
    const vault = newVault(LOCK, KEY);

    const first = resealKeys(vault, KEY, only(keys));
    const second = resealKeys(vault, KEY, only(keys));

    expect(local(first.sealed)).not.toEqual(local(second.sealed));
  });
});
