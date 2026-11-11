/**
 * Properties of the fold (fast-check): every device that folds the same relay
 * records builds the same state, the Document changes only on a final pass, a level change
 * or a leave never reaches back into a Proposal that's already open, a member who has left
 * acts no more, an Atom never has two open Proposals or a ballot more than three versions,
 * and adds and section removals (#75) only ever add or take out whole Atoms. And of the bars (#94):
 * the entrenched bar is never easier than the ordinary one, and neither depends on the order
 * ballots arrive in. And of windows (#106): a Proposal opens only for a window its class
 * allows, and runs exactly that long. And of epochs (#98): a record read from another epoch's
 * mailbox changes nothing, not even relay time. And of removal (#115): nothing the member a
 * removal names sends on it counts, they are taken out once whoever posts the remove, and after
 * the pass only their leave counts; removal's bar is never harder than the entrenched one and
 * never depends on ballot order. And of coalitions (#100): a motion's outcome doesn't depend on
 * the order distinct seats' results arrive in, and nothing a group reports carries a name, note,
 * score or key from inside it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs, seatOf } from '../test/coalitions';
import { authorOf, signedAs, testKx } from '../test/keys';
import { LEVELS } from './capabilities';
import { coalitionOutcome, RESULT_GRACE_MINUTES } from './coalition';
import { resultsToReport } from './crossing';
import { VERSIONS_MAX } from './composeOption';
import { type EventDraft, parseRecord, type Score } from './event';
import { fold, type LogRecord } from './fold';
import { type Bar, DAY_MINUTES, DEFAULT_RULES, defaultWindowMinutes, validWindow } from './rules';
import { tally, tallyDetail, type TallyInput } from './tally';

const R = 29_375_000;
const [FOLLOWING, , CREATING] = LEVELS;
/** How long before R the founded members join: past the 14-day wait, so they vote from R on (#101). */
const SETTLED = DEFAULT_RULES.waitDays * DAY_MINUTES + 100;
/** How long an ordinary vote runs when no one chooses, in relay minutes. */
const WINDOW = defaultWindowMinutes(DEFAULT_RULES, 'ordinary');
const encoder = new TextEncoder();

/** Member `i`'s test key name. Member 0 founds the group. */
function member(i: number): string {
  return `m${String(i)}`;
}

/** An event before the log stamps its group and time. */
type Unstamped<E = EventDraft> = E extends EventDraft ? Omit<E, 'group' | 'ts'> : never;

/** A score from 0 to 4. */
const score = fc.constantFrom<Score>(0, 1, 2, 3, 4);

/** Builds a relay-ordered log, one seq per event. */
class Log {
  readonly records: LogRecord[] = [];
  group = '';

  /** Appends `input`, signed by `author`'s test key. */
  add(received: number, author: string, input: Unstamped): string {
    const draft = { ...input, group: this.group, ts: received * 60_000 };
    const { record, id } = signedAs(author, draft);
    this.records.push({ seq: this.records.length + 1, received, bytes: record });
    return id;
  }

  /**
   * Genesis by member 0, then members 1..count-1 join, all {@link SETTLED}
   * minutes before R, and members 0 and 1 vouch for each joiner after the
   * bootstrap's first two, so everyone holds voting rights by R (#101).
   */
  static founded(count: number, atoms: readonly string[] = ['A0', 'A1']): Log {
    const log = new Log();
    const start = R - SETTLED;
    const body = { name: 'G', founder: 'Founder', title: 'Doc', atoms };
    log.group = log.add(start, member(0), { type: 'genesis', body });
    for (let i = 1; i < count; i += 1) {
      log.add(start + i, member(i), { type: 'join', body: { name: member(i) } });
    }
    for (let i = 3; i < count; i += 1) {
      const vouch = { type: 'vouch', body: { member: authorOf(member(i)) } } as const;
      log.add(start + 20 + 2 * i, member(0), vouch);
      log.add(start + 21 + 2 * i, member(1), vouch);
    }
    return log;
  }

  /** A Proposal by member 0, for `window` days when given, else the class default. */
  propose(received: number, atom: string, text: string, window?: number): string {
    const body = { atom, title: 'T', why: 'W', text, ...(window === undefined ? {} : { window }) };
    return this.add(received, member(0), { type: 'proposal', body });
  }

  /** An add of a new section after `after`, or first for null (#75). */
  addSection(received: number, after: string | null, text: string): string {
    const body = { target: { kind: 'add', after } as const, title: 'T', why: 'W', text };
    return this.add(received, member(0), { type: 'proposal', body });
  }

  leave(received: number, who: number): string {
    return this.add(received, member(who), { type: 'leave', body: {} });
  }

  level(received: number, who: number, level: string): string {
    return this.add(received, member(who), { type: 'level', body: { level } });
  }

  vote(received: number, voter: number, proposal: string, value: Score): string {
    return this.ballot(received, voter, proposal, { [proposal]: value });
  }

  /** A ballot scoring each version it names, with a reason whenever it gives a 0. */
  ballot(
    received: number,
    voter: number,
    proposal: string,
    scores: Readonly<Record<string, Score>>,
  ): string {
    const note = Object.values(scores).includes(0) ? { note: 'A reason.' } : {};
    const body = { proposal, scores, ...note };
    return this.add(received, member(voter), { type: 'vote', body });
  }

  version(received: number, author: number, proposal: string, text: string): string {
    return this.add(received, member(author), { type: 'version', body: { proposal, text } });
  }

  /** A removal of member `who` by member `by` (#115). */
  removal(received: number, by: number, who: number): string {
    const target = { kind: 'remove', member: authorOf(member(who)) } as const;
    const body = { target, title: 'Remove them', why: 'They broke the house rules.' };
    return this.add(received, member(by), { type: 'proposal', body });
  }

  /** Member `who`'s response on removal `proposal` (#115). */
  respond(received: number, who: number, proposal: string, text: string): string {
    return this.add(received, member(who), { type: 'removal-response', body: { proposal, text } });
  }

  /** Member `who`'s `remove`, naming removal `proposal` (#115). */
  remove(received: number, who: number, proposal: string): string {
    return this.add(received, member(who), { type: 'remove', body: { proposal } });
  }
}

/** What a late event in the dissolve property acts on: the group's size, an open edit and the dissolve Proposal. */
interface LateContext {
  readonly count: number;
  readonly edit: string;
  readonly motion: string;
}

/**
 * A key change into epoch 1, wrapped to nobody: the property's members hold
 * no kx, so after a leave it would be valid in a group that goes on (#98).
 */
const LATE_ROTATE = { epoch: 1, commit: 'rotation-commit-of-this-propertyAAAAAAAAAAA', wraps: {} };

/** Each kind of event the dissolve property sends late, by member `who` (mod the group's size). */
const LATE = {
  vote: (log, at, who, value, { count, edit }) => log.vote(at, who % count, edit, value),
  version: (log, at, who, _value, { count, edit }) =>
    log.version(at, who % count, edit, 'Late wording'),
  level: (log, at, who, _value, { count }) => log.level(at, who % count, FOLLOWING),
  join: (log, at, who, _value, { count }) =>
    log.add(at, member(count + who), { type: 'join', body: { name: 'Late' } }),
  proposal: (log, at) => log.propose(at, `${log.group}.1`, 'Late text'),
  dissolve: (log, at, who, _value, { count, motion }) =>
    log.add(at, member(who % count), { type: 'dissolve', body: { proposal: motion } }),
  leave: (log, at, who, _value, { count }) => log.leave(at, who % count),
  kx: (log, at, who, _value, { count }) =>
    log.add(at, member(who % count), { type: 'kx', body: { kx: testKx(member(who % count)).kx } }),
  'key-rotate': (log, at, who, _value, { count }) =>
    log.add(at, member(who % count), { type: 'key-rotate', body: LATE_ROTATE }),
} satisfies Record<
  string,
  (log: Log, at: number, who: number, value: Score, context: LateContext) => string
>;

/** The kinds of late event, for fast-check to pick from. */
const LATE_KINDS = Object.keys(LATE) as (keyof typeof LATE)[];

/** Relay minutes after R: anywhere in the window, or right at the deadline of a Proposal made at R + 20. */
const minutesAfterR = fc.oneof(
  fc.integer({ min: 0, max: WINDOW + 100 }),
  fc.integer({ min: WINDOW + 19, max: WINDOW + 21 }),
);

/** A group size, and for each member a score (0–4) or no ballot. */
const electorate = fc
  .integer({ min: 1, max: 12 })
  .chain((count) =>
    fc.array(fc.option(score, { nil: null }), {
      minLength: count,
      maxLength: count,
    }),
  )
  .map((scores) => ({
    count: scores.length,
    ballots: scores.flatMap((value, voter) => (value === null ? [] : [{ voter, value }])),
  }));

// Each run signs and verifies every record for real (Ed25519, a millisecond or two apiece), and a
// property makes a hundred runs, so these take longer than the default 5 seconds under coverage.
describe('properties of the fold', { timeout: 60_000 }, () => {
  it('reaches the same outcome whatever order distinct voters’ ballots arrive in', () => {
    const scenario = electorate.chain(({ count, ballots }) =>
      fc.record({
        count: fc.constant(count),
        first: fc.constant(ballots),
        second: fc.shuffledSubarray(ballots, { minLength: ballots.length }),
        relayNow: fc.option(minutesAfterR, { nil: null }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ count, first, second, relayNow }) => {
        const now = relayNow === null ? null : R + relayNow;
        const outcomeOf = (order: readonly { voter: number; value: Score }[]) => {
          const log = Log.founded(count);
          const proposal = log.propose(R + 20, `${log.group}.0`, 'New text');
          order.forEach(({ voter, value }, i) => log.vote(R + 30 + i, voter, proposal, value));
          const state = fold(log.records, now);
          const p = state.proposals[0];
          return {
            outcome: p?.outcome,
            final: p?.final,
            closedAt: p?.closedAt,
            atoms: state.atoms,
          };
        };
        expect(outcomeOf(second)).toEqual(outcomeOf(first));
      }),
    );
  });

  it('reaches the same outcome whatever order distinct voters’ ballots on several versions arrive in', () => {
    const scenario = fc
      .record({
        versions: fc.integer({ min: 1, max: VERSIONS_MAX }),
        voters: fc.array(
          fc.array(fc.option(score, { nil: null }), { minLength: 3, maxLength: 3 }),
          {
            minLength: 1,
            maxLength: 10,
          },
        ),
      })
      .chain(({ versions, voters }) => {
        const ballots = voters.flatMap((row, voter) => {
          const scored = row
            .slice(0, versions)
            .flatMap((value, v) => (value === null ? [] : [{ v, value }]));
          return scored.length === 0 ? [] : [{ voter, scored }];
        });
        return fc.record({
          count: fc.constant(voters.length),
          versions: fc.constant(versions),
          first: fc.constant(ballots),
          second: fc.shuffledSubarray(ballots, { minLength: ballots.length }),
          relayNow: fc.option(minutesAfterR, { nil: null }),
        });
      });
    type Row = { voter: number; scored: { v: number; value: Score }[] };
    fc.assert(
      fc.property(scenario, ({ count, versions, first, second, relayNow }) => {
        const now = relayNow === null ? null : R + relayNow;
        const outcomeOf = (order: readonly Row[]) => {
          const log = Log.founded(count);
          const proposal = log.propose(R + 20, `${log.group}.0`, 'Version 1');
          const ids = [proposal];
          for (let v = 1; v < versions; v += 1) {
            ids.push(log.version(R + 20 + v, v % count, proposal, `Version ${String(v + 1)}`));
          }
          order.forEach(({ voter, scored }, i) => {
            const scores = Object.fromEntries(scored.map(({ v, value }) => [ids[v] ?? '', value]));
            log.ballot(R + 30 + i, voter, proposal, scores);
          });
          const state = fold(log.records, now);
          const p = state.proposals[0];
          return {
            outcome: p?.outcome,
            final: p?.final,
            closedAt: p?.closedAt,
            atoms: state.atoms,
          };
        };
        expect(outcomeOf(second)).toEqual(outcomeOf(first));
      }),
    );
  });

  it('never has two open Proposals on one Atom, nor more than three versions on a ballot', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const { proposals } = fold(records, relayNow);
        proposals.forEach((later, i) => {
          expect(later.versions.length).toBeLessThanOrEqual(VERSIONS_MAX);
          for (const earlier of proposals.slice(0, i)) {
            if (earlier.atom !== later.atom) continue;
            expect(later.received).toBeGreaterThanOrEqual(earlier.closedAt ?? earlier.deadline);
          }
        });
      }),
    );
  });

  it('only adds or takes out whole Atoms: each id at most once, founded or a passed add’s, in founded order', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const state = fold(records, relayNow);
        const ids = state.atoms.map((atom) => atom.id);
        expect(new Set(ids).size).toBe(ids.length);
        const founded = [0, 1, 2].map((i) => `${state.group ?? ''}.${String(i)}`);
        const added = state.proposals
          .filter((p) => p.target.kind === 'add' && p.final && p.outcome.kind === 'pass')
          .map((p) => p.id);
        for (const id of ids) expect([...founded, ...added]).toContain(id);
        const kept = ids.filter((id) => founded.includes(id));
        expect(kept).toEqual(founded.filter((id) => kept.includes(id)));
      }),
    );
  });

  it('gives deep-equal state when it folds the same records twice', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const copy = records.map((r) => ({ ...r, bytes: r.bytes.slice() }));
        expect(fold(copy, relayNow)).toEqual(fold(records, relayNow));
        expect(fold(records, relayNow)).toEqual(fold(records, relayNow));
      }),
    );
  });

  it('ignores a copy of any signed record with any one byte changed, wherever it lands', () => {
    // Only records that verify: changing a byte of a forged copy back would restore the original.
    const scenario = arbitraryLog.chain((log) => {
      const signed = log.records.filter((record) => parseRecord(record.bytes) !== null);
      return fc.record({
        log: fc.constant(log),
        source: fc.constantFrom(...signed),
        at: fc.nat({ max: log.records.length }),
        flip: fc.nat(),
      });
    });
    fc.assert(
      fc.property(scenario, ({ log: { records, relayNow }, source, at, flip }) => {
        const forged = Uint8Array.from(source.bytes);
        forged[flip % forged.length] = (forged[flip % forged.length] ?? 0) ^ 0x01;
        // It lands at its neighbour's receipt: relay time moves on with any record, valid or not.
        const received = records[at]?.received ?? records.at(-1)?.received ?? R;
        const withForgery = [
          ...records.slice(0, at),
          { seq: 0, received, bytes: forged },
          ...records.slice(at),
        ];
        const state = fold(withForgery, relayNow);
        expect(state.ignored).toContainEqual({ seq: 0, id: null });
        expect({ ...state, ignored: [] }).toEqual({ ...fold(records, relayNow), ignored: [] });
      }),
    );
  });

  it('ignores any record read from another epoch’s mailbox, wherever it lands, even a late copy (#98)', () => {
    const scenario = arbitraryLog.chain((log) =>
      fc.record({
        log: fc.constant(log),
        source: fc.constantFrom(...log.records),
        at: fc.nat({ max: log.records.length }),
        epoch: fc.integer({ min: 1, max: 3 }),
        late: fc.integer({ min: 0, max: 30 * DAY_MINUTES }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ log: { records, relayNow }, source, at, epoch, late }) => {
        // No key change ever happened here, so every epoch but 0 is another mailbox's.
        const stale = { ...source, seq: 0, received: source.received + late, epoch };
        const state = fold([...records.slice(0, at), stale, ...records.slice(at)], relayNow);
        expect(state.ignored).toContainEqual({ seq: 0, id: parseRecord(source.bytes)?.id ?? null });
        expect({ ...state, ignored: [] }).toEqual({ ...fold(records, relayNow), ignored: [] });
      }),
    );
  });

  it('keeps an open Proposal’s eligible set and deadline whatever levels its members move to', () => {
    const change = fc.record({
      who: fc.nat({ max: 11 }),
      level: fc.constantFrom<string>(...LEVELS, 'admin'),
    });
    const scenario = fc.record({
      count: fc.integer({ min: 1, max: 12 }),
      before: fc.array(change, { maxLength: 6 }),
      after: fc.array(change, { maxLength: 12 }),
    });
    fc.assert(
      fc.property(scenario, ({ count, before, after }) => {
        const opened = (changesAfter: readonly { who: number; level: string }[]) => {
          const log = Log.founded(count);
          // Before it opens, anyone but the proposer (member 0) may move; afterwards, anyone.
          before.forEach(({ who, level }, i) => log.level(R + 13 + i, 1 + (who % count), level));
          log.propose(R + 20, `${log.group}.0`, 'New text');
          changesAfter.forEach(({ who, level }, i) => log.level(R + 30 + i, who % count, level));
          const [p] = fold(log.records, R + 100).proposals;
          if (p === undefined) throw new Error('Expected the Proposal to open.');
          return { eligible: p.eligible, deadline: p.deadline, final: p.final };
        };
        expect(opened(after)).toEqual(opened([]));
      }),
    );
  });

  it('keeps an open Proposal’s eligible set, ballots and outcome whoever leaves after it opens', () => {
    const scenario = electorate.chain(({ count, ballots }) =>
      fc.record({
        count: fc.constant(count),
        ballots: fc.constant(ballots),
        leavers: fc.uniqueArray(fc.nat({ max: count - 1 }), { maxLength: count }),
        relayNow: minutesAfterR,
      }),
    );
    fc.assert(
      fc.property(scenario, ({ count, ballots, leavers, relayNow }) => {
        const folded = (leaves: readonly number[]) => {
          const log = Log.founded(count);
          const id = log.propose(R + 20, `${log.group}.0`, 'New text');
          ballots.forEach(({ voter, value }, i) => log.vote(R + 30 + i, voter, id, value));
          leaves.forEach((who, i) => log.leave(R + 60 + i, who));
          return fold(log.records, R + 20 + relayNow);
        };
        const left = folded(leavers);
        const {
          eligible,
          deadline,
          ballots: counted,
          closedAt,
          final,
          outcome,
        } = left.proposals[0] ?? {};
        const stayed = folded([]).proposals[0];
        expect({ eligible, deadline, ballots: counted, closedAt, final, outcome }).toEqual({
          eligible: stayed?.eligible,
          deadline: stayed?.deadline,
          ballots: stayed?.ballots,
          closedAt: stayed?.closedAt,
          final: stayed?.final,
          outcome: stayed?.outcome,
        });
        expect(left.members.length + left.former.length).toBe(count);
        expect(left.former.map((m) => m.author)).toEqual(
          leavers.map((who) => folded([]).members[who]?.author),
        );
      }),
    );
  });

  it('ignores every ballot, version, level and join a member sends after they leave', () => {
    const scenario = fc.record({
      count: fc.integer({ min: 2, max: 8 }),
      who: fc.nat({ max: 7 }),
      value: score,
    });
    fc.assert(
      fc.property(scenario, ({ count, who, value }) => {
        const leaver = 1 + (who % (count - 1));
        const log = Log.founded(count);
        // A Co-Creator, so their version would join the ballot had they stayed.
        log.level(R + 15, leaver, CREATING);
        const id = log.propose(R + 20, `${log.group}.0`, 'New text');
        log.leave(R + 21, leaver);
        const before = fold(log.records, R + 100);
        log.vote(R + 22, leaver, id, value);
        log.version(R + 23, leaver, id, 'Their wording');
        log.level(R + 24, leaver, FOLLOWING);
        log.add(R + 25, member(leaver), { type: 'join', body: { name: 'Back again' } });
        const after = fold(log.records, R + 100);
        expect({ ...after, ignored: [] }).toEqual({ ...before, ignored: [] });
        expect(after.ignored.map((record) => record.seq)).toEqual(
          log.records.slice(-4).map((record) => record.seq),
        );
      }),
    );
  });

  it('ignores every event anyone sends after the group dissolves, whatever it is (#108)', () => {
    const late = fc.array(
      fc.record({
        who: fc.nat({ max: 5 }),
        kind: fc.constantFrom(...LATE_KINDS),
        value: score,
        gap: fc.integer({ min: 0, max: 2 * WINDOW }),
      }),
      { minLength: 1, maxLength: 6 },
    );
    const args = [fc.integer({ min: 3, max: 5 }), fc.boolean(), fc.boolean(), late] as const;
    fc.assert(
      fc.property(...args, (count, wipe, leaveFirst, events) => {
        const log = Log.founded(count);
        const edit = log.propose(R + 10, `${log.group}.0`, 'New text');
        const target = { kind: 'dissolve' as const, wipe };
        const body = { target, title: 'Dissolve', why: 'Done.' };
        const motion = log.add(R + 11, member(0), { type: 'proposal', body });
        for (let i = 0; i < count; i += 1) log.vote(R + 12 + i, i, motion, 4);
        // A leave just before the dissolve makes a key change due, until the dissolve ends it (#98).
        if (leaveFirst) log.leave(R + 19, count - 1);
        log.add(R + 20, member(1), { type: 'dissolve', body: { proposal: motion } });
        const before = fold(log.records, R + 30);
        let at = R + 20;
        for (const { who, kind, value, gap } of events) {
          at += gap;
          LATE[kind](log, at, who, value, { count, edit, motion });
        }
        const after = fold(log.records, at + 3 * WINDOW);
        expect(before.dissolved).toEqual({ received: R + 20, wipe });
        expect([before.epoch, before.rotationDue, before.former.length]).toEqual([
          0,
          false,
          leaveFirst ? 1 : 0,
        ]);
        expect({ ...after, ignored: [] }).toEqual({ ...before, ignored: [] });
        expect(after.ignored.map((record) => record.seq)).toEqual(
          log.records.slice(-events.length).map((record) => record.seq),
        );
      }),
    );
  });

  it('counts nothing the member a removal names sends on it: their ballots and later responses change nothing (#115)', () => {
    const scenario = electorate
      .filter(({ count }) => count >= 2)
      .chain(({ count, ballots: cast }) =>
        fc.record({
          count: fc.constant(count),
          ballots: fc.constant(cast),
          target: fc.integer({ min: 1, max: count - 1 }),
          theirs: fc.array(score, { maxLength: 3 }),
          responses: fc.integer({ min: 1, max: 3 }),
          relayNow: fc.integer({
            min: 100,
            max: 2 * DEFAULT_RULES.windows.removal.default * DAY_MINUTES,
          }),
        }),
      );
    fc.assert(
      fc.property(scenario, ({ count, ballots: cast, target, theirs, responses, relayNow }) => {
        const folded = (withTheirs: boolean) => {
          const log = Log.founded(count);
          const id = log.removal(R + 20, 0, target);
          if (withTheirs) {
            for (let i = 0; i < responses; i += 1)
              log.respond(R + 21, target, id, `Mine ${String(i)}`);
            for (const value of theirs) log.vote(R + 21, target, id, value);
          }
          cast.forEach(({ voter, value }, i) => {
            if (voter !== target) log.vote(R + 30 + i, voter, id, value);
          });
          return fold(log.records, R + 20 + relayNow);
        };
        const pick = (state: ReturnType<typeof fold>) => {
          const {
            eligible,
            ballots: counted = [],
            closedAt,
            final,
            outcome,
          } = state.proposals[0] ?? {};
          const unsequenced = counted.map(({ id, voter, scores, received }) => ({
            id,
            voter,
            scores,
            received,
          }));
          const removals = state.removals.map(({ member: out, passedAt }) => ({ out, passedAt }));
          return { eligible, unsequenced, closedAt, final, outcome, removals };
        };
        const sent = folded(true);
        expect(pick(sent)).toEqual(pick(folded(false)));
        expect(sent.proposals[0]?.eligible).not.toContain(authorOf(member(target)));
        expect(sent.responses.map((response) => response.text)).toEqual(['Mine 0']);
      }),
    );
  });

  it('takes the member a passed removal names out once, whoever posts the remove and in whatever order (#115)', () => {
    const scenario = fc.integer({ min: 3, max: 6 }).chain((count) =>
      fc.record({
        count: fc.constant(count),
        target: fc.integer({ min: 1, max: count - 1 }),
        posters: fc.array(fc.nat({ max: count + 1 }), { minLength: 1, maxLength: 6 }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ count, target, posters }) => {
        const log = Log.founded(count);
        const id = log.removal(R + 20, target === 1 ? 2 : 1, target);
        for (let voter = 0; voter < count; voter += 1) {
          if (voter !== target) log.vote(R + 21 + voter, voter, id, 4);
        }
        posters.forEach((who, i) => log.remove(R + 40 + i, who, id));
        const state = fold(log.records, R + 100);
        // The first remove from a member other than the one it names; members are 0 to count - 1.
        const poster = posters.find((who) => who < count && who !== target);
        const took = poster === undefined ? 0 : 1;
        const out = authorOf(member(target));
        expect(state.members.filter((m) => m.author === out)).toHaveLength(1 - took);
        expect(state.members).toHaveLength(count - took);
        expect(state.former.filter((m) => m.author === out)).toHaveLength(took);
        expect(state.rotationDue).toBe(took === 1);
        const by = state.removals[0]?.removed?.by;
        expect(by).toBe(poster === undefined ? undefined : authorOf(member(poster)));
        expect(state.ignored).toHaveLength(posters.length - took);
      }),
    );
  });

  it('ignores everything the member a passed removal names sends but their leave (#115)', () => {
    const late = fc.array(
      fc.record({
        kind: fc.constantFrom(
          ...LATE_KINDS.filter((kind) => !['leave', 'join', 'proposal'].includes(kind)),
        ),
        value: score,
      }),
      { minLength: 1, maxLength: 6 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 5 }), late, (count, events) => {
        const target = count - 1;
        const log = Log.founded(count);
        const edit = log.propose(R + 10, `${log.group}.0`, 'New text');
        const id = log.removal(R + 11, 0, target);
        for (let voter = 0; voter < target; voter += 1) log.vote(R + 12 + voter, voter, id, 4);
        const before = fold(log.records, R + 100);
        let at = R + 20;
        for (const { kind, value } of events) {
          at += 1;
          LATE[kind](log, at, target, value, { count, edit, motion: id });
        }
        log.remove(at + 1, target, id);
        const after = fold(log.records, R + 100);
        expect(before.removals).toHaveLength(1);
        expect({ ...after, ignored: [] }).toEqual({ ...before, ignored: [] });
        log.leave(at + 2, target);
        const left = fold(log.records, R + 100);
        expect(left.former.map((m) => m.author)).toEqual([authorOf(member(target))]);
        expect(left.rotationDue).toBe(true);
      }),
    );
  });

  it('gives every Proposal its class’s window and tallies it at its class’s bar', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const { proposals, rules } = fold(records, relayNow);
        for (const p of proposals) {
          // The log proposes only edits, which are ordinary; dissolving is entrenched (#108).
          expect(p.class).toBe('ordinary');
          expect(p.window).toBe(rules.windows[p.class].default);
          expect(p.deadline).toBe(p.received + defaultWindowMinutes(rules, p.class));
          expect(p.outcome.bar).toEqual(rules.bars[p.class]);
        }
      }),
    );
  });

  it('opens a Proposal exactly when its window is valid for its class, closing it that many days later', () => {
    const window = fc.oneof(
      fc.integer({ min: -2, max: 31 }),
      fc.double({ min: -2, max: 31, noNaN: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
    );
    fc.assert(
      fc.property(window, fc.nat({ max: 100 }), (days, offset) => {
        const log = Log.founded(2);
        // JSON writes NaN and Infinity as null, which the fold reads as a bad shape.
        log.propose(R + offset, `${log.group}.0`, 'New text', days);
        const { proposals, rules } = fold(log.records, R + offset);
        const [p] = proposals;
        expect(p !== undefined).toBe(validWindow(rules, 'ordinary', days));
        if (p === undefined) return;
        expect(p.window).toBe(days);
        expect(p.deadline).toBe(R + offset + days * DAY_MINUTES);
      }),
    );
  });

  it('changes only the target Atom on a final pass, removing it for "", and no Atom on a fail or lapse', () => {
    const scenario = fc.record({
      atoms: fc.array(fc.string({ unit: 'grapheme', maxLength: 12 }), {
        minLength: 1,
        maxLength: 4,
      }),
      target: fc.nat(),
      text: fc.string({ unit: 'grapheme', maxLength: 12 }),
      electorate,
      minutes: minutesAfterR,
    });
    fc.assert(
      fc.property(scenario, ({ atoms, target, text, electorate: { count, ballots }, minutes }) => {
        const log = Log.founded(count, atoms);
        const before = fold(log.records, R).atoms;
        const atomIndex = target % atoms.length;
        const proposal = log.propose(R + 20, `${log.group}.${String(atomIndex)}`, text);
        ballots.forEach(({ voter, value }, i) => log.vote(R + 30 + i, voter, proposal, value));
        const state = fold(log.records, R + minutes);
        const p = state.proposals[0];
        const passed = p?.final === true && p.outcome.kind === 'pass';
        const removed = passed && p.text === '';
        const expected = before.flatMap((atom, i) => {
          if (!passed || i !== atomIndex) return [atom];
          return removed ? [] : [{ ...atom, text: p.text }];
        });
        expect(state.atoms.map((a) => encoder.encode(a.text))).toEqual(
          expected.map((a) => encoder.encode(a.text)),
        );
        expect(state.atoms).toEqual(expected);
      }),
    );
  });
});

/**
 * One step of a random log, after a wait: a join, a level change (to a known level or not), a
 * Proposal, a version, a ballot, a repeat, garbage, or a forged copy of an earlier record with
 * one byte changed.
 */
const step = fc.record({
  kind: fc.constantFrom(
    'join',
    'level',
    'propose',
    'remove',
    'add',
    'version',
    'vote',
    'repeat',
    'garbage',
    'forge',
  ),
  who: fc.integer({ min: 0, max: 5 }),
  target: fc.integer({ min: 0, max: 3 }),
  level: fc.constantFrom<string>(...LEVELS, 'admin'),
  score,
  wait: fc.integer({ min: 0, max: 4_000 }),
});

type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

/** An earlier record, or garbage before any: as it was for a repeat, with one byte changed for a forgery. */
function copyOf(log: Log, s: Step): Uint8Array {
  const earlier = log.records[s.target % log.records.length]?.bytes ?? encoder.encode('{');
  if (s.kind !== 'forge') return earlier;
  const forged = Uint8Array.from(earlier);
  forged[s.wait % forged.length] = (forged[s.wait % forged.length] ?? 0) ^ 0x01;
  return forged;
}

/** What one kind of step appends to the log at relay minute `received`. */
type StepWriter = (log: Log, proposals: string[], s: Step, received: number) => void;

/** One record that isn't a fresh event: a repeat or forgery of an earlier record, or garbage. */
function rawRecord(bytes: (log: Log, s: Step) => Uint8Array): StepWriter {
  return (log, _proposals, s, received) => {
    log.records.push({ seq: log.records.length + 1, received, bytes: bytes(log, s) });
  };
}

const STEP_WRITERS: Readonly<Record<Step['kind'], StepWriter>> = {
  join: (log, _proposals, s, received) => {
    log.add(received, member(s.who), { type: 'join', body: { name: 'N' } });
  },
  level: (log, _proposals, s, received) => {
    log.level(received, s.who, s.level);
  },
  propose: (log, proposals, s, received) => {
    proposals.push(log.propose(received, `${log.group}.${String(s.target)}`, 'X'));
  },
  remove: (log, proposals, s, received) => {
    proposals.push(log.propose(received, `${log.group}.${String(s.target)}`, ''));
  },
  // Anchored on a genesis Atom, an earlier add's Atom (once it may have passed), or the start.
  add: (log, proposals, s, received) => {
    const anchors = [null, `${log.group}.${String(s.target)}`, ...proposals];
    const after = anchors[s.who % anchors.length] ?? null;
    proposals.push(log.addSection(received, after, s.score === 0 ? '' : `Add ${String(s.score)}`));
  },
  version: (log, proposals, s, received) => {
    log.version(received, s.who, proposals[s.target] ?? 'unknown', `V${String(s.score)}`);
  },
  vote: (log, proposals, s, received) => {
    log.vote(received, s.who, proposals[s.target] ?? 'unknown', s.score);
  },
  repeat: rawRecord(copyOf),
  forge: rawRecord(copyOf),
  garbage: rawRecord(() => encoder.encode('{')),
};

/** Appends one random step to the log at relay minute `received`. */
function applyStep(log: Log, proposals: string[], s: Step, received: number): void {
  STEP_WRITERS[s.kind](log, proposals, s, received);
}

/** A random log of valid and invalid events, plus a relay time to fold it at. */
const arbitraryLog = fc
  .record({
    steps: fc.array(step, { maxLength: 40 }),
    after: fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
  })
  .map(({ steps, after }) => {
    const log = Log.founded(2, ['A0', 'A1', 'A2']);
    const proposals: string[] = [];
    let received = R + 10;
    for (const s of steps) {
      received += s.wait;
      applyStep(log, proposals, s, received);
    }
    return { records: log.records, relayNow: after === null ? null : received + after };
  });

/**
 * A ballot set: each voter's row scores some of up to three versions (null: not scored), and the
 * eligible count is at least the number of voters.
 */
const ballotSet = fc
  .record({
    versions: fc.integer({ min: 1, max: VERSIONS_MAX }),
    rows: fc.array(fc.array(fc.option(score, { nil: null }), { minLength: 3, maxLength: 3 }), {
      maxLength: 30,
    }),
    absent: fc.nat({ max: 30 }),
  })
  .map(({ versions, rows, absent }) => ({
    eligible: rows.length + absent,
    rows: rows.map((row) => row.slice(0, versions)),
    versions,
  }));

type Rows = readonly (readonly (Score | null)[])[];

/** The tally input for `rows`: version `v` gets each row's score for it, in row order. */
function ballots(eligible: number, versions: number, rows: Rows): Omit<TallyInput, 'bar'> {
  return {
    eligible,
    versions: Array.from({ length: versions }, (_, v) => ({
      id: `v${String(v)}`,
      scores: rows.flatMap((row) => {
        const value = row[v];
        return value === null || value === undefined ? [] : [value];
      }),
    })),
  };
}

const { ordinary: ORDINARY, entrenched: ENTRENCHED, removal: REMOVAL } = DEFAULT_RULES.bars;

describe('properties of the bars', () => {
  it('passes a ballot set at the ordinary bar whenever it passes at the entrenched bar', () => {
    fc.assert(
      fc.property(ballotSet, ({ eligible, versions, rows }) => {
        const input = ballots(eligible, versions, rows);
        if (tally({ ...input, bar: ENTRENCHED }).kind === 'pass') {
          expect(tally({ ...input, bar: ORDINARY }).kind).toBe('pass');
        }
        // Version by version, too: no single version clears the higher bar and misses the lower.
        for (const version of input.versions) {
          const alone = { eligible, versions: [version] };
          if (tally({ ...alone, bar: ENTRENCHED }).kind === 'pass') {
            expect(tally({ ...alone, bar: ORDINARY }).kind).toBe('pass');
          }
        }
      }),
    );
  });

  it('reaches the same outcome at either bar whatever order the ballots arrive in', () => {
    const scenario = ballotSet.chain((set) =>
      fc.record({
        set: fc.constant(set),
        shuffled: fc.shuffledSubarray([...set.rows], { minLength: set.rows.length }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ set: { eligible, versions, rows }, shuffled }) => {
        for (const bar of [ORDINARY, ENTRENCHED, REMOVAL] satisfies Bar[]) {
          const first = tally({ ...ballots(eligible, versions, rows), bar });
          const second = tally({ ...ballots(eligible, versions, shuffled), bar });
          expect(second).toEqual(first);
        }
      }),
    );
  });

  it('passes a ballot set at removal’s bar whenever it passes at the entrenched bar (#115)', () => {
    fc.assert(
      fc.property(ballotSet, ({ eligible, versions, rows }) => {
        const input = ballots(eligible, versions, rows);
        if (tally({ ...input, bar: ENTRENCHED }).kind === 'pass') {
          expect(tally({ ...input, bar: REMOVAL }).kind).toBe('pass');
        }
      }),
    );
  });

  it('never lets a single 0 block a removal: one 0 fails it only through the average (#115)', () => {
    fc.assert(
      fc.property(fc.array(score, { minLength: 1, maxLength: 40 }), (scores) => {
        const withZero = [0, ...scores.filter((value) => value !== 0)] as Score[];
        const detail = tallyDetail({
          eligible: withZero.length,
          versions: [{ id: 'v', scores: withZero }],
          bar: REMOVAL,
        });
        expect(detail.versions[0]?.zerosMet).toBe(true);
      }),
    );
  });

  it('lapses at one bar exactly when it lapses at the other: quorum doesn’t depend on the bar', () => {
    fc.assert(
      fc.property(ballotSet, ({ eligible, versions, rows }) => {
        const input = ballots(eligible, versions, rows);
        const lapses = (bar: Bar) => tally({ ...input, bar }).kind === 'lapse';
        expect(lapses(ENTRENCHED)).toBe(lapses(ORDINARY));
      }),
    );
  });
});

/** Seat `i`'s name and the participant bound to it, in the coalition properties (#100). */
const seatName = (i: number) => `S${String(i)}`;
const participant = (i: number) => `p${String(i)}`;

describe('properties of coalitions (#100)', { timeout: 120_000 }, () => {
  it('reaches the same outcome whatever order distinct seats’ results arrive in, by coalitionOutcome', () => {
    const scenario = fc.record({
      seats: fc.integer({ min: 2, max: 7 }),
      results: fc.array(
        fc.option(fc.constantFrom<'pass' | 'fail'>('pass', 'fail'), { nil: null }),
        {
          minLength: 7,
          maxLength: 7,
        },
      ),
      order: fc.array(fc.nat(), { minLength: 7, maxLength: 7 }),
      expired: fc.boolean(),
    });
    fc.assert(
      fc.property(scenario, ({ seats, results, order, expired }) => {
        const reports = results
          .slice(0, seats)
          .flatMap((result, seat) => (result === null ? [] : [{ seat, result }]));
        const shuffled = [...reports].sort(
          (a, b) => (order[a.seat] ?? 0) - (order[b.seat] ?? 0) || a.seat - b.seat,
        );
        const names = Array.from({ length: seats }, (_, i) => seatName(i));
        const folded = (sequence: typeof reports) => {
          const logs = new Logs();
          const at = logs.formed(
            R,
            names,
            names.map((_, i) => participant(i)),
          );
          const motion = logs.motion(at, participant(0));
          sequence.forEach(({ seat, result }, i) => {
            logs.result(at + 1 + i, participant(seat), motion, seatName(seat), result);
          });
          const deadline = at + WINDOW;
          const now = expired ? deadline + RESULT_GRACE_MINUTES : deadline;
          const state = fold(logs.logs.coalition ?? [], now);
          const p = state.proposals[0];
          return {
            outcome: p?.outcome,
            final: p?.final,
            atoms: state.atoms,
            status: state.coalition?.status,
          };
        };
        const first = folded(reports);
        expect(folded(shuffled)).toEqual(first);
        const passes = reports.filter((r) => r.result === 'pass').length;
        const kind = coalitionOutcome({
          seats,
          passes,
          fails: reports.length - passes,
          expired,
        }).kind;
        expect(first.outcome?.kind).toBe(kind === 'open' ? 'lapse' : kind);
        expect(first.final).toBe(kind === 'fail' || expired);
        expect(first.status).toBe('formed');
      }),
      { numRuns: 40 },
    );
  });

  it('builds no result event, from what a group owes, that holds any of its names, notes, keys or ids', () => {
    const scenario = fc.record({
      canary: fc.stringMatching(/^[a-z0-9]{8}$/),
      reconcile: fc.array(score, { minLength: 3, maxLength: 3 }),
      motion: fc.array(score, { minLength: 3, maxLength: 3 }),
    });
    fc.assert(
      fc.property(scenario, ({ canary, reconcile, motion: scores }) => {
        const mark = `canary${canary}`;
        const logs = new Logs();
        const voters = ['ana', 'ben', 'cal'];
        const genesis = {
          name: `Group ${mark}`,
          founder: `Ana ${mark}`,
          title: `Rules ${mark}`,
          atoms: [mark],
        };
        logs.add('A', R, 'ana', { type: 'genesis', body: genesis });
        for (const voter of voters.slice(1)) {
          logs.add('A', R + 1, voter, {
            type: 'join',
            body: { name: `${voter} ${mark}`, level: CREATING },
          });
        }
        const held = logs.reconcile('A', R + 2, 'ben', 'A', {
          title: `Join ${mark}`,
          why: `Why ${mark}`,
        });
        voters.forEach((voter, i) =>
          logs.vote('A', R + 3, voter, held, reconcile[i] ?? 4, `Note ${mark}`),
        );
        const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
        const motion = logs.motion(at, 'zed');
        voters.forEach((voter, i) =>
          logs.vote('A', at + 1, voter, motion, scores[i] ?? 4, `Note ${mark}`),
        );
        const logsNow = foldLogs(logs.logs, at + WINDOW);
        const group = folded(logsNow, 'A').state;
        const owed = resultsToReport(
          group,
          folded(logsNow, 'coalition').state,
          seatOf(logsNow, 'A'),
        );
        expect(owed.length).toBeGreaterThan(0);
        const forbidden = [
          mark,
          ...voters.map(authorOf),
          group.group ?? 'no group',
          'scores',
          'note',
        ];
        for (const body of owed) {
          expect(Object.keys(body).sort()).toEqual(['motion', 'result', 'seat']);
          const draft = {
            type: 'group-result',
            group: logs.ids.coalition ?? '',
            ts: 0,
            body,
          } as const;
          const { record } = signedAs('kim', draft);
          const text = new TextDecoder().decode(record.subarray(96));
          for (const secret of forbidden) expect(text).not.toContain(secret);
        }
      }),
      { numRuns: 25 },
    );
  });
});
