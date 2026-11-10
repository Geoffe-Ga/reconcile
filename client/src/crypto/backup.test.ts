import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BACKUP_HEADER_BYTES,
  BACKUP_LOG2_N,
  BackupUnreadable,
  MAX_LOG2_N,
  openBackup,
  sealBackup,
} from './backup';

// The real scrypt, watched, so a test can tell a header refused before any key was derived.
vi.mock('@noble/hashes/scrypt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/hashes/scrypt.js')>();
  return { ...actual, scryptAsync: vi.fn(actual.scryptAsync) };
});

/** `vectors/backup.json`: one file sealed outside @noble at the default cost. */
interface BackupVector {
  readonly kind: 'backup';
  readonly passphrase: string;
  readonly file: readonly number[];
  readonly plaintext: string;
}

const [vector] = Object.values(
  import.meta.glob<BackupVector>('./vectors/backup.json', { import: 'default', eager: true }),
);
if (vector === undefined) throw new Error('vectors/backup.json is missing.');

/** A cheap cost for tests that don't check the cost itself: N = 2^4. */
const CHEAP = 4;
const PASSPHRASE = 'correct horse battery staple';
const PLAINTEXT = utf8ToBytes('{"format":1,"groups":[]}');

afterEach(() => {
  vi.mocked(scryptAsync).mockClear();
});

/** What `openBackup` rejects with, read as name and message so every failure can be compared. */
async function failureOf(file: Uint8Array, passphrase: string): Promise<string> {
  const error: unknown = await openBackup(file, passphrase).then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof BackupUnreadable)) throw new Error('Expected BackupUnreadable.');
  return `${error.name}: ${error.message}`;
}

const UNREADABLE = `BackupUnreadable: ${new BackupUnreadable().message}`;

describe('backup.json', () => {
  it('opens a file sealed outside @noble, at the cost its header names, under its passphrase’s NFC form', async () => {
    expect(vector.kind).toBe('backup');
    // The vector writes "é" as e + U+0301; it was sealed under the composed form.
    expect(vector.passphrase).not.toBe(vector.passphrase.normalize('NFC'));

    const opened = await openBackup(Uint8Array.from(vector.file), vector.passphrase);

    expect(new TextDecoder().decode(opened)).toBe(vector.plaintext);
    expect(vi.mocked(scryptAsync).mock.calls[0]?.[2]).toEqual({
      N: 2 ** 10,
      r: 8,
      p: 1,
      dkLen: 32,
    });
  });
});

describe('sealBackup', () => {
  it('writes RCB1, log2 N 17, r 8 and p 1, then a salt, a nonce, and the sealed plaintext and tag', async () => {
    // The cost is what's checked here, not the derivation: 2^17 takes about a second of
    // 128 MiB, so this one call gets a fixed key. The e2e backup spec derives it for real.
    vi.mocked(scryptAsync).mockResolvedValueOnce(new Uint8Array(32).fill(7));

    const file = await sealBackup(PLAINTEXT, PASSPHRASE);

    expect(BACKUP_LOG2_N).toBe(17);
    expect(BACKUP_HEADER_BYTES).toBe(47);
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe('RCB1');
    expect(Array.from(file.subarray(4, 7))).toEqual([17, 8, 1]);
    expect(file).toHaveLength(47 + PLAINTEXT.length + 16);
    expect(scryptAsync).toHaveBeenCalledTimes(1);
    const [secret, salt, options] = vi.mocked(scryptAsync).mock.calls[0] ?? [];
    expect(options).toEqual({ N: 2 ** 17, r: 8, p: 1, dkLen: 32 });
    expect(bytesToHex(salt as Uint8Array)).toBe(bytesToHex(file.subarray(7, 23)));
    // The passphrase's bytes are wiped once the key is derived.
    expect(Array.from(secret as Uint8Array).every((byte) => byte === 0)).toBe(true);
  });

  it('round-trips, with a fresh salt and nonce each time, and hides the plaintext', async () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    const first = await sealBackup(PLAINTEXT, PASSPHRASE, CHEAP);
    const second = await sealBackup(PLAINTEXT, PASSPHRASE, CHEAP);

    expect(random).toHaveBeenCalledTimes(4);
    expect(bytesToHex(first.subarray(7, 23))).not.toBe(bytesToHex(second.subarray(7, 23)));
    expect(bytesToHex(first.subarray(23, 47))).not.toBe(bytesToHex(second.subarray(23, 47)));
    expect(bytesToHex(first.subarray(47, -16))).not.toBe(bytesToHex(PLAINTEXT));
    expect(Array.from(await openBackup(first, PASSPHRASE))).toEqual(Array.from(PLAINTEXT));
    expect(Array.from(await openBackup(second, PASSPHRASE))).toEqual(Array.from(PLAINTEXT));
    random.mockRestore();
  });

  it('derives from the NFC form, so a composed and a decomposed passphrase open the same file', async () => {
    const file = await sealBackup(PLAINTEXT, 'Caf\u00e9 at dawn', CHEAP);

    expect(Array.from(await openBackup(file, 'Cafe\u0301 at dawn'))).toEqual(Array.from(PLAINTEXT));
  });

  it.each([0, -1, MAX_LOG2_N + 1, 2.5])('refuses log2 N %s', async (log2N) => {
    await expect(sealBackup(PLAINTEXT, PASSPHRASE, log2N)).rejects.toThrow(
      new RangeError('A backup’s log2 N is a whole number from 1 to 20.'),
    );
  });
});

describe('openBackup', () => {
  it('refuses a wrong passphrase with the one plain error', async () => {
    const file = await sealBackup(PLAINTEXT, PASSPHRASE, CHEAP);

    expect(await failureOf(file, 'correct horse battery stapler')).toBe(UNREADABLE);
    expect(await failureOf(file, '')).toBe(UNREADABLE);
  });

  it('refuses a file with any single byte changed, in the header or the body, alike', async () => {
    const file = await sealBackup(PLAINTEXT, PASSPHRASE, CHEAP);
    const failures = new Set<string>();

    for (let at = 0; at < file.length; at += 1) {
      for (const flip of [0x01, 0x80]) {
        const changed = Uint8Array.from(file);
        changed[at] = (changed[at] ?? 0) ^ flip;
        failures.add(await failureOf(changed, PASSPHRASE));
      }
    }

    expect([...failures]).toEqual([UNREADABLE]);
  });

  it.each([0, 4, 46, 47, 62])(
    'refuses a file cut to %i bytes before deriving a key',
    async (length) => {
      const file = await sealBackup(PLAINTEXT, PASSPHRASE, CHEAP);
      vi.mocked(scryptAsync).mockClear();

      expect(await failureOf(file.subarray(0, length), PASSPHRASE)).toBe(UNREADABLE);
      expect(scryptAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['another magic', 0, 0x32],
    ['log2 N 0', 4, 0],
    ['log2 N 21', 4, MAX_LOG2_N + 1],
    ['log2 N 255', 4, 255],
    ['r 7', 5, 7],
    ['p 2', 6, 2],
  ])('refuses %s before deriving a key', async (_name, at, value) => {
    const file = await sealBackup(PLAINTEXT, PASSPHRASE, CHEAP);
    file[at] = value;
    vi.mocked(scryptAsync).mockClear();

    expect(await failureOf(file, PASSPHRASE)).toBe(UNREADABLE);
    expect(scryptAsync).not.toHaveBeenCalled();
  });

  it('reads the cost from the header, up to log2 N 20', async () => {
    const file = await sealBackup(PLAINTEXT, PASSPHRASE, 5);
    vi.mocked(scryptAsync).mockClear();

    await openBackup(file, PASSPHRASE);

    expect(MAX_LOG2_N).toBe(20);
    expect(vi.mocked(scryptAsync).mock.calls[0]?.[2]).toEqual({ N: 32, r: 8, p: 1, dkLen: 32 });
  });
});
