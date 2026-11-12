/**
 * What a device decides about its group's key (#98), apart from the relay:
 * when the outbox freezes, who takes the duty, when to post `kx`, which
 * secrets fit an epoch, and what group home says once the key moved on.
 * sync.test.ts runs them through the loop; these pin each rule on its own.
 */
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { BOX_OVERHEAD } from '../crypto/box';
import { epochCommit, newEpochSecret, wrapEpochSecret } from '../crypto/epoch';
import { newGroupSecret } from '../crypto/groupKeys';
import { type EventDraft, parseRecord } from '../engine/event';
import { fold, type GroupState, keyHolders, type LogRecord } from '../engine/fold';
import { utf8 } from '../test/bytes';
import { authorOf, signedAs, testKeys, testKx } from '../test/keys';
import { groupLog } from '../test/votes';
import type { Group } from './db';
import {
  adoptionFor,
  epochOf,
  hasDuty,
  isFrozen,
  keyChangeOf,
  keyRotateRecord,
  keyStepFor,
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
    const documents = [{ title: 'T', atoms }];
    const body = { name: 'G', founder: 'ana', documents, kx: testKx('ana').kx };
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
function device(
  name: string,
  log: { readonly group: string; readonly records: readonly LogRecord[] },
  extra: Partial<Group> = {},
): Group {
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

/** The move `keyStepFor` finds for `group` after `records`, or null for anything else. */
function advanceFor(group: Group, records: readonly LogRecord[], relayNow: number) {
  const step = keyStepFor(group, records, relayNow, TS);
  return step?.kind === 'move' ? step.advance : null;
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

  it('lets only a key-rotate, a leave, an unwrap-failed or a key-taken through (#224)', () => {
    const log = afterLeave();
    const rotate = keyRotateRecord(device('ana', log), log.state(), TS);
    const leave = signedAs('ben', { type: 'leave', group: log.group, ts: TS, body: {} }).record;
    const level = signedAs('ben', {
      type: 'level',
      group: log.group,
      ts: TS,
      body: { level: 'x' },
    });
    const body = { rotation: 'r' };
    const failed = signedAs('ben', { type: 'unwrap-failed', group: log.group, ts: TS, body });
    const taken = signedAs('ben', { type: 'key-taken', group: log.group, ts: TS, body });
    expect(
      [rotate, leave, failed.record, taken.record, level.record, utf8('not a record')].map(
        passesFreeze,
      ),
    ).toEqual([true, true, true, true, false, false]);
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

  it('never falls to a member a removal has passed against, though no remove has landed yet (#372)', () => {
    const log = groupLog({ members: ['Ben', 'Cal', 'Kim'] });
    const removal = log.proposeRemoval('Ana', 'Kim');
    for (const voter of ['Ana', 'Ben', 'Cal']) log.vote(voter, removal, 4);
    log.minute += 1;
    log.leave('Cal');
    const state = log.state();
    expect([state.rotationDue, state.removals.map((r) => r.member)]).toEqual([
      true,
      [authorOf('kim')],
    ]);
    expect(hasDuty(device('ben', log), state)).toBe(true);
    expect(hasDuty(device('kim', log), state)).toBe(false);
  });

  it('never falls to a read-only archive, even with a key change due (#108)', () => {
    // #115 archives a removed member's copy with no dissolve in its log, so the fold can still hold one due.
    const log = afterLeave();
    const archived = device('ben', log, { archived: { reason: 'dissolved' } });
    expect(log.state().rotationDue).toBe(true);
    expect(hasDuty(archived, log.state())).toBe(false);
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

  it('is never needed for a read-only archive, which takes nothing new (#108)', () => {
    const log = Log.founded();
    log.add('ben', { type: 'join', body: { name: 'ben' } });
    const ben = withoutKx(device('ben', log));
    expect(needsKx(ben, log.state())).toBe(true);
    expect(needsKx({ ...ben, archived: { reason: 'dissolved' } }, log.state())).toBe(false);
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

/** Each current key holder's wrap: garbage for each named in `poisoned`, the rule's for the rest. */
function wrapsOf(
  state: GroupState,
  epoch: number,
  secret: Uint8Array,
  poisoned: readonly string[],
) {
  const groupId = state.group ?? '';
  const commit = epochCommit(groupId, epoch, secret);
  const garbage = (): string => base64url(new Uint8Array(BOX_OVERHEAD + 32).fill(7));
  const wraps = Object.fromEntries(
    keyHolders(state).map(({ author, kx }) => [
      author,
      poisoned.includes(author)
        ? garbage()
        : wrapEpochSecret({
            groupId,
            epoch,
            member: author,
            commit,
            kx: fromBase64url(kx),
            secret,
          }),
    ]),
  );
  return { commit, wraps };
}

/** `log` with `name`'s key change into the fold's next epoch, wrapped to everyone but poisoned for `poisoned`. */
function poisonedBy(log: Log, name: string, poisoned: readonly string[]): string {
  const state = log.state();
  const epoch = state.nextEpoch;
  const { commit, wraps } = wrapsOf(state, epoch, newEpochSecret(), poisoned);
  const record = log.add(name, { type: 'key-rotate', body: { epoch, commit, wraps } });
  return parseRecord(record)?.id ?? '';
}

/** Ana, Ben, Cal and Zed; Cal leaves, and Zed writes a key change whose wraps for `poisoned` don't open. */
function poisonedLog(poisoned: readonly string[]): { log: Log; rotation: string } {
  const log = Log.founded('ben', 'cal', 'zed');
  log.add('cal', { type: 'leave', body: {} });
  const rotation = poisonedBy(log, 'zed', poisoned);
  return { log, rotation };
}

/** The `unwrap-failed` or `key-taken` in `bytes`, by its author and the key change it names. */
function checkIn(bytes: Uint8Array | undefined) {
  const event = bytes === undefined ? undefined : parseRecord(bytes)?.event;
  if (event?.type !== 'unwrap-failed' && event?.type !== 'key-taken') return null;
  return {
    type: event.type,
    author: event.author,
    group: event.group,
    rotation: event.body.rotation,
  };
}

describe('a key change that doesn’t open (#224)', () => {
  const everyone = [authorOf('ana'), authorOf('ben'), authorOf('zed')];

  it('makes a device whose wrap doesn’t open say so, once, naming the key change', () => {
    const { log, rotation } = poisonedLog(everyone);
    const before = device('ben', log);
    const step = keyStepFor(before, [], R + 100, TS);
    expect(step?.kind).toBe('refuse');
    const record = step?.kind === 'refuse' ? step.record : undefined;
    expect(checkIn(record)).toEqual({
      type: 'unwrap-failed',
      author: authorOf('ben'),
      group: log.group,
      rotation,
    });
    expect(parseRecord(record ?? new Uint8Array())?.event.ts).toBe(TS);
    // Once it is queued it isn't said again; once it is in the log the fold refuses the key change.
    expect(
      keyStepFor({ ...before, outbox: [record ?? new Uint8Array()] }, [], R + 100, TS),
    ).toBeNull();
    const said = {
      seq: log.records.length + 1,
      received: R + 100,
      bytes: record ?? new Uint8Array(),
    };
    expect(keyStepFor(device('ben', log), [said], R + 100, TS)).toBeNull();
    const refusedNow = fold([...log.records, said], null);
    expect(refusedNow.refused.map((r) => r.id)).toEqual([rotation]);
  });

  it('makes a device whose own wrap opens say so too when anyone else’s isn’t the secret’s', () => {
    const { log, rotation } = poisonedLog([authorOf('ben')]);
    const step = keyStepFor(device('ana', log), [], R + 100, TS);
    expect(step?.kind === 'refuse' ? checkIn(step.record) : step).toEqual({
      type: 'unwrap-failed',
      author: authorOf('ana'),
      group: log.group,
      rotation,
    });
    expect(keyStepFor(device('ben', log), [], R + 100, TS)?.kind).toBe('refuse');
  });

  it('says nothing from a device that can’t judge: its key isn’t the group’s for it, or it has no wrap', () => {
    const { log } = poisonedLog(everyone);
    const otherKey = device('ben', log, { kxKey: testKx('kim').kxKey });
    expect(keyStepFor(otherKey, [], R + 100, TS)).toBeNull();
    expect(keyStepFor(withoutKx(device('ben', log)), [], R + 100, TS)).toBeNull();
    expect(keyStepFor(device('cal', log), [], R + 100, TS)).toBeNull();
  });

  it('takes up a key change every wrap of which is the secret’s, with nothing more to post', () => {
    const log = afterRotation();
    const step = keyStepFor(device('ben', afterLeave()), log.records.slice(-1), R + 100, TS);
    expect(step?.kind === 'move' ? [step.advance.epoch, step.advance.repost] : step).toEqual([
      1,
      [],
    ]);
  });

  it('takes up a refused key change that checks out here, and posts a key-taken naming it first', () => {
    const log = afterRotation();
    const state = log.state();
    const rotation = state.rotations[0]?.id ?? '';
    // Cal, who left, can't refuse it; Ben's word does, though his wrap opens.
    log.add('ben', { type: 'unwrap-failed', body: { rotation } });
    expect(log.state().refused.map((r) => r.id)).toEqual([rotation]);
    const late = log.add('ana', { type: 'level', body: { level: 'x' } });
    const step = keyStepFor(device('ana', log), [], R + 100, TS);
    if (step?.kind !== 'move') throw new Error('a move');
    expect(step.advance.epoch).toBe(1);
    expect(step.advance.cursor).toBe(state.rotations[0]?.seq);
    const [first, ...rest] = step.advance.repost;
    expect(checkIn(first)).toEqual({
      type: 'key-taken',
      author: authorOf('ana'),
      group: log.group,
      rotation,
    });
    expect(rest).toEqual([late]);
  });

  it('passes over a refused key change it can’t take up, to the one after it', () => {
    const { log, rotation } = poisonedLog(everyone);
    log.add('ben', { type: 'unwrap-failed', body: { rotation } });
    const refused = log.state();
    expect([refused.epoch, refused.nextEpoch, refused.rotationDue]).toEqual([0, 2, true]);
    const record = keyRotateRecord(device('ana', log), refused, TS);
    log.records.push({ seq: log.records.length + 1, received: R + 99, bytes: record });
    const step = keyStepFor(device('ben', log), [], R + 100, TS);
    expect(step?.kind === 'move' ? step.advance.epoch : step).toBe(2);
    expect(log.state().rotations.map((r) => r.epoch)).toEqual([2]);
  });

  it('never posts again a key check of its own that reached the old mailbox after the key change it takes up', () => {
    const { log, rotation } = poisonedLog(everyone);
    log.add('ana', { type: 'unwrap-failed', body: { rotation } });
    const record = keyRotateRecord(device('ana', log), log.state(), TS);
    log.records.push({ seq: log.records.length + 1, received: R + 99, bytes: record });
    // Ben's word, and a stray key-taken of his, land in the old mailbox after the fresh key change.
    log.add('ben', { type: 'unwrap-failed', body: { rotation } });
    log.add('ben', { type: 'key-taken', body: { rotation } });
    const late = log.add('ben', { type: 'level', body: { level: 'x' } });
    const step = keyStepFor(device('ben', log), [], R + 100, TS);
    expect(step?.kind === 'move' ? [step.advance.epoch, step.advance.repost] : step).toEqual([
      2,
      [late],
    ]);
  });

  it('gives the duty to no one whose key change was refused, and the next one names the epoch past it', () => {
    const { log, rotation } = poisonedLog(everyone);
    log.add('ana', { type: 'unwrap-failed', body: { rotation } });
    const state = log.state();
    expect(hasDuty(device('zed', log), state)).toBe(false);
    expect(hasDuty(device('ben', log), state)).toBe(true);
    const record = keyRotateRecord(device('ben', log), state, TS);
    const event = parseRecord(record)?.event;
    expect(event?.type === 'key-rotate' ? event.body.epoch : null).toBe(2);
  });

  it('adopts an invite’s secret only for a key change every wrap of which is that secret’s', () => {
    const log = Log.founded('ben', 'cal', 'zed');
    log.add('cal', { type: 'leave', body: {} });
    const state = log.state();
    const secret = newEpochSecret();
    const { commit, wraps } = wrapsOf(state, 1, secret, [authorOf('ben')]);
    log.add('zed', { type: 'key-rotate', body: { epoch: 1, commit, wraps } });
    // The commit fits, but Ben's wrap isn't the secret's: an invite from Zed doesn't move anyone.
    expect(secretFits(log.state(), 1, secret)).toBe(true);
    expect(adoptionFor(device('dee', log), 1, secret)).toBeNull();
  });
});

describe('a leave stranded in the old mailbox (#225)', () => {
  /**
   * Ana, Ben, Cal and Dee; Cal leaves and Ana writes the key change; then Dee,
   * who hadn't heard, leaves into the old mailbox after it, twice over, and
   * a level change of Ben's lands there too.
   */
  function strandedLog() {
    const log = Log.founded('ben', 'cal', 'dee');
    log.add('cal', { type: 'leave', body: {} });
    const rotate = keyRotateRecord(device('ana', log), log.state(), TS);
    log.records.push({ seq: log.records.length + 1, received: R + 99, bytes: rotate });
    const late = log.add('ben', { type: 'level', body: { level: 'x' } });
    const leave = log.add('dee', { type: 'leave', body: {} });
    log.records.push({ seq: log.records.length + 1, received: R + 99, bytes: leave });
    return { log, late, leave };
  }

  it('posts it again when it moves, whoever left, once, after its own late records', () => {
    const { log, late, leave } = strandedLog();
    expect(log.state().strandedLeaves.map((stranded) => stranded.author)).toEqual([
      authorOf('dee'),
    ]);
    const step = keyStepFor(device('ben', log), [], R + 100, TS);
    expect(step?.kind === 'move' ? [step.advance.epoch, step.advance.repost] : step).toEqual([
      1,
      [late, leave],
    ]);
  });

  it('posts it again when an invite moves the device, too', () => {
    const { log, late, leave } = strandedLog();
    const advance = advanceFor(device('ben', log), [], R + 100);
    const adoption = adoptionFor(device('ben', log), 1, advance?.secret ?? new Uint8Array());
    expect(adoption?.repost).toEqual([late, leave]);
  });

  it('posts a leaving member’s own leave once, though it is both late and stranded', () => {
    const { log, leave } = strandedLog();
    const dee = device('dee', log, { leaving: leave });
    const step = keyStepFor(dee, [], R + 100, TS);
    expect(step?.kind === 'move' ? step.advance.repost : step).toEqual([leave]);
  });
});
