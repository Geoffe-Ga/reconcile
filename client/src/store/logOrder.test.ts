import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LogRecord } from '../engine/fold';
import { placedInLog } from './logOrder';

/** A record at `seq`, received at relay minute `received`, carrying its seq as its one byte. */
function at(seq: number, received: number): LogRecord {
  return { seq, received, bytes: Uint8Array.of(seq % 256) };
}

/** Each record's seq, in log order. */
const seqs = (log: readonly LogRecord[]): number[] => log.map((record) => record.seq);

/**
 * One relay's records in seq order, as the relay writes them: seqs grow, with
 * gaps where other mailboxes' records fell, and each arrived no earlier than
 * the one before.
 */
const oneRelay = fc
  .array(fc.tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 })), {
    minLength: 1,
    maxLength: 40,
  })
  .map((steps) => {
    let seq = 0;
    let received = 29_000_000;
    return steps.map(([gap, wait]) => {
      seq += gap;
      received += wait;
      return at(seq, received);
    });
  });

/** `records` cut into consecutive passes by `cuts`, each pass then read in any order of weeks. */
function passes(records: readonly LogRecord[], cuts: readonly number[]): LogRecord[][] {
  const bounds = [...new Set(cuts.map((cut) => cut % (records.length + 1)))].sort((a, b) => a - b);
  const out: LogRecord[][] = [];
  let from = 0;
  for (const bound of [...bounds, records.length]) {
    out.push(records.slice(from, bound));
    from = bound;
  }
  return out;
}

describe('placedInLog: where records read from the relay go in a group’s log (#110)', () => {
  it('appends records that came after the whole log', () => {
    const log = [at(1, 10), at(4, 11)];

    expect(seqs(placedInLog(log, [at(6, 11), at(9, 12)]))).toEqual([1, 4, 6, 9]);
  });

  it('puts a record that reached last week’s mailbox as the week turned before the later records read first', () => {
    // Pass 1 read this week's 7 and 8; last week's 6 was posted just after it read last week.
    const log = [at(1, 10), at(4, 20), at(7, 30), at(8, 30)];

    expect(seqs(placedInLog(log, [at(6, 30), at(9, 31)]))).toEqual([1, 4, 6, 7, 8, 9]);
  });

  it('keeps a fresh relay’s records after the old one’s, though its seqs start again from 1', () => {
    const log = [at(1, 10), at(2, 11), at(3, 12)];

    expect(seqs(placedInLog(log, [at(1, 50), at(2, 51)]))).toEqual([1, 2, 3, 1, 2]);
    expect(placedInLog(log, [at(1, 50)]).map((record) => record.received)).toEqual([
      10, 11, 12, 50,
    ]);
  });

  it('leaves the log it is given as it was', () => {
    const log = [at(5, 10)];

    placedInLog(log, [at(2, 9)]);

    expect(seqs(log)).toEqual([5]);
  });

  it('ends in seq order however one relay’s records were split into passes, and holds each once', () => {
    fc.assert(
      fc.property(oneRelay, fc.array(fc.nat()), fc.array(fc.boolean()), (records, cuts, flips) => {
        let log: LogRecord[] = [];
        for (const [i, pass] of passes(records, cuts).entries()) {
          // A pass reads its weeks in either order: its records come in seq order or reversed.
          log = placedInLog(log, flips[i] === true ? [...pass].reverse() : pass);
        }

        expect(seqs(log)).toEqual(seqs(records));
      }),
    );
  });

  it('keeps a fresh relay’s records after every record of the one before, in their own seq order', () => {
    fc.assert(
      fc.property(oneRelay, oneRelay, (old, fresh) => {
        const last = Math.max(...old.map((record) => record.received));
        const moved = fresh.map((record) =>
          at(record.seq, record.received - 29_000_000 + last + 1),
        );

        const log = placedInLog(old, moved);

        expect(seqs(log)).toEqual([...seqs(old), ...seqs(moved)]);
      }),
    );
  });
});
