/**
 * A coalition's room (#125; ADR-0011, ADR-0009): the golden vectors in
 * vectors/room-*.json, which src/test/vectors.ts builds, and the properties
 * that a message's place and fate depend only on itself and the coalition.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Logs } from '../test/coalitions';
import { authorOf, signedAs } from '../test/keys';
import { buildLogs, resolve, ROOM_VECTORS } from '../test/vectors';
import { fold, type GroupState, type LogRecord } from './fold';
import {
  checkMessage,
  foldRoom,
  keptInRoom,
  MESSAGE_MAX,
  messageText,
  ROOM_KEEP_MINUTES,
  type RoomMessage,
} from './room';

const R = 29_375_000;

describe('room vectors', () => {
  it('include every case the issue names', () => {
    expect(ROOM_VECTORS.map((vector) => vector.name.split(':')[0])).toEqual([
      'two-seats',
      'thirty-days',
      'text',
      'left',
      'ignored',
      'names',
      'no-genesis',
    ]);
  });

  it.each(ROOM_VECTORS.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const { logs, ids } = buildLogs(vector);
    const coalition = fold(logs.coalition ?? [], vector.relayNow);
    const messages = foldRoom(logs.room ?? [], coalition, vector.relayNow);
    expect(messages).toMatchObject(resolve(vector.expect, ids) as object[]);
  });
});

describe('the room’s rules', () => {
  it('keeps a message 30 days of relay time: 43,200 minutes', () => {
    expect(ROOM_KEEP_MINUTES).toBe(43_200);
    expect(keptInRoom(R, R + 43_200)).toBe(true);
    expect(keptInRoom(R, R + 43_201)).toBe(false);
    expect(keptInRoom(R + 5, R)).toBe(true);
  });

  it('takes 1 to 2,000 code points after NFC and trimming', () => {
    expect(MESSAGE_MAX).toBe(2000);
    expect(messageText('  Café \n')).toBe('Café');
    expect(messageText(' \n\t ')).toBeNull();
    expect(messageText('')).toBeNull();
    expect(messageText('😀'.repeat(2000))).toBe('😀'.repeat(2000));
    expect(messageText('😀'.repeat(2001))).toBeNull();
    expect(messageText('é'.repeat(2000))).toBe('é'.repeat(2000));
  });

  it('says why the composer can’t send a message', () => {
    expect(checkMessage('Hello')).toBeNull();
    expect(checkMessage('  ')).toBe('empty');
    expect(checkMessage('a'.repeat(2001))).toBe('long');
    expect(checkMessage(` ${'a'.repeat(2000)} `)).toBeNull();
  });

  it('shows nothing with no relay minute, or for a group’s state', () => {
    const logs = new Logs();
    logs.formed(R, ['A', 'B'], ['kim', 'zed']);
    const room = roomRecords(logs, [{ who: 'kim', at: 10, text: 'Hi' }]);
    const coalition = fold(logs.logs.coalition ?? [], R + 100);
    expect(foldRoom(room, coalition, R + 100)).toHaveLength(1);
    expect(foldRoom(room, coalition, null)).toEqual([]);
    logs.group('A', R, ['ana', 'ben']);
    expect(foldRoom(room, fold(logs.logs.A ?? [], R + 100), R + 100)).toEqual([]);
  });
});

/** One message a fast-check case writes: who, how many minutes after the coalition formed, and what. */
interface Written {
  readonly who: string;
  readonly at: number;
  readonly text: string;
}

/** `written` as room records signed by each author, each at its own seq after the coalition's. */
function roomRecords(logs: Logs, written: readonly Written[]): LogRecord[] {
  logs.ids.room = logs.ids.coalition ?? '';
  for (const { who, at, text } of written) {
    logs.add('room', R + 100 + at, who, { type: 'message', body: { text } });
  }
  return logs.logs.room ?? [];
}

/** A formed coalition whose participants are kim (seat A) and zed (seat B); ana never took part. */
function formed(): { logs: Logs; coalition: GroupState } {
  const logs = new Logs();
  logs.formed(R, ['A', 'B'], ['kim', 'zed']);
  return { logs, coalition: fold(logs.logs.coalition ?? [], R + 50_000) };
}

/** Messages with distinct authors and texts, so no two sign to the same event. */
const written = fc.uniqueArray(
  fc.record({
    who: fc.constantFrom('kim', 'zed', 'ana'),
    at: fc.integer({ min: 0, max: 46_000 }),
    text: fc.constantFrom('Hi', 'Thursday?', '  ', 'Line\nbreak', 'x'.repeat(2001)),
  }),
  { maxLength: 8, selector: ({ who, text }) => `${who}/${text}` },
);

/** The messages' seqs. */
const seqs = (messages: readonly RoomMessage[]) => messages.map((m) => m.seq);

describe('room properties', () => {
  it('keeps messages in the order the log holds them, and only participants’', () => {
    fc.assert(
      fc.property(written, (list) => {
        const { logs, coalition } = formed();
        const room = roomRecords(logs, list);
        const shown = foldRoom(room, coalition, R + 50_000);
        const order = room.map((record) => record.seq);
        expect(seqs(shown)).toEqual(order.filter((seq) => seqs(shown).includes(seq)));
        const speakers = new Set([authorOf('kim'), authorOf('zed')]);
        expect(shown.every((m) => speakers.has(m.author))).toBe(true);
      }),
    );
  });

  it('decides each message by itself: a log with some records left out shows the rest as before', () => {
    fc.assert(
      fc.property(written, fc.array(fc.boolean(), { maxLength: 8 }), (list, keep) => {
        const { logs, coalition } = formed();
        const room = roomRecords(logs, list);
        const subset = room.filter((_, i) => keep[i] ?? true);
        const all = foldRoom(room, coalition, R + 50_000);
        const kept = new Set(subset.map((record) => record.seq));
        expect(foldRoom(subset, coalition, R + 50_000)).toEqual(all.filter((m) => kept.has(m.seq)));
      }),
    );
  });

  it('only ever drops a message as relay time moves on, and never brings one back', () => {
    fc.assert(
      fc.property(written, fc.nat(50_000), fc.nat(50_000), (list, a, b) => {
        const { logs, coalition } = formed();
        const room = roomRecords(logs, list);
        const [early, late] = [Math.min(a, b), Math.max(a, b)].map((n) => R + 100 + n);
        const before = new Set(seqs(foldRoom(room, coalition, early ?? R)));
        const after = foldRoom(room, coalition, late ?? R).filter(
          (m) => m.received <= (early ?? R),
        );
        expect(after.every((m) => before.has(m.seq))).toBe(true);
      }),
    );
  });

  it('never shows a message by a key that isn’t a participant’s, however it’s signed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ana', 'ben', 'eve'),
        fc.string({ minLength: 1 }),
        (who, text) => {
          const { logs, coalition } = formed();
          const id = logs.ids.coalition ?? '';
          const record = signedAs(who, {
            type: 'message',
            group: id,
            ts: 0,
            body: { text },
          }).record;
          const room = [{ seq: 99, received: R + 200, bytes: record }];
          expect(foldRoom(room, coalition, R + 50_000)).toEqual([]);
        },
      ),
    );
  });
});
