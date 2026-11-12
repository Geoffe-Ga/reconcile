/**
 * A coalition room's keys (#125): `engine/vectors/room-keys.json`, computed
 * outside @noble, pins its weekly mailbox ids, seal key and entry id, all from
 * the coalition's `inner`, and one message sealed for it, which the coalition
 * secret's own keys, all a follower holds (#124), never open. `vectors/room-wrap.json`
 * pins how a group admitted later receives `inner` through its seat (#313).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from './base64url';
import { BOX_OVERHEAD, kxPublicKeyOf, sealTo } from './box';
import { deriveCoalitionEntryId } from './card';
import { deriveSealKey, deriveWeekMailboxId, MAILBOX_WEEK_INFO, SEAL_KEY_INFO } from './groupKeys';
import {
  deriveRoomEntryId,
  ROOM_ENTRY_INFO,
  ROOM_WRAP_INFO,
  roomWrapAad,
  SEAT_KX_INFO,
  seatKxKeyOf,
  seatKxOf,
  unwrapInner,
  wrapInner,
} from './room';
import { xchachaSeal } from './seal';
import { publicKeyOf } from './sign';
import { parseRecord } from '../engine/event';

/** One vector of room-keys.json. */
interface RoomKeys {
  readonly name: string;
  readonly inner: readonly number[];
  readonly coalitionSecret: readonly number[];
  readonly weekMailboxIds: readonly { readonly week: number; readonly id: readonly number[] }[];
  readonly sealKey: readonly number[];
  readonly roomEntryId: readonly number[];
  readonly coalitionWeekMailboxIds: readonly {
    readonly week: number;
    readonly id: readonly number[];
  }[];
  readonly coalitionSealKey: readonly number[];
  readonly message: {
    readonly week: number;
    readonly signerSeed: readonly number[];
    readonly text: string;
    readonly record: readonly number[];
    readonly blob: readonly number[];
  };
}

/** `engine/vectors/room-keys.json`. */
interface RoomKeysFile {
  readonly kind: 'room-keys';
  readonly infos: Readonly<Record<'weekMailboxId' | 'sealKey' | 'roomEntryId', string>>;
  readonly vectors: readonly RoomKeys[];
}

const [file] = Object.values(
  import.meta.glob<RoomKeysFile>('../engine/vectors/room-keys.json', {
    import: 'default',
    eager: true,
  }),
);
if (file === undefined) throw new Error('engine/vectors/room-keys.json is missing.');

const bytes = (list: readonly number[]) => Uint8Array.from(list);
const id = (list: readonly number[]) => base64url(bytes(list));

describe('room-keys.json', () => {
  it('names the labels the derivations use: a group’s, and the room entry’s own', () => {
    expect(file.kind).toBe('room-keys');
    expect(file.infos).toEqual({
      weekMailboxId: MAILBOX_WEEK_INFO,
      sealKey: SEAL_KEY_INFO,
      roomEntryId: ROOM_ENTRY_INFO,
    });
    expect(ROOM_ENTRY_INFO).toBe('reconcile/v1/room-entry');
  });

  it.each(file.vectors.map((vector) => [vector.name, vector] as const))(
    'pins the room’s mailboxes, seal key and entry id for %s',
    (_name, vector) => {
      const inner = bytes(vector.inner);
      for (const { week, id: expected } of vector.weekMailboxIds) {
        expect(deriveWeekMailboxId(inner, week)).toBe(id(expected));
      }
      expect(deriveSealKey(inner)).toEqual(bytes(vector.sealKey));
      expect(deriveRoomEntryId(inner)).toBe(id(vector.roomEntryId));
      const secret = bytes(vector.coalitionSecret);
      for (const { week, id: expected } of vector.coalitionWeekMailboxIds) {
        expect(deriveWeekMailboxId(secret, week)).toBe(id(expected));
      }
      expect(deriveSealKey(secret)).toEqual(bytes(vector.coalitionSealKey));
    },
  );

  it.each(file.vectors.map((vector) => [vector.name, vector] as const))(
    'opens the message sealed outside @noble with the keys from inner, and never with the coalition secret’s, for %s',
    (_name, vector) => {
      const { message } = vector;
      const inner = bytes(vector.inner);
      const secret = bytes(vector.coalitionSecret);
      const blob = bytes(message.blob);
      const mailbox = deriveWeekMailboxId(inner, message.week);
      expect(blob).toHaveLength(1024);
      expect(xchachaSeal.open(mailbox, deriveSealKey(inner), blob)).toEqual(bytes(message.record));
      const event = parseRecord(bytes(message.record))?.event;
      expect(event).toMatchObject({
        v: 1,
        type: 'message',
        author: base64url(publicKeyOf(bytes(message.signerSeed))),
        body: { text: message.text },
      });
      // A follower holds the coalition secret: its keys and mailbox open nothing of the room's.
      const theirs = deriveWeekMailboxId(secret, message.week);
      expect(xchachaSeal.open(mailbox, deriveSealKey(secret), blob)).toBeNull();
      expect(xchachaSeal.open(theirs, deriveSealKey(secret), blob)).toBeNull();
      expect(xchachaSeal.open(theirs, deriveSealKey(inner), blob)).toBeNull();
      expect(theirs).not.toBe(mailbox);
    },
  );
});

describe('deriveRoomEntryId', () => {
  it('is 43 base64url characters, and names no mailbox of the inner or the coalition', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (inner) => {
        const entry = deriveRoomEntryId(inner);
        expect(entry).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(entry).not.toBe(deriveWeekMailboxId(inner, 0));
        expect(entry).not.toBe(deriveCoalitionEntryId(inner));
        expect(entry).not.toBe(base64url(deriveSealKey(inner)));
      }),
    );
  });

  it('refuses an inner that isn’t 32 bytes', () => {
    expect(() => deriveRoomEntryId(new Uint8Array(31))).toThrow(RangeError);
    expect(() => deriveRoomEntryId(new Uint8Array(33))).toThrow('32 bytes');
  });
});

/** `vectors/room-wrap.json` (#313): seat keys and wraps made outside @noble. Each key is its bytes. */
interface RoomWrapFile {
  readonly kind: 'room-wrap';
  readonly infos: Readonly<Record<'seatKx' | 'wrap', string>>;
  readonly vectors: readonly {
    readonly name: string;
    readonly seatSecret: readonly number[];
    readonly seatKey: readonly number[];
    readonly kxSecret: readonly number[];
    readonly kxPublic: readonly number[];
    readonly coalitionId: string;
    readonly inner: readonly number[];
    readonly aad: readonly number[];
    readonly wrap: readonly number[];
  }[];
}

const [wraps] = Object.values(
  import.meta.glob<RoomWrapFile>('./vectors/room-wrap.json', { import: 'default', eager: true }),
);
if (wraps === undefined) throw new Error('vectors/room-wrap.json is missing.');

const wrapVectors = wraps.vectors.map((vector) => [vector.name, vector] as const);

describe('room-wrap.json', () => {
  it('names the labels: the seat’s encryption key’s, and the wrap’s', () => {
    expect(wraps.kind).toBe('room-wrap');
    expect(wraps.infos).toEqual({ seatKx: SEAT_KX_INFO, wrap: ROOM_WRAP_INFO });
    expect(SEAT_KX_INFO).toBe('reconcile/v1/seat-kx');
    expect(ROOM_WRAP_INFO).toBe('reconcile/v1/room-wrap');
  });

  it.each(wrapVectors)('derives the seat’s encryption key from its secret for %s', (_n, vector) => {
    const seatSecret = bytes(vector.seatSecret);
    expect(publicKeyOf(seatSecret)).toEqual(bytes(vector.seatKey));
    expect(seatKxKeyOf(seatSecret)).toEqual(bytes(vector.kxSecret));
    expect(seatKxOf(seatSecret)).toBe(id(vector.kxPublic));
  });

  it.each(wrapVectors)('opens the wrap sealed outside @noble to inner for %s', (_n, vector) => {
    const place = { coalitionId: vector.coalitionId, seat: id(vector.seatKey) };
    const seatSecret = bytes(vector.seatSecret);
    const wrap = id(vector.wrap);
    expect(unwrapInner({ ...place, seatSecret, wrap })).toEqual(bytes(vector.inner));
    expect(roomWrapAad(place)).toEqual(bytes(vector.aad));
  });
});

describe('wrapInner and unwrapInner', () => {
  const [, known] = wrapVectors[0] ?? [];
  if (known === undefined) throw new Error('vectors/room-wrap.json holds no vector.');
  const seatSecret = bytes(known.seatSecret);
  const place = { coalitionId: known.coalitionId, seat: id(known.seatKey) };
  const inner = bytes(known.inner);

  it('round-trips inner to the seat that holds the secret, under a fresh box each time', () => {
    const first = wrapInner({ ...place, kx: seatKxOf(seatSecret), inner });
    const second = wrapInner({ ...place, kx: seatKxOf(seatSecret), inner });
    expect(first).not.toBe(second);
    expect(fromBase64url(first)).toHaveLength(BOX_OVERHEAD + 32);
    expect(unwrapInner({ ...place, seatSecret, wrap: first })).toEqual(inner);
    expect(unwrapInner({ ...place, seatSecret, wrap: second })).toEqual(inner);
  });

  it('opens nothing for another seat, another coalition, another seat key or a changed byte', () => {
    const wrap = id(known.wrap);
    const other = new Uint8Array(32).fill(9);
    expect(unwrapInner({ ...place, seatSecret: other, wrap })).toBeNull();
    expect(
      unwrapInner({ ...place, coalitionId: `${known.coalitionId}x`, seatSecret, wrap }),
    ).toBeNull();
    expect(
      unwrapInner({ ...place, seat: base64url(publicKeyOf(other)), seatSecret, wrap }),
    ).toBeNull();
    const flipped = bytes(known.wrap);
    flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 1;
    expect(unwrapInner({ ...place, seatSecret, wrap: base64url(flipped) })).toBeNull();
  });

  it('opens nothing from a wrap that isn’t canonical base64url, or holds anything but 32 bytes', () => {
    const wrap = id(known.wrap);
    expect(unwrapInner({ ...place, seatSecret, wrap: `${wrap}=` })).toBeNull();
    expect(unwrapInner({ ...place, seatSecret, wrap: 'a' })).toBeNull();
    expect(unwrapInner({ ...place, seatSecret, wrap: '' })).toBeNull();
    const kx = fromBase64url(seatKxOf(seatSecret));
    const short = base64url(sealTo(kx, new Uint8Array(31), ROOM_WRAP_INFO, roomWrapAad(place)));
    expect(unwrapInner({ ...place, seatSecret, wrap: short })).toBeNull();
  });

  it('refuses a seat secret or an inner that isn’t 32 bytes, and a key no box can be sealed to', () => {
    expect(() => seatKxKeyOf(new Uint8Array(31))).toThrow('A seat secret is 32 bytes.');
    expect(() => seatKxOf(new Uint8Array(33))).toThrow(RangeError);
    const kx = seatKxOf(seatSecret);
    expect(() => wrapInner({ ...place, kx, inner: new Uint8Array(31) })).toThrow(
      'A room’s inner is 32 bytes.',
    );
    expect(() => wrapInner({ ...place, kx: base64url(new Uint8Array(32)), inner })).toThrow(
      RangeError,
    );
    expect(
      unwrapInner({ ...place, seatSecret: new Uint8Array(31), wrap: id(known.wrap) }),
    ).toBeNull();
  });

  it('gives each seat secret its own encryption key, apart from its signing key', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (secret) => {
        const kx = seatKxKeyOf(secret);
        expect(kx).not.toEqual(secret);
        expect(seatKxOf(secret)).not.toBe(base64url(publicKeyOf(secret)));
        expect(seatKxOf(secret)).toBe(base64url(kxPublicKeyOf(kx)));
      }),
    );
  });
});
