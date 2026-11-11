/**
 * The key vault (#95): every secret on the device in one record, sealed under
 * the key a passkey's PRF output derives (`crypto/keyVault.ts`).
 *
 * In the clear the record names only which passkey opens it (its credential
 * id) and the salt that passkey is asked with. Sealed inside is UTF-8 JSON,
 * with bytes in unpadded base64url:
 *
 * ```json
 * {"format": 1, "groups": [{"groupId": "…", "secret": "…", "signingKey": "…", "kxKey": "…"}], "backupKey": "…"}
 * ```
 *
 * Today that is each group's secret (its current epoch's, #98), signing key
 * and, once it has one, its X25519 encryption key (#98), and the device's
 * relay backup key (#97) once it keeps one. #97 landed before the vault
 * shipped, so format 1 holds its key, as an optional field. Later secrets
 * (#105's share seeds and keys, the recovery shares this device holds for
 * others, #109) join them here under a new format number, so the vault keeps
 * covering every secret. Each plaintext is zeroed once sealed or read.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { openVault, sealVault } from '../crypto/keyVault';

/** The plaintext's format number, which a later layout would change. */
export const VAULT_FORMAT = 1;

/** The vault record's key in its object store: the device has at most one. */
export const VAULT_ID = 'vault';

/**
 * A group's secrets: its 32-byte group secret, this membership's signing
 * key, and its encryption key once it has one (#98).
 */
export interface GroupKeys {
  readonly secret: Uint8Array;
  readonly signingKey: Uint8Array;
  readonly kxKey?: Uint8Array;
}

/** Everything the vault holds: each group's keys, and the device's relay backup key (#97). */
export interface VaultKeys {
  /** Each group's keys, by its id. */
  readonly groups: Map<string, GroupKeys>;
  /** The relay backup's 32-byte key, once the device keeps one. */
  backupKey?: Uint8Array;
}

/** What the vault says in the clear: the passkey that opens it, and the salt it's asked with. */
export interface VaultLock {
  readonly credentialId: Uint8Array;
  readonly prfSalt: Uint8Array;
}

/** The vault as IndexedDB keeps it. */
export interface VaultRecord extends VaultLock {
  readonly id: typeof VAULT_ID;
  /** nonce ‖ ciphertext ‖ tag, as `sealVault` makes it. */
  readonly sealed: Uint8Array;
}

/** Every key the vault holds is 32 bytes. */
const KEY_BYTES = 32;

/** `keys` as the vault's plaintext. */
export function encodeVaultKeys({ groups, backupKey }: VaultKeys): Uint8Array<ArrayBuffer> {
  const entries = [...groups].map(([groupId, { secret, signingKey, kxKey }]) => ({
    groupId,
    secret: base64url(secret),
    signingKey: base64url(signingKey),
    ...(kxKey === undefined ? {} : { kxKey: base64url(kxKey) }),
  }));
  const json = {
    format: VAULT_FORMAT,
    groups: entries,
    ...(backupKey === undefined ? {} : { backupKey: base64url(backupKey) }),
  };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/** Whether `value` is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The 32 bytes `value` spells in canonical unpadded base64url, or null. */
function keyIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64url(value);
    return bytes.length === KEY_BYTES && base64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/** One group's entry in `value`, or null when any part of it doesn't check out. */
function entryIn(value: unknown): readonly [string, GroupKeys] | null {
  if (!isObject(value) || typeof value.groupId !== 'string') return null;
  const secret = keyIn(value.secret);
  const signingKey = keyIn(value.signingKey);
  const kxKey = value.kxKey === undefined ? undefined : keyIn(value.kxKey);
  if (secret === null || signingKey === null || kxKey === null) return null;
  return [value.groupId, { secret, signingKey, ...(kxKey === undefined ? {} : { kxKey }) }];
}

/** The JSON value `bytes` spell in UTF-8, or undefined when they don't. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Each group's keys in `value`, or null when it isn't a list of valid entries, each group once. */
function groupsIn(value: unknown): Map<string, GroupKeys> | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map(entryIn);
  if (entries.some((entry) => entry === null)) return null;
  const groups = new Map(entries.filter((entry) => entry !== null));
  return groups.size === entries.length ? groups : null;
}

/** The keys in a vault's plaintext, or null when anything in it doesn't check out. */
export function decodeVaultKeys(bytes: Uint8Array): VaultKeys | null {
  const json = parseJson(bytes);
  if (!isObject(json) || json.format !== VAULT_FORMAT) return null;
  const groups = groupsIn(json.groups);
  if (groups === null) return null;
  if (!('backupKey' in json)) return { groups };
  const backupKey = keyIn(json.backupKey);
  return backupKey === null ? null : { groups, backupKey };
}

/** `vault` with `keys` sealed in it under `key`, under a fresh nonce. */
export function resealKeys(vault: VaultRecord, key: Uint8Array, keys: VaultKeys): VaultRecord {
  const plaintext = encodeVaultKeys(keys);
  try {
    return { ...vault, sealed: sealVault(key, vault.credentialId, plaintext) };
  } finally {
    plaintext.fill(0);
  }
}

/** A vault for the passkey `lock`, holding no keys yet, sealed under `key`. */
export function newVault(lock: VaultLock, key: Uint8Array): VaultRecord {
  const empty: VaultRecord = {
    id: VAULT_ID,
    credentialId: Uint8Array.from(lock.credentialId),
    prfSalt: Uint8Array.from(lock.prfSalt),
    sealed: new Uint8Array(0),
  };
  return resealKeys(empty, key, { groups: new Map() });
}

/** The keys `vault` holds, opened under `key`, or null when it doesn't open or doesn't check out. */
export function openKeys(vault: VaultRecord, key: Uint8Array): VaultKeys | null {
  const plaintext = openVault(key, vault.credentialId, vault.sealed);
  if (plaintext === null) return null;
  try {
    return decodeVaultKeys(plaintext);
  } finally {
    plaintext.fill(0);
  }
}
