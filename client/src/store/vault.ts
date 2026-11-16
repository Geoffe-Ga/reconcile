/**
 * The key vault (#95): every secret on the device in one record, sealed under
 * the key a passkey's PRF output derives (`crypto/keyVault.ts`).
 *
 * In the clear the record names only which passkey opens it (its credential
 * id) and the salt that passkey is asked with. Sealed inside is UTF-8 JSON,
 * with bytes in unpadded base64url:
 *
 * ```json
 * {"format": 2,
 *  "groups": [{"groupId": "…", "secret": "…", "signingKey": "…", "kxKey": "…"}],
 *  "backupKey": "…",
 *  "records": [{"store": "personal", "id": "…",
 *               "secrets": {"seed": "…", "secretKey": "…", "publicKey": "…"}}]}
 * ```
 *
 * That is each group's secret (its current epoch's, #98), signing key and,
 * once it has one, its X25519 encryption key (#98), the device's relay backup
 * key (#97) once it keeps one, and the secrets of records kept in other
 * stores (#255, #265): each by its store's name and the record's id, every
 * secret by its field's name. Today those are a shared personal Document's
 * share keys, a sent front-door application's reply keys and a recovering
 * device's request seed and secret key, in the device store (#118;
 * `./sealing.ts` says which fields), with no new format. Format 1, as #95 sealed it, held no record's
 * secrets: it still opens, and the next write seals it as format 2, which an
 * older app refuses to open rather than drop secrets it doesn't know. Later
 * secrets (the recovery shares this device holds for others, #109) join them
 * here, so the vault comes to cover every secret. Each new format bumps the
 * database's version too (`./db.ts`), so a build from before it can't open
 * the database at all, rather than read the vault as one that doesn't open.
 *
 * Only keys the vault reads back are sealed (#390): `encodeVaultKeys` decodes
 * its own plaintext and refuses keys that wouldn't come back exactly, since
 * one bad entry would make the whole vault fail to open, and every key in it
 * with it. So `resealKeys` throws, and the key transaction aborts, before a
 * malformed key reaches the vault.
 *
 * Zeroing is best effort (#391): each plaintext's bytes are zeroed once sealed
 * or read, and so are the keys an unlock opens only to check them, and the
 * copy an encode decodes. The JSON strings a plaintext passes through, and
 * the keys handed on to callers, can't be zeroed, so this narrows what a
 * memory dump finds rather than ruling it out.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { openVault, PRF_BYTES, sealVault } from '../crypto/keyVault';

/** The plaintext's format number: 2 adds other records' secrets (#255, #265). */
export const VAULT_FORMAT = 2;

/** The format #95 sealed, before the vault held any other record's secrets. */
const FIRST_FORMAT = 1;

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

/**
 * One record's secrets, by field name, each its bytes (#255, #265): what the
 * vault keeps for a record that lives in another store.
 */
export type Secrets = Readonly<Record<string, Uint8Array>>;

/**
 * Everything the vault holds: each group's keys, the device's relay backup
 * key (#97), and other records' secrets (#255, #265).
 */
export interface VaultKeys {
  /** Each group's keys, by its id. */
  readonly groups: Map<string, GroupKeys>;
  /** The relay backup's 32-byte key, once the device keeps one. */
  backupKey?: Uint8Array;
  /**
   * The secrets of records kept in other stores, by the store's name and then
   * the record's id: a shared personal Document's share keys and a sent
   * application's reply keys, for now.
   */
  readonly records: Map<string, Map<string, Secrets>>;
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

/** Keys a caller asked to seal that the vault couldn't read back exactly (#390). */
export class UnsealableKeys extends Error {
  /** Name the refusal; the keys stay out of the message. */
  constructor() {
    super('A key doesn’t fit the vault, so nothing was sealed.');
    this.name = 'UnsealableKeys';
  }
}

/** Every group's key and the relay backup key are 32 bytes. */
const KEY_BYTES = 32;

/** The longest secret a record may hold: room for any key or seed, with none of them near it. */
export const MAX_SECRET_BYTES = 64;

/** A store's name: lower-case letters, and hyphens after the first. */
const STORE_NAME = /^[a-z][a-z-]*$/;

/** A secret's field name: a letter, then letters and digits, as a record's own fields are named. */
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** Each record's secrets as the plaintext lists them, by store and id. */
function recordsJson(records: VaultKeys['records']) {
  return [...records].flatMap(([store, entries]) =>
    [...entries].map(([id, secrets]) => ({
      store,
      id,
      secrets: Object.fromEntries(
        Object.entries(secrets).map(([name, bytes]) => [name, base64url(bytes)]),
      ),
    })),
  );
}

/**
 * `keys` as the vault's plaintext, which {@link decodeVaultKeys} reads back
 * exactly (#390).
 *
 * @throws {UnsealableKeys} when it wouldn't: a key that isn't 32 bytes, a
 * secret of none or more than {@link MAX_SECRET_BYTES} bytes, a record with
 * no secret or no id, or a store or secret's name the vault doesn't take.
 */
export function encodeVaultKeys(keys: VaultKeys): Uint8Array<ArrayBuffer> {
  const plaintext = plaintextOf(keys);
  const check = decodeVaultKeys(plaintext);
  if (check === null) {
    plaintext.fill(0);
    throw new UnsealableKeys();
  }
  zeroVaultKeys(check);
  return plaintext;
}

/** `keys` spelled as the vault's plaintext, checked by no one yet. */
function plaintextOf({ groups, backupKey, records }: VaultKeys): Uint8Array<ArrayBuffer> {
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
    records: recordsJson(records),
  };
  return Uint8Array.from(new TextEncoder().encode(JSON.stringify(json)));
}

/** Whether `value` is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bytes `value` spells in canonical unpadded base64url, or null. */
function bytesIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64url(value);
    return base64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/** The 32 bytes `value` spells in canonical unpadded base64url, or null. */
function keyIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  const bytes = bytesIn(value);
  return bytes?.length === KEY_BYTES ? bytes : null;
}

/** A secret `value` spells: 1 to {@link MAX_SECRET_BYTES} bytes in canonical unpadded base64url, or null. */
function secretIn(value: unknown): Uint8Array<ArrayBuffer> | null {
  const bytes = bytesIn(value);
  return bytes !== null && bytes.length >= 1 && bytes.length <= MAX_SECRET_BYTES ? bytes : null;
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

/** One record's secrets in `value`, by field name, or null when any doesn't check out or it holds none. */
function secretsIn(value: unknown): Secrets | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value).map(
    ([name, spelled]) => [name, SECRET_NAME.test(name) ? secretIn(spelled) : null] as const,
  );
  if (entries.length === 0 || entries.some(([, bytes]) => bytes === null)) return null;
  return Object.fromEntries(entries) as Secrets;
}

/** One record's entry in `value`: its store, id and secrets, or null when any part doesn't check out. */
function recordIn(value: unknown): readonly [string, string, Secrets] | null {
  if (!isObject(value)) return null;
  const { store, id } = value;
  if (typeof store !== 'string' || !STORE_NAME.test(store)) return null;
  if (typeof id !== 'string' || id === '') return null;
  const secrets = secretsIn(value.secrets);
  return secrets === null ? null : [store, id, secrets];
}

/** Each record's secrets in `value`, by store and id, or null when it isn't a list of valid entries, each once. */
function recordsIn(value: unknown): Map<string, Map<string, Secrets>> | null {
  if (!Array.isArray(value)) return null;
  const records = new Map<string, Map<string, Secrets>>();
  for (const item of value) {
    const entry = recordIn(item);
    if (entry === null) return null;
    const [store, id, secrets] = entry;
    const held = records.get(store) ?? new Map<string, Secrets>();
    if (held.has(id)) return null;
    records.set(store, held.set(id, secrets));
  }
  return records;
}

/**
 * The records' secrets a plaintext of `json`'s format holds: none in format
 * 1, which never had the field, and format 2's list; null for anything else.
 */
function recordsFor(json: Record<string, unknown>): Map<string, Map<string, Secrets>> | null {
  if (json.format === FIRST_FORMAT) return 'records' in json ? null : new Map();
  return json.format === VAULT_FORMAT ? recordsIn(json.records) : null;
}

/** The keys in a vault's plaintext, or null when anything in it doesn't check out. */
export function decodeVaultKeys(bytes: Uint8Array): VaultKeys | null {
  const json = parseJson(bytes);
  if (!isObject(json)) return null;
  const groups = groupsIn(json.groups);
  const records = recordsFor(json);
  if (groups === null || records === null) return null;
  if (!('backupKey' in json)) return { groups, records };
  const backupKey = keyIn(json.backupKey);
  return backupKey === null ? null : { groups, records, backupKey };
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

/**
 * A vault for the passkey `lock`, holding no keys yet, sealed under `key`.
 *
 * @throws {RangeError} when `lock`'s salt isn't 32 bytes or it names no credential (#390).
 */
export function newVault(lock: VaultLock, key: Uint8Array): VaultRecord {
  if (lock.prfSalt.length !== PRF_BYTES || lock.credentialId.length === 0) {
    throw new RangeError('A passkey’s vault needs its credential id and a 32-byte salt.');
  }
  const empty: VaultRecord = {
    id: VAULT_ID,
    credentialId: Uint8Array.from(lock.credentialId),
    prfSalt: Uint8Array.from(lock.prfSalt),
    sealed: new Uint8Array(0),
  };
  return resealKeys(empty, key, { groups: new Map(), records: new Map() });
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

/**
 * Zeroes every key `keys` holds, best effort (#391): each group's, the relay
 * backup key and each record's secrets. For keys no one reads again, such as
 * those an unlock opens only to check them.
 */
export function zeroVaultKeys(keys: VaultKeys): void {
  for (const { secret, signingKey, kxKey } of keys.groups.values()) {
    secret.fill(0);
    signingKey.fill(0);
    kxKey?.fill(0);
  }
  keys.backupKey?.fill(0);
  for (const entries of keys.records.values()) {
    for (const secrets of entries.values()) {
      for (const bytes of Object.values(secrets)) bytes.fill(0);
    }
  }
}
