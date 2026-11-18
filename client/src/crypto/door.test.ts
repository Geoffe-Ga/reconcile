import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from './base64url';
import { BOX_OVERHEAD, kxPublicKeyOf, newKxKey, openBox, sealTo } from './box';
import {
  applicationIdOf,
  APPLICATION_INFO,
  DOOR_INBOX_INFO,
  DOOR_PAGE_INFO,
  DOOR_PAGE_KEY_INFO,
  DOOR_REPLY_INFO,
  DOOR_SECRET_BYTES,
  doorChannelsOf,
  doorKeysOf,
  MAX_PADDED_PLAINTEXT,
  newDoorSecrets,
  newReplySeed,
  openDoorRecord,
  openPadded,
  REPLY_INFO,
  replyMailboxOf,
  sealPadded,
  signDoorRecord,
} from './door';
import { deriveWeekMailboxId } from './groupKeys';
import { deriveInviteMailboxId } from './invite';
import { BLOB_SIZES, PayloadTooLarge } from './seal';
import { deriveShareMailboxId } from './share';
import { DOOR_PAGE_CONTEXT, EVENT_CONTEXT, newSigningKeys, SHARE_CONTEXT, sign } from './sign';
import { signShareRecord } from './share';

/** `vectors/door.json`: a door's derivations, one page and two padded boxes, made outside @noble. */
interface DoorFile {
  readonly kind: 'door';
  readonly infos: Readonly<Record<string, string>>;
  readonly doors: readonly {
    readonly name: string;
    readonly signSecret: readonly number[];
    readonly signPublic: readonly number[];
    readonly boxSecret: readonly number[];
    readonly boxPublic: readonly number[];
    readonly pageMailbox: readonly number[];
    readonly pageKey: readonly number[];
    readonly inbox: readonly number[];
  }[];
  readonly replies: readonly {
    readonly name: string;
    readonly seed: readonly number[];
    readonly replyMailbox: readonly number[];
  }[];
  readonly records: readonly {
    readonly name: string;
    readonly signSecret: readonly number[];
    readonly page: readonly number[];
    readonly record: readonly number[];
  }[];
  readonly boxes: readonly {
    readonly name: string;
    readonly recipientSecret: readonly number[];
    readonly info: string;
    readonly mailbox: readonly number[];
    readonly plaintext: readonly number[];
    readonly blob: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<DoorFile>('./vectors/door.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/door.json is missing.');

const bytes = (list: readonly number[]) => Uint8Array.from(list);
const keys32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const INBOX = 'test-inbox-'.padEnd(43, '0');

/** Bytes as hex, or null: TextEncoder's arrays come from another realm than @noble's. */
const hex = (value: Uint8Array | null): string | null =>
  value === null ? null : bytesToHex(value);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('door.json, made outside @noble', () => {
  it('names the labels each derivation, the page and the boxes use', () => {
    expect(file.kind).toBe('door');
    expect(file.infos).toEqual({
      pageMailbox: DOOR_PAGE_INFO,
      pageKey: DOOR_PAGE_KEY_INFO,
      inbox: DOOR_INBOX_INFO,
      replyMailbox: DOOR_REPLY_INFO,
      record: DOOR_PAGE_CONTEXT,
      application: APPLICATION_INFO,
      reply: REPLY_INFO,
    });
    expect(file.infos).toEqual({
      pageMailbox: 'reconcile/v1/door-page',
      pageKey: 'reconcile/v1/door-page-key',
      inbox: 'reconcile/v1/door-inbox',
      replyMailbox: 'reconcile/v1/door-reply',
      record: 'reconcile/v1/door-page',
      application: 'reconcile/v1/door-application',
      reply: 'reconcile/v1/door-reply-box',
    });
  });

  it.each(file.doors.map((vector) => [vector.name, vector] as const))(
    'pins the keys and channels of %s',
    (_name, vector) => {
      const keys = doorKeysOf(bytes(vector.signSecret), bytes(vector.boxSecret));
      expect(Array.from(keys.signing.publicKey)).toEqual(vector.signPublic);
      expect(Array.from(keys.signing.secretKey)).toEqual(vector.signSecret);
      expect(Array.from(keys.boxPublic)).toEqual(vector.boxPublic);
      expect(Array.from(keys.boxSecret)).toEqual(vector.boxSecret);
      expect(doorChannelsOf(bytes(vector.signPublic))).toEqual({
        page: base64url(bytes(vector.pageMailbox)),
        pageKey: bytes(vector.pageKey),
        inbox: base64url(bytes(vector.inbox)),
      });
    },
  );

  it.each(file.replies.map((vector) => [vector.name, vector] as const))(
    'pins the reply mailbox of %s',
    (_name, vector) => {
      expect(replyMailboxOf(bytes(vector.seed))).toBe(base64url(bytes(vector.replyMailbox)));
    },
  );

  it.each(file.records.map((vector) => [vector.name, vector] as const))(
    'pins %s, which opens under that door only',
    (_name, vector) => {
      const { signing } = doorKeysOf(bytes(vector.signSecret), newKxKey());
      const record = signDoorRecord(signing, bytes(vector.page));
      expect(Array.from(record)).toEqual(vector.record);
      expect(Array.from(openDoorRecord(bytes(vector.record), signing.publicKey) ?? [])).toEqual(
        vector.page,
      );
      expect(openDoorRecord(bytes(vector.record), newSigningKeys().publicKey)).toBeNull();
    },
  );

  it.each(file.boxes.map((vector) => [vector.name, vector] as const))(
    'opens %s, a blob of one of the four sizes',
    (_name, vector) => {
      const blob = bytes(vector.blob);
      const mailbox = base64url(bytes(vector.mailbox));
      const secret = bytes(vector.recipientSecret);
      expect(BLOB_SIZES).toContain(blob.length);
      expect(Array.from(openPadded(secret, blob, vector.info, mailbox) ?? [])).toEqual(
        vector.plaintext,
      );
      expect(openPadded(secret, blob, vector.info, INBOX)).toBeNull();
      expect(openPadded(secret, blob, 'reconcile/v1/another', mailbox)).toBeNull();
      expect(openPadded(newKxKey(), blob, vector.info, mailbox)).toBeNull();
    },
  );
});

describe('newDoorSecrets', () => {
  it('draws a sign and a box secret of 32 bytes each from the platform’s CSPRNG, new each time', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    const { sign: signSecret, box } = newDoorSecrets();
    expect(DOOR_SECRET_BYTES).toBe(32);
    expect(signSecret).toHaveLength(32);
    expect(box).toHaveLength(32);
    expect(random).toHaveBeenCalledTimes(2);
    expect(bytesToHex(signSecret)).not.toBe(bytesToHex(box));
    const made = Array.from({ length: 10 }, () => base64url(newDoorSecrets().sign));
    expect(new Set(made).size).toBe(10);
  });
});

describe('the door’s channels', () => {
  it('are three ids and a key, apart from each other and from every other derivation', () => {
    fc.assert(
      fc.property(keys32, (key) => {
        const { page, pageKey, inbox } = doorChannelsOf(key);
        for (const id of [page, inbox]) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const others = [
          inbox,
          base64url(pageKey),
          base64url(key),
          replyMailboxOf(key),
          deriveWeekMailboxId(key, 0),
          deriveWeekMailboxId(key, 2913),
          deriveInviteMailboxId(key),
          deriveShareMailboxId(key),
        ];
        expect(new Set([page, ...others]).size).toBe(others.length + 1);
      }),
      { numRuns: 50 },
    );
  });

  it.each([0, 31, 33])('refuse a %i-byte door key or reply seed', (length) => {
    expect(() => doorChannelsOf(new Uint8Array(length))).toThrow(
      new RangeError('A door key is 32 bytes.'),
    );
    expect(() => replyMailboxOf(new Uint8Array(length))).toThrow(
      new RangeError('A reply seed is 32 bytes.'),
    );
  });

  it('make each reply seed 32 fresh bytes', () => {
    const seed = newReplySeed();
    expect(seed).toHaveLength(32);
    expect(base64url(newReplySeed())).not.toBe(base64url(seed));
  });
});

describe('door records', () => {
  const { signing } = doorKeysOf(newDoorSecrets().sign, newKxKey());
  const PAGE = new TextEncoder().encode('{"v":1,"open":false}');
  const record = signDoorRecord(signing, PAGE);

  it('are the door’s public key, its signature under the door-page tag, then the page', () => {
    expect(record).toHaveLength(32 + 64 + PAGE.length);
    expect(bytesToHex(record.subarray(0, 32))).toBe(bytesToHex(signing.publicKey));
    expect(bytesToHex(record.subarray(32, 96))).toBe(
      bytesToHex(sign(DOOR_PAGE_CONTEXT, signing.secretKey, PAGE)),
    );
    expect(hex(openDoorRecord(record, signing.publicKey))).toBe(bytesToHex(PAGE));
  });

  it('never open when signed by another key, even one the record names', () => {
    const other = newSigningKeys();
    const forged = signDoorRecord(other, PAGE);
    expect(openDoorRecord(forged, signing.publicKey)).toBeNull();
    expect(hex(openDoorRecord(forged, other.publicKey))).toBe(bytesToHex(PAGE));
  });

  it('never open with one byte changed, too few bytes, or a key of the wrong length', () => {
    for (const index of [0, 31, 32, 95, 96, record.length - 1]) {
      const flipped = Uint8Array.from(record);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      expect(openDoorRecord(flipped, signing.publicKey)).toBeNull();
    }
    expect(openDoorRecord(record.subarray(0, 95), signing.publicKey)).toBeNull();
    expect(openDoorRecord(record, signing.publicKey.subarray(0, 31))).toBeNull();
  });

  it('are never a share’s copy or an event, nor the other way round', () => {
    const share = signShareRecord(signing, PAGE);
    expect(openDoorRecord(share, signing.publicKey)).toBeNull();
    const event = Uint8Array.from([
      ...signing.publicKey,
      ...sign(EVENT_CONTEXT, signing.secretKey, PAGE),
      ...PAGE,
    ]);
    expect(openDoorRecord(event, signing.publicKey)).toBeNull();
    expect(SHARE_CONTEXT).not.toBe(DOOR_PAGE_CONTEXT);
  });
});

describe('applicationIdOf', () => {
  it('is the SHA-256 of the sealed blob, in unpadded base64url, as WebCrypto computes it', async () => {
    for (const blob of [new Uint8Array(), Uint8Array.of(1), new Uint8Array(1024).fill(7)]) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob));
      expect(applicationIdOf(blob)).toBe(base64url(digest));
    }
    expect(applicationIdOf(Uint8Array.of(1))).not.toBe(applicationIdOf(Uint8Array.of(2)));
  });
});

describe('padded boxes', () => {
  const secret = newKxKey();
  const publicKey = kxPublicKeyOf(secret);

  it('are exactly one of the four blob sizes, the smallest that fits, and open again', () => {
    for (const [length, size] of [
      [0, 1024],
      [1024 - BOX_OVERHEAD - 4, 1024],
      [1024 - BOX_OVERHEAD - 3, 4096],
      [65536 - BOX_OVERHEAD - 4, 65536],
    ] as const) {
      const plaintext = new Uint8Array(length).fill(7);
      const blob = sealPadded(publicKey, plaintext, APPLICATION_INFO, INBOX);
      expect(blob).toHaveLength(size);
      expect(hex(openPadded(secret, blob, APPLICATION_INFO, INBOX))).toBe(bytesToHex(plaintext));
    }
  });

  it('can be held to one size whatever their length, and still grow past it (#490)', () => {
    for (const [length, size] of [
      [0, 4096],
      [4096 - BOX_OVERHEAD - 4, 4096],
      [4096 - BOX_OVERHEAD - 3, 16384],
    ] as const) {
      const plaintext = new Uint8Array(length).fill(7);
      const blob = sealPadded(publicKey, plaintext, APPLICATION_INFO, INBOX, 4096);
      expect(blob).toHaveLength(size);
      expect(hex(openPadded(secret, blob, APPLICATION_INFO, INBOX))).toBe(bytesToHex(plaintext));
    }
  });

  it('carry at most 65,460 bytes: the largest blob less the box and the length (#425)', () => {
    expect(MAX_PADDED_PLAINTEXT).toBe(65_460);
    expect(MAX_PADDED_PLAINTEXT).toBe(Math.max(...BLOB_SIZES) - BOX_OVERHEAD - 4);
    const blob = sealPadded(
      publicKey,
      new Uint8Array(MAX_PADDED_PLAINTEXT),
      APPLICATION_INFO,
      INBOX,
    );
    expect(blob).toHaveLength(65536);
  });

  it('refuse a plaintext too large for the largest blob', () => {
    const plaintext = new Uint8Array(65536 - BOX_OVERHEAD - 3);
    expect(() => sealPadded(publicKey, plaintext, APPLICATION_INFO, INBOX)).toThrow(
      PayloadTooLarge,
    );
  });

  it('never open at another size, with a padding byte set, or with its length past the body', () => {
    const plain = new TextEncoder().encode('Kim');
    const blob = sealPadded(publicKey, plain, APPLICATION_INFO, INBOX);
    expect(openPadded(secret, blob.subarray(0, 1000), APPLICATION_INFO, INBOX)).toBeNull();
    const aad = new TextEncoder().encode(INBOX);
    const body = new Uint8Array(1024 - BOX_OVERHEAD);
    body.set([0, 0, 0, 3, 75, 105, 109, 1]);
    const dirty = sealTo(publicKey, body, APPLICATION_INFO, aad);
    expect(dirty).toHaveLength(1024);
    expect(openPadded(secret, dirty, APPLICATION_INFO, INBOX)).toBeNull();
    const long = new Uint8Array(1024 - BOX_OVERHEAD);
    long.set([0, 0, 255, 255]);
    expect(
      openPadded(secret, sealTo(publicKey, long, APPLICATION_INFO, aad), APPLICATION_INFO, INBOX),
    ).toBeNull();
    const clean = new Uint8Array(1024 - BOX_OVERHEAD);
    clean.set([0, 0, 0, 3, 75, 105, 109]);
    const opened = openPadded(
      secret,
      sealTo(publicKey, clean, APPLICATION_INFO, aad),
      APPLICATION_INFO,
      INBOX,
    );
    expect(new TextDecoder().decode(opened ?? new Uint8Array())).toBe('Kim');
  });

  it('round-trip any plaintext, and never open under another key, info or mailbox (fast-check)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 3000 }), (plaintext) => {
        const blob = sealPadded(publicKey, plaintext, REPLY_INFO, INBOX);
        expect(BLOB_SIZES).toContain(blob.length);
        expect(hex(openPadded(secret, blob, REPLY_INFO, INBOX))).toBe(bytesToHex(plaintext));
        expect(openPadded(secret, blob, APPLICATION_INFO, INBOX)).toBeNull();
        expect(openBox(secret, blob, REPLY_INFO, new Uint8Array())).toBeNull();
      }),
      { numRuns: 25 },
    );
  });
});
