/**
 * The refusal rule on its own (#224): which `unwrap-failed` and `key-taken`
 * count against a key change. vectors/epoch-*.json pin it through the fold;
 * these pin each condition, and a property pins that the rule depends on
 * nothing but whether a recipient said so in each mailbox.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authorOf, signedAs, testKx } from '../test/keys';
import { groupLog, type LogBuilder } from '../test/votes';
import { parseRecord } from './event';
import type { EventDraft } from './event';
import { fold, type LogRecord } from './fold';
import {
  type CheckedRotation,
  isRefused,
  type KeyCheck,
  keyChecksOf,
  NO_KEY_CHECKS,
} from './keyChecks';

const ROTATION: CheckedRotation = {
  id: 'r',
  seq: 10,
  group: 'g',
  from: 2,
  to: 5,
  wraps: { ana: 'AA', ben: 'AA' },
  ousted: [],
};

/** Checks with `failed` and `taken` naming {@link ROTATION}. */
function checks(failed: readonly KeyCheck[], taken: readonly KeyCheck[] = []) {
  return { failed: new Map([['r', failed]]), taken: new Map([['r', taken]]) };
}

const FAILED: KeyCheck = { seq: 11, epoch: 2, author: 'ana', group: 'g' };
const TAKEN: KeyCheck = { seq: 12, epoch: 5, author: 'ben', group: 'g' };

describe('isRefused', () => {
  it('refuses a key change a recipient’s unwrap-failed names, from the mailbox it leaves', () => {
    expect(isRefused(checks([FAILED]), ROTATION)).toBe(true);
    expect(isRefused(NO_KEY_CHECKS, ROTATION)).toBe(false);
  });

  it('counts only an unwrap-failed after it, from a recipient, in its group, read from the old mailbox', () => {
    expect(isRefused(checks([{ ...FAILED, seq: 10 }]), ROTATION)).toBe(false);
    expect(isRefused(checks([{ ...FAILED, seq: 9 }]), ROTATION)).toBe(false);
    expect(isRefused(checks([{ ...FAILED, author: 'cal' }]), ROTATION)).toBe(false);
    expect(isRefused(checks([{ ...FAILED, group: 'h' }]), ROTATION)).toBe(false);
    expect(isRefused(checks([{ ...FAILED, epoch: 5 }]), ROTATION)).toBe(false);
    expect(isRefused(checks([{ ...FAILED, epoch: 1 }]), ROTATION)).toBe(false);
    // Any one that counts is enough.
    expect(isRefused(checks([{ ...FAILED, author: 'cal' }, FAILED]), ROTATION)).toBe(true);
  });

  it('keeps it when a recipient’s key-taken names it, read from the mailbox it moves to', () => {
    expect(isRefused(checks([FAILED], [TAKEN]), ROTATION)).toBe(false);
    expect(isRefused(checks([FAILED], [{ ...TAKEN, epoch: 2 }]), ROTATION)).toBe(true);
    expect(isRefused(checks([FAILED], [{ ...TAKEN, author: 'cal' }]), ROTATION)).toBe(true);
    expect(isRefused(checks([FAILED], [{ ...TAKEN, group: 'h' }]), ROTATION)).toBe(true);
    expect(isRefused(checks([FAILED], [{ ...TAKEN, seq: 10 }]), ROTATION)).toBe(true);
  });

  it('reads only the checks naming it', () => {
    const elsewhere = { failed: new Map([['s', [FAILED]]]), taken: new Map() };
    expect(isRefused(elsewhere, ROTATION)).toBe(false);
  });

  it('counts nothing from a recipient a removal had passed against by its place (#372)', () => {
    const ousted = { ...ROTATION, ousted: ['ana'] };
    expect(isRefused(checks([FAILED]), ousted)).toBe(false);
    expect(isRefused(checks([FAILED, { ...FAILED, author: 'ben' }]), ousted)).toBe(true);
    expect(
      isRefused(checks([{ ...FAILED, author: 'ben' }], [{ ...TAKEN, author: 'ana' }]), ousted),
    ).toBe(true);
    expect(isRefused(checks([{ ...FAILED, author: 'ben' }], [TAKEN]), ousted)).toBe(false);
  });

  it('never takes a wrap key that only an object’s prototype has for a recipient', () => {
    expect(isRefused(checks([{ ...FAILED, author: 'toString' }]), ROTATION)).toBe(false);
  });
});

/** A record of `draft` signed by `name` at `seq`, read from `epoch`'s mailbox. */
function record(name: string, draft: EventDraft, seq: number, epoch = 0): LogRecord {
  const { record: bytes } = signedAs(name, draft);
  return { seq, received: 29_000_000 + seq, bytes, ...(epoch === 0 ? {} : { epoch }) };
}

describe('keyChecksOf', () => {
  const at = (draft: EventDraft, seq: number, epoch = 0) => {
    const read = record('ana', draft, seq, epoch);
    return { seq, epoch, parsed: parseRecord(read.bytes) };
  };
  const body = { rotation: 'r' };

  it('lists each unwrap-failed and key-taken under the key change it names, in relay order', () => {
    const reads = [
      at({ type: 'unwrap-failed', group: 'g', ts: 1, body }, 3),
      at({ type: 'key-taken', group: 'g', ts: 1, body }, 4, 1),
      at({ type: 'unwrap-failed', group: 'h', ts: 2, body }, 5),
      at({ type: 'leave', group: 'g', ts: 1, body: {} }, 6),
      { seq: 7, epoch: 0, parsed: null },
    ];
    const found = keyChecksOf(reads);
    const author = reads[0]?.parsed?.event.author;
    expect(found.failed.get('r')).toEqual([
      { seq: 3, epoch: 0, author, group: 'g' },
      { seq: 5, epoch: 0, author, group: 'h' },
    ]);
    expect(found.taken.get('r')).toEqual([{ seq: 4, epoch: 1, author, group: 'g' }]);
    expect([...found.failed.keys(), ...found.taken.keys()]).toEqual(['r', 'r']);
  });

  it('lists nothing of a version it doesn’t know', () => {
    const later = record('ana', { type: 'unwrap-failed', group: 'g', ts: 1, body }, 3);
    const parsed = parseRecord(later.bytes);
    if (parsed === null) throw new Error('a signed record');
    const v2 = { ...parsed, event: { ...parsed.event, v: 2 } };
    expect(keyChecksOf([{ seq: 3, epoch: 0, parsed: v2 }]).failed.size).toBe(0);
  });
});

describe('properties of a refusal (#224)', () => {
  /** Ana founds, Ben and Kim join with keys, Cal joins and leaves, Ana writes the key change at seq 5. */
  function base(): { records: LogRecord[]; group: string; rotation: string } {
    const genesis = signedAs('ana', {
      type: 'genesis',
      group: '',
      ts: 1,
      body: {
        name: 'G',
        founder: 'Ana',
        documents: [{ title: 'T', atoms: ['A.'] }],
        kx: testKx('ana').kx,
      },
    });
    const group = genesis.id;
    const join = (name: string, seq: number): LogRecord =>
      record(name, { type: 'join', group, ts: 1, body: { name, kx: testKx(name).kx } }, seq);
    const records = [
      { seq: 1, received: 29_000_001, bytes: genesis.record },
      join('ben', 2),
      join('kim', 3),
      record('kim', { type: 'leave', group, ts: 1, body: {} }, 4),
    ];
    const wraps = { [authorOf('ana')]: 'AA', [authorOf('ben')]: 'AA' };
    const body = { epoch: 1, commit: 'property-commit-of-the-key-changeAAAAAAAAAA', wraps };
    const rotate = signedAs('ana', { type: 'key-rotate', group, ts: 1, body });
    records.push({ seq: 5, received: 29_000_005, bytes: rotate.record });
    return { records, group, rotation: rotate.id };
  }

  /** Noise after the key change: checks from anyone, in either mailbox, naming it or not. */
  const noise = fc.array(
    fc.record({
      who: fc.constantFrom('ana', 'ben', 'kim', 'zed'),
      type: fc.constantFrom('unwrap-failed' as const, 'key-taken' as const),
      epoch: fc.constantFrom(0, 1),
      names: fc.boolean(),
    }),
    { maxLength: 6 },
  );

  /** `items` as records from seq 6 on, in order. */
  function after(
    log: ReturnType<typeof base>,
    items: readonly {
      who: string;
      type: 'unwrap-failed' | 'key-taken';
      epoch: number;
      names: boolean;
    }[],
  ): LogRecord[] {
    return items.map(({ who, type, epoch, names }, i) =>
      record(
        who,
        { type, group: log.group, ts: i, body: { rotation: names ? log.rotation : 'other' } },
        6 + i,
        epoch,
      ),
    );
  }

  it('keeps a key change whenever a recipient’s key-taken from its new mailbox follows it, whatever else says otherwise', () => {
    fc.assert(
      fc.property(noise, fc.nat(), (items, slot) => {
        const log = base();
        const taken = { who: 'ben', type: 'key-taken' as const, epoch: 1, names: true };
        const at = slot % (items.length + 1);
        const placed = after(log, [...items.slice(0, at), taken, ...items.slice(at)]);
        const state = fold([...log.records, ...placed], null);
        expect([state.epoch, state.rotations.map((r) => r.id), state.refused]).toEqual([
          1,
          [log.rotation],
          [],
        ]);
      }),
    );
  });

  it('refuses a key change exactly when a recipient’s unwrap-failed from its old mailbox names it and no recipient’s key-taken from its new one does', () => {
    fc.assert(
      fc.property(noise, (items) => {
        const log = base();
        const state = fold([...log.records, ...after(log, items)], null);
        const counts = (type: string, epoch: number) =>
          items.some(
            (i) =>
              i.type === type && i.epoch === epoch && i.names && i.who !== 'kim' && i.who !== 'zed',
          );
        const refused = counts('unwrap-failed', 0) && !counts('key-taken', 1);
        expect(state.refused.map((r) => r.id)).toEqual(refused ? [log.rotation] : []);
        expect(state.epoch).toBe(refused ? 0 : 1);
        expect(state.rotationDue).toBe(refused);
      }),
    );
  });
});

describe('an ousted recipient’s checks (#372)', () => {
  /**
   * Ana, Ben, Cal and Kim, all with keys. Their removal of Kim passes, so
   * nothing else of Kim's counts (#115), but no `remove` has landed yet, so
   * Kim is still a member when Cal leaves, and Ana's key change wraps to Kim
   * too.
   */
  function afterOusting(): { log: LogBuilder; rotation: string } {
    const log = groupLog({ members: ['Ben', 'Cal', 'Kim'], kx: true });
    const removal = log.proposeRemoval('Ana', 'Kim');
    for (const voter of ['Ana', 'Ben', 'Cal']) log.vote(voter, removal, 4);
    log.minute += 1;
    log.leave('Cal');
    const rotation = log.rotate('Ana');
    return { log, rotation };
  }

  /** Which key changes the fold kept and which it refused. */
  function outcome(log: LogBuilder) {
    const state = log.state();
    return { rotations: state.rotations.map((r) => r.id), refused: state.refused.map((r) => r.id) };
  }

  it('keeps a key change whose only unwrap-failed comes from a recipient a removal has passed against', () => {
    const { log, rotation } = afterOusting();
    const before = log.state();
    expect(before.removals.map((r) => r.member)).toEqual([authorOf('kim')]);
    expect(Object.keys(before.rotations[0]?.wraps ?? {})).toContain(authorOf('kim'));
    log.keyCheck('Kim', 'unwrap-failed', rotation, 0);
    expect(outcome(log)).toEqual({ rotations: [rotation], refused: [] });
  });

  it('still refuses one a recipient still in good standing says doesn’t open', () => {
    const { log, rotation } = afterOusting();
    log.keyCheck('Ben', 'unwrap-failed', rotation, 0);
    expect(outcome(log)).toEqual({ rotations: [], refused: [rotation] });
  });

  it('never keeps one on the ousted recipient’s key-taken', () => {
    const { log, rotation } = afterOusting();
    log.keyCheck('Ben', 'unwrap-failed', rotation, 0);
    log.keyCheck('Kim', 'key-taken', rotation, 1);
    expect(outcome(log)).toEqual({ rotations: [], refused: [rotation] });
    log.keyCheck('Ana', 'key-taken', rotation, 1);
    expect(outcome(log)).toEqual({ rotations: [rotation], refused: [] });
  });
});
