/**
 * What a device decides about its group's key (#98), apart from the relay:
 * when the outbox freezes, who takes the duty, when to post `kx`, which
 * secrets fit an epoch, and what group home says once the key moved on.
 * sync.test.ts runs them through the loop; these pin each rule on its own.
 */
import { describe, expect, it } from 'vitest';

import { newGroupSecret } from '../crypto/groupKeys';
import { type EventDraft } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { utf8 } from '../test/bytes';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import type { Group } from './db';
import {
  adoptionFor,
  advanceFor,
  epochOf,
  hasDuty,
  isFrozen,
  keyChangeOf,
  keyRotateRecord,
  needsKx,
  passesFreeze,
  secretFits,
} from './epochs';

const TS = 1_762_650_000_000;
const R = 29_000_000;

/** An event before the log stamps its group and time. */
type Unstamped<E = EventDraft> = E extends EventDraft ? Omit<E, 'group' | 'ts'> : never;

/** A relay-ordered log of signed events, one seq each, read from `epoch`'s mailbox when given. */
class Log {
  readonly records: LogRecord[] = [];
  group = '';

  add(name: string, draft: Unstamped, epoch = 0): Uint8Array {
    const { record, id } = signedAs(name, { ...draft, group: this.group, ts: TS });
    const seq = this.records.length + 1;
    this.records.push({ seq, received: R + seq, bytes: record, ...(epoch === 0 ? {} : { epoch }) });
    if (draft.type === 'genesis') this.group = id;
    return record;
  }

  /** Ana founds the group, and each of `joiners` joins, every one with an encryption key. */
  static founded(...joiners: string[]): Log {
    const log = new Log();
    const atoms = ['Quiet after 10pm.'];
    const body = { name: 'G', founder: 'ana', title: 'T', atoms, kx: testKx('ana').kx };
    log.add('ana', { type: 'genesis', body });
    for (const name of joiners)
      log.add(name, { type: 'join', body: { name, kx: testKx(name).kx } });
    return log;
  }

  state(): GroupState {
    return fold(this.records, null);
  }
}

/** `name`'s device holding `log`, at epoch `epoch`, with its keys. */
function device(name: string, log: Log, extra: Partial<Group> = {}): Group {
  return {
    groupId: log.group,
    secret: newGroupSecret(),
    signingKey: testKeys(name).secretKey,
    kxKey: testKx(name).kxKey,
    me: { author: authorOf(name), name },
    log: [...log.records],
    cursor: log.records.length,
    relayNow: null,
    instance: 'relay-1',
    outbox: [],
    lastSyncAt: TS,
    ...extra,
  };
}

/** `group` as a device kept it before #98: with no encryption key. */
function withoutKx(group: Group): Group {
  const copy = { ...group };
  delete copy.kxKey;
  return copy;
}

/** Ana, Ben and Cal, then Cal leaves: a key change is due. */
function afterLeave(): Log {
  const log = Log.founded('ben', 'cal');
  log.add('cal', { type: 'leave', body: {} });
  return log;
}

/** {@link afterLeave}, then Ana's device writes the key change. */
function afterRotation(): Log {
  const log = afterLeave();
  const record = keyRotateRecord(device('ana', log), log.state(), TS);
  log.records.push({ seq: log.records.length + 1, received: R + 99, bytes: record });
  return log;
}

describe('the freeze', () => {
  it('holds while a key change is due, or once the key moved past this device, and not otherwise', () => {
    expect(isFrozen(Log.founded('ben').state(), {})).toBe(false);
    expect(isFrozen(afterLeave().state(), {})).toBe(true);
    expect(isFrozen(afterRotation().state(), {})).toBe(true);
    expect(isFrozen(afterRotation().state(), { epoch: 1 })).toBe(false);
  });

  it('lets only a key-rotate or a leave through', () => {
    const log = afterLeave();
    const rotate = keyRotateRecord(device('ana', log), log.state(), TS);
    const leave = signedAs('ben', { type: 'leave', group: log.group, ts: TS, body: {} }).record;
    const level = signedAs('ben', {
      type: 'level',
      group: log.group,
      ts: TS,
      body: { level: 'x' },
    });
    expect([rotate, leave, level.record, utf8('not a record')].map(passesFreeze)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('the duty', () => {
  it('falls to a current member who holds the current key and isn’t leaving', () => {
    const log = afterLeave();
    const state = log.state();
    expect(hasDuty(device('ben', log), state)).toBe(true);
    expect(hasDuty(device('ben', log, { leaving: utf8('leave') }), state)).toBe(false);
    expect(hasDuty(device('cal', log), state)).toBe(false);
    expect(hasDuty(device('ben', Log.founded('ben')), Log.founded('ben').state())).toBe(false);
    const rotated = afterRotation();
    expect(hasDuty(device('ben', rotated), rotated.state())).toBe(false);
  });

  it('writes a key-rotate the fold takes: the next epoch, wrapped to the current key holders', () => {
    const state = afterRotation().state();
    expect(state.epoch).toBe(1);
    expect(Object.keys(state.rotations[0]?.wraps ?? {}).sort()).toEqual(
      [authorOf('ana'), authorOf('ben')].sort(),
    );
  });

  it('refuses a group with no genesis yet', () => {
    expect(() => keyRotateRecord(device('ana', new Log()), new Log().state(), TS)).toThrow(
      'A key change needs a founded group.',
    );
  });
});

describe('the switch', () => {
  it('opens this member’s wrap, and needs this device’s encryption key to', () => {
    const log = afterRotation();
    const advance = advanceFor(device('ben', afterLeave()), log.records.slice(-1), R + 100);
    expect(advance?.epoch).toBe(1);
    expect(secretFits(log.state(), 1, advance?.secret ?? new Uint8Array())).toBe(true);
    const keyless = withoutKx(device('ben', afterLeave()));
    expect(advanceFor(keyless, log.records.slice(-1), R + 100)).toBeNull();
    expect(advanceFor(device('cal', afterLeave()), log.records.slice(-1), R + 100)).toBeNull();
  });

  it('adopts an invite’s secret only when it is later than the device’s and fits its commit', () => {
    const log = afterRotation();
    const ben = device('ben', log);
    const advance = advanceFor(device('ben', afterLeave()), log.records.slice(-1), R + 100);
    const secret = advance?.secret ?? new Uint8Array();
    expect(adoptionFor(ben, 1, secret)).toMatchObject({ epoch: 1, cursor: log.records.length });
    expect(adoptionFor(ben, 1, newGroupSecret())).toBeNull();
    expect(adoptionFor(ben, 2, secret)).toBeNull();
    expect(adoptionFor({ ...ben, epoch: 1 }, 1, secret)).toBeNull();
    expect(epochOf({ epoch: 1 })).toBe(1);
  });
});

describe('secrets that fit an epoch', () => {
  it('takes any secret at epoch 0, and at a later epoch only the one its key change commits to', () => {
    const state = afterRotation().state();
    expect(secretFits(state, 0, newGroupSecret())).toBe(true);
    expect(secretFits(state, 1, newGroupSecret())).toBe(false);
    expect(secretFits(state, 1, new Uint8Array(31))).toBe(false);
    expect(secretFits(state, 2, newGroupSecret())).toBe(false);
  });
});

describe('kx from a store kept before #98', () => {
  it('is due for a current member with no encryption key, once, and never while leaving', () => {
    const log = Log.founded();
    log.add('ben', { type: 'join', body: { name: 'ben' } });
    const state = log.state();
    const ben = withoutKx(device('ben', log));
    expect(needsKx(ben, state)).toBe(true);
    expect(needsKx({ ...ben, leaving: utf8('leave') }, state)).toBe(false);
    const kx = signedAs('ben', {
      type: 'kx',
      group: log.group,
      ts: TS,
      body: { kx: testKx('ben').kx },
    });
    expect(needsKx({ ...ben, outbox: [kx.record] }, state)).toBe(false);
    expect(needsKx(device('ana', log), state)).toBe(false);
    expect(needsKx(device('cal', log), state)).toBe(false);
  });
});

describe('what group home says once the key moved on', () => {
  it('says left for a membership that left, missed for one with no wrap, and nothing while current', () => {
    const state = afterRotation().state();
    expect(keyChangeOf({ me: { author: authorOf('cal'), name: 'cal' } }, state)).toBe('left');
    expect(keyChangeOf({ me: { author: authorOf('dee'), name: 'dee' } }, state)).toBe('missed');
    expect(
      keyChangeOf({ me: { author: authorOf('ben'), name: 'ben' }, epoch: 1 }, state),
    ).toBeNull();
    expect(
      keyChangeOf({ me: { author: authorOf('cal'), name: 'cal' } }, afterLeave().state()),
    ).toBeNull();
  });
});
