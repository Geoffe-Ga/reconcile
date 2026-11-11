/**
 * A coalition room's keys (#125): `engine/vectors/room-keys.json`, computed
 * outside @noble, pins its weekly mailbox ids, seal key and entry id, all from
 * the coalition's `inner`, and one message sealed for it, which the coalition
 * secret's own keys, all a follower holds (#124), never open.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import { deriveCoalitionEntryId } from './card';
import { deriveSealKey, deriveWeekMailboxId, MAILBOX_WEEK_INFO, SEAL_KEY_INFO } from './groupKeys';
import { deriveRoomEntryId, ROOM_ENTRY_INFO } from './room';
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
