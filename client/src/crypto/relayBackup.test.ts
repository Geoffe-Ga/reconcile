/**
 * The relay backup's id and seal (#97; spec §3): pinned by a vector computed
 * outside @noble, then checked for every size, every changed byte and
 * another key.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { local, text, utf8 } from '../test/bytes';
import { base64url } from './base64url';
import {
  BACKUP_GROUP_TAG_INFO,
  BACKUP_ID_INFO,
  BACKUP_KEY_BYTES,
  BACKUP_SEAL_INFO,
  backupIdFor,
  groupTagFor,
  MAX_RELAY_BACKUP_PLAINTEXT,
  newBackupKey,
  openRelayBackup,
  RELAY_BACKUP_SIZES,
  RelayBackupTooLarge,
  relayBackupSize,
  sealRelayBackup,
} from './relayBackup';

/** `vectors/relayBackup.json`: derivations and one sealed blob, computed outside @noble. */
interface RelayBackupFile {
  readonly kind: 'relayBackup';
  readonly infos: {
    readonly backupId: string;
    readonly sealKey: string;
    readonly groupTag: string;
  };
  readonly vectors: readonly {
    readonly name: string;
    readonly key: readonly number[];
    readonly backupId: readonly number[];
    readonly sealKey: readonly number[];
  }[];
  readonly groupTags: readonly {
    readonly name: string;
    readonly key: readonly number[];
    readonly groupId: readonly number[];
    readonly author: readonly number[];
    readonly tag: readonly number[];
  }[];
  readonly sealed: {
    readonly key: readonly number[];
    readonly nonce: readonly number[];
    readonly plaintext: string;
    readonly size: number;
    readonly sha256: readonly number[];
    readonly head: readonly number[];
    readonly tail: readonly number[];
  };
}

const [vector] = Object.values(
  import.meta.glob<RelayBackupFile>('./vectors/relayBackup.json', {
    import: 'default',
    eager: true,
  }),
);
if (vector === undefined) throw new Error('vectors/relayBackup.json is missing.');

const MAGIC = utf8('RCR1');
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const keys = fc.uint8Array({ minLength: 32, maxLength: 32 });

afterEach(() => {
  vi.restoreAllMocks();
});

/** HKDF-SHA-256 with an empty salt by the platform's WebCrypto: a second implementation. */
async function platformHkdf(secret: Uint8Array, info: string | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const infoBytes = typeof info === 'string' ? utf8(info) : Uint8Array.from(info);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: infoBytes };
  return new Uint8Array(await crypto.subtle.deriveBits(params, key, 256));
}

/** Makes the next `getRandomValues` call fill in `bytes`, as the nonce a seal draws. */
function nextRandom(bytes: readonly number[]): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array !== null) new Uint8Array(array.buffer).set(bytes);
      return array;
    },
  );
}

describe('relayBackup.json', () => {
  it('names the labels and pins the id of each key', () => {
    expect(vector.kind).toBe('relayBackup');
    expect(vector.infos).toEqual({
      backupId: BACKUP_ID_INFO,
      sealKey: BACKUP_SEAL_INFO,
      groupTag: BACKUP_GROUP_TAG_INFO,
    });
    expect([BACKUP_ID_INFO, BACKUP_SEAL_INFO, BACKUP_GROUP_TAG_INFO]).toEqual([
      'reconcile/v1/backup-id',
      'reconcile/v1/backup-seal',
      'reconcile/v1/backup-group-tag',
    ]);
    for (const { key, backupId } of vector.vectors) {
      expect(backupIdFor(Uint8Array.from(key))).toBe(base64url(Uint8Array.from(backupId)));
    }
  });

  it('pins the tag of a group under each key, for each author (#327)', () => {
    expect(vector.groupTags).toHaveLength(2);
    for (const { key, groupId, author, tag } of vector.groupTags) {
      const id = base64url(Uint8Array.from(groupId));
      const member = base64url(Uint8Array.from(author));
      expect(groupTagFor(Uint8Array.from(key), id, member)).toBe(base64url(Uint8Array.from(tag)));
    }
  });

  it('seals byte for byte the blob sealed outside @noble, and opens it', () => {
    const { sealed } = vector;
    const key = Uint8Array.from(sealed.key);
    nextRandom(sealed.nonce);

    const blob = sealRelayBackup(key, utf8(sealed.plaintext));

    expect(blob).toHaveLength(sealed.size);
    expect(Array.from(blob.subarray(0, 64))).toEqual(sealed.head);
    expect(Array.from(blob.subarray(-32))).toEqual(sealed.tail);
    expect(Array.from(sha256(blob))).toEqual(sealed.sha256);
    expect(text(openRelayBackup(key, blob) ?? new Uint8Array())).toBe(sealed.plaintext);
  });
});

describe('backupIdFor', () => {
  it('is WebCrypto’s HKDF of the key under its label, as 43 base64url characters', async () => {
    await fc.assert(
      fc.asyncProperty(keys, async (key) => {
        const id = backupIdFor(key);

        expect(id).toBe(base64url(await platformHkdf(key, BACKUP_ID_INFO)));
        expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(id).not.toBe(base64url(key));
      }),
      { numRuns: 30 },
    );
  });

  it('is unrelated to the group mailbox a group secret of the same bytes would name', async () => {
    expect(backupIdFor(KEY)).not.toBe(base64url(await platformHkdf(KEY, 'reconcile/v1/mailbox')));
  });

  it.each([0, 16, 31, 33])('refuses a %i-byte key', (length) => {
    expect(() => backupIdFor(new Uint8Array(length))).toThrow(
      new RangeError('A backup key is 32 bytes.'),
    );
  });
});

describe('groupTagFor (#327)', () => {
  const ids = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(base64url);

  it('is WebCrypto’s HKDF of the key under its label, a zero byte, the group id, a zero byte and the author', async () => {
    await fc.assert(
      fc.asyncProperty(keys, ids, ids, async (key, groupId, author) => {
        const info = utf8(`${BACKUP_GROUP_TAG_INFO}\u0000${groupId}\u0000${author}`);

        const tag = groupTagFor(key, groupId, author);

        expect(tag).toBe(base64url(await platformHkdf(key, info)));
        expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect([groupId, author, backupIdFor(key)]).not.toContain(tag);
      }),
      { numRuns: 30 },
    );
  });

  it('differs for another key, another group, or another author in the same group', () => {
    const [groupId, author, other] = ['a', 'b', 'c'].map((fill) =>
      base64url(utf8(fill.repeat(32))),
    );
    if (groupId === undefined || author === undefined || other === undefined) {
      throw new Error('Expected three ids.');
    }
    const tag = groupTagFor(KEY, groupId, author);

    expect(groupTagFor(KEY, groupId, author)).toBe(tag);
    expect(groupTagFor(OTHER_KEY, groupId, author)).not.toBe(tag);
    expect(groupTagFor(KEY, other, author)).not.toBe(tag);
    expect(groupTagFor(KEY, groupId, other)).not.toBe(tag);
    expect(groupTagFor(KEY, author, groupId)).not.toBe(tag);
  });

  it.each([
    ['a short group id', 'x'.repeat(42), 'y'.repeat(43)],
    ['a long group id', 'x'.repeat(44), 'y'.repeat(43)],
    ['a group id outside base64url', `${'x'.repeat(42)}=`, 'y'.repeat(43)],
    ['a short author', 'x'.repeat(43), 'y'.repeat(42)],
    ['an author outside base64url', 'x'.repeat(43), `${'y'.repeat(42)}\u0000`],
  ])('refuses %s', (_, groupId, author) => {
    expect(() => groupTagFor(KEY, groupId, author)).toThrow(
      new RangeError('A group id and an author are each 43 base64url characters.'),
    );
  });

  it('refuses a key that isn’t 32 bytes', () => {
    expect(() => groupTagFor(new Uint8Array(31), 'x'.repeat(43), 'y'.repeat(43))).toThrow(
      new RangeError('A backup key is 32 bytes.'),
    );
  });
});

describe('newBackupKey', () => {
  it('is 32 bytes from the platform’s CSPRNG, new each time', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const key = newBackupKey();
    const more = Array.from({ length: 10 }, () => bytesToHex(newBackupKey()));

    expect(BACKUP_KEY_BYTES).toBe(32);
    expect(key).toHaveLength(32);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(key));
    expect(new Set([bytesToHex(key), ...more]).size).toBe(11);
  });
});

describe('relayBackupSize', () => {
  it('is the smallest of the five sizes that holds the plaintext and its 48 bytes', () => {
    expect(RELAY_BACKUP_SIZES).toEqual([65536, 262144, 1048576, 4194304, 16777216]);
    expect(MAX_RELAY_BACKUP_PLAINTEXT).toBe(16777216 - 48);
    expect(relayBackupSize(0)).toBe(65536);
    expect(relayBackupSize(65536 - 48)).toBe(65536);
    expect(relayBackupSize(65536 - 47)).toBe(262144);
    expect(relayBackupSize(262144 - 48)).toBe(262144);
    expect(relayBackupSize(262144 - 47)).toBe(1048576);
    expect(relayBackupSize(4194304 - 47)).toBe(16777216);
    expect(relayBackupSize(MAX_RELAY_BACKUP_PLAINTEXT)).toBe(16777216);
    expect(relayBackupSize(MAX_RELAY_BACKUP_PLAINTEXT + 1)).toBeNull();
  });
});

describe('sealRelayBackup and openRelayBackup', () => {
  it('frame RCR1, a fresh nonce and the ciphertext, in exactly one of the five sizes', () => {
    const plaintext = utf8('{"format":1,"groups":[]}');

    const first = sealRelayBackup(KEY, plaintext);
    const second = sealRelayBackup(KEY, plaintext);

    expect(first).toHaveLength(65536);
    expect(local(first.subarray(0, 4))).toEqual(MAGIC);
    expect(bytesToHex(first.subarray(4, 28))).not.toBe(bytesToHex(second.subarray(4, 28)));
    expect(bytesToHex(first)).not.toBe(bytesToHex(second));
    expect(text(openRelayBackup(KEY, second) ?? new Uint8Array())).toBe(text(plaintext));
  });

  it.each([
    [0, 65536],
    [65536 - 48, 65536],
    [65536 - 47, 262144],
    [262144 - 47, 1048576],
    [1048576 - 47, 4194304],
  ])('round-trip a %i-byte plaintext in a %i-byte blob', (length, size) => {
    const plaintext = new Uint8Array(length);
    for (let i = 0; i < length; i += 97) plaintext[i] = (i * 7 + 3) % 251;

    const blob = sealRelayBackup(KEY, plaintext);

    expect(blob).toHaveLength(size);
    // Compared by digest: hex of megabytes is slower than sealing them.
    const opened = openRelayBackup(KEY, blob) ?? new Uint8Array(1);
    expect([opened.length, bytesToHex(sha256(opened))]).toEqual([
      length,
      bytesToHex(sha256(plaintext)),
    ]);
  });

  it('round-trip the largest plaintext, and refuse one byte more', () => {
    const largest = new Uint8Array(MAX_RELAY_BACKUP_PLAINTEXT).fill(0x5a);

    const blob = sealRelayBackup(KEY, largest);

    expect(blob).toHaveLength(16777216);
    expect(openRelayBackup(KEY, blob)?.length).toBe(MAX_RELAY_BACKUP_PLAINTEXT);
    expect(() => sealRelayBackup(KEY, new Uint8Array(MAX_RELAY_BACKUP_PLAINTEXT + 1))).toThrow(
      RelayBackupTooLarge,
    );
  });

  it('open to null for any single changed byte: magic, nonce, body or tag', () => {
    const blob = sealRelayBackup(KEY, utf8('{"format":1,"groups":[]}'));
    const at = [0, 1, 2, 3, 4, 27, 28, 29, 31, 32, 1000, 65535 - 16, 65535];

    for (const index of at) {
      const changed = Uint8Array.from(blob);
      changed[index] = (changed[index] ?? 0) ^ 0x01;
      expect(openRelayBackup(KEY, changed), String(index)).toBeNull();
    }
  });

  it('open to null under another key, cut short, grown, or empty', () => {
    const blob = sealRelayBackup(KEY, utf8('{"format":1,"groups":[]}'));

    expect(openRelayBackup(OTHER_KEY, blob)).toBeNull();
    expect(openRelayBackup(KEY, blob.subarray(0, 65535))).toBeNull();
    expect(openRelayBackup(KEY, Uint8Array.from([...blob, 0]))).toBeNull();
    expect(openRelayBackup(KEY, new Uint8Array(0))).toBeNull();
    expect(openRelayBackup(KEY, new Uint8Array(65536))).toBeNull();
  });

  it('round-trip any plaintext, and every changed byte opens to null', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 2048 }),
        fc.nat({ max: 65535 }),
        (plaintext, index) => {
          const blob = sealRelayBackup(KEY, plaintext);
          const changed = Uint8Array.from(blob);
          changed[index] = (changed[index] ?? 0) ^ 0x80;

          expect(bytesToHex(openRelayBackup(KEY, blob) ?? new Uint8Array(1))).toBe(
            bytesToHex(plaintext),
          );
          expect(openRelayBackup(KEY, changed)).toBeNull();
        },
      ),
      { numRuns: 25 },
    );
  });

  it.each([0, 31, 33])('refuse a %i-byte key', (length) => {
    expect(() => sealRelayBackup(new Uint8Array(length), utf8('{}'))).toThrow(RangeError);
    expect(() => openRelayBackup(new Uint8Array(length), new Uint8Array(65536))).toThrow(
      RangeError,
    );
  });
});
