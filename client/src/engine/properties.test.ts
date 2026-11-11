/**
 * Properties of the fold (fast-check): every device that folds the same relay
 * records builds the same state, the Document changes only on a final pass, a level change
 * or a leave never reaches back into a Proposal that's already open, a member who has left
 * acts no more, an Atom never has two open Proposals or a ballot more than three versions,
 * and adds and removals (#75) only ever add or take out whole Atoms. And of the bars (#94):
 * the entrenched bar is never easier than the ordinary one, and neither depends on the order
 * ballots arrive in. And of windows (#106): a Proposal opens only for a window its class
 * allows, and runs exactly that long. And of epochs (#98): a record read from another epoch's
 * mailbox changes nothing, not even relay time. And of coalitions (#100): a motion's outcome
 * doesn't depend on the order distinct seats' results arrive in, and nothing a group reports
 * carries a name, note, score or key from inside it. And of a priority vote's ranking (#107):
 * it holds exactly the options that pass, best first, its first is always the tally's winner,
 * and the order ballots arrive in never changes it. And of ballot expiry (#111): a device that
 * has cleared a closed Proposal's ballots, keeping its result, folds the same Document and
 * outcomes as one that still holds them. And of moves (#103): passed moves only ever reorder a
 * Document, keeping its Atom ids and their bytes, and every device that folds the same records
 * builds the same order, which follows close time, then the moves' relay order, whatever order
 * their ballots arrive in. And of section classes (#116): every Proposal on a section opens at
 * the class its section's last passed class Proposal gave it, a section's class is that
 * Proposal's, and once a section is eternal no Proposal on it ever opens again.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { folded, foldLogs, Logs, seatOf } from '../test/coalitions';
import { authorOf, signedAs, testKx } from '../test/keys';
import { LEVELS } from './capabilities';
import { coalitionOutcome, RESULT_GRACE_MINUTES } from './coalition';
import { resultsToReport } from './crossing';
import { VERSIONS_MAX } from './composeOption';
import { type EventDraft, type FoundingDocument, parseRecord, type Score } from './event';
import { expiringProposal, resultFor } from './expiry';
import {
  closeTime,
  fold,
  type GroupState,
  heldRecord,
  type LogRecord,
  type Proposal,
} from './fold';
import { OPTIONS_MAX, OPTIONS_MIN } from './priority';
import { type Bar, DAY_MINUTES, DEFAULT_RULES, defaultWindowMinutes, validWindow } from './rules';
import { rank, tally, type TallyInput } from './tally';

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
  static founded(
    count: number,
    atoms: readonly string[] = ['A0', 'A1'],
    more: readonly FoundingDocument[] = [],
  ): Log {
    const log = new Log();
    const start = R - SETTLED;
    const body = { name: 'G', founder: 'Founder', documents: [{ title: 'Doc', atoms }, ...more] };
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

  /** An add of a new section after `after`, or first for null (#75), in `document`, the first by default (#92). */
  addSection(received: number, after: string | null, text: string, document = this.group): string {
    const body = { target: { kind: 'add', document, after } as const, title: 'T', why: 'W', text };
    return this.add(received, member(0), { type: 'proposal', body });
  }

  /** A move of `atom` right after `after`, or first for null (#103), by member 0. */
  move(received: number, atom: string, after: string | null): string {
    const body = { target: { kind: 'move', atom, after } as const, title: 'T', why: 'W' };
    return this.add(received, member(0), { type: 'proposal', body });
  }

  /** A class Proposal giving `atom` the class `to` (#116), by member 0. */
  classify(received: number, atom: string, to: string): string {
    const body = { target: { kind: 'class', atom, to } as const, title: 'T', why: 'W' };
    return this.add(received, member(0), { type: 'proposal', body });
  }

  /** A new Document titled `title`, whose text is its first sections (#92). */
  newDocument(received: number, title: string, text: string): string {
    const target = { kind: 'new-document', title } as const;
    return this.add(received, member(0), {
      type: 'proposal',
      body: { target, title: 'T', why: 'W', text },
    });
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

  it('only adds, takes out or moves whole Atoms: each id at most once, founded, a passed add’s or a passed new Document’s, in founded order unless a move passed on it, and Document by Document', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const state = fold(records, relayNow);
        const ids = state.atoms.map((atom) => atom.id);
        expect(new Set(ids).size).toBe(ids.length);
        const group = state.group ?? '';
        const founded = [...FIRST_SECTIONS.map((_, i) => `${group}.${String(i)}`)];
        founded.push(...SECOND_SECTIONS.map((_, i) => `${group}:1.${String(i)}`));
        const passed = state.proposals.filter((p) => p.final && p.outcome.kind === 'pass');
        const added = passed.filter((p) => p.target.kind === 'add').map((p) => p.id);
        const created = passed.filter((p) => p.target.kind === 'new-document').map((p) => p.id);
        for (const id of ids) {
          const fromNew = created.some((document) => id.startsWith(`${document}.`));
          expect(fromNew || [...founded, ...added].includes(id), id).toBe(true);
        }
        // A passed move reorders its own section alone (#103): every other keeps its founded order.
        const moved = passed.filter((p) => p.target.kind === 'move').map((p) => p.atom);
        const kept = ids.filter((id) => founded.includes(id) && !moved.includes(id));
        expect(kept).toEqual(founded.filter((id) => kept.includes(id)));
        const order = state.documents.map((document) => document.id);
        const places = state.atoms.map((atom) => order.indexOf(atom.documentId));
        expect(places.every((place, i) => place >= Math.max(0, places[i - 1] ?? 0))).toBe(true);
        expect(order.slice(0, 2)).toEqual([group, `${group}:1`]);
        expect([...order.slice(2)].sort()).toEqual([...created].sort());
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

  it('gives every Proposal its class’s window and tallies it at its class’s bar', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const { proposals, rules } = fold(records, relayNow);
        for (const p of proposals) {
          // A class Proposal is entrenched, and so is a change or move of an entrenched section (#116).
          expect(p.class).toBe(classAtOpening(proposals, p));
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

  it('leaves every other Document’s Atoms byte-identical on a final pass in one Document (#92)', () => {
    const words = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 });
    const scenario = fc.record({
      documents: fc.array(fc.array(words, { minLength: 1, maxLength: 3 }), {
        minLength: 2,
        maxLength: 3,
      }),
      kind: fc.constantFrom('edit', 'remove', 'add', 'new-document'),
      document: fc.nat(),
      section: fc.nat(),
      first: fc.boolean(),
      text: words,
      electorate,
      minutes: minutesAfterR,
    });
    fc.assert(
      fc.property(scenario, (s) => {
        const [first = [], ...rest] = s.documents;
        const more = rest.map((atoms, k) => ({ title: `Doc ${String(k + 1)}`, atoms }));
        const log = Log.founded(s.electorate.count, first, more);
        const before = fold(log.records, R);
        const target = before.documents[s.document % before.documents.length]?.id ?? '';
        const sections = before.atoms.filter((atom) => atom.documentId === target);
        const section = sections[s.section % sections.length]?.id ?? '';
        const proposal = proposeIn(log, { ...s, target, section });
        s.electorate.ballots.forEach(({ voter, value }, i) => {
          log.vote(R + 30 + i, voter, proposal, value);
        });
        const after = fold(log.records, R + s.minutes);
        const changed = s.kind === 'new-document' ? null : target;
        for (const { id } of before.documents.filter((document) => document.id !== changed)) {
          const was = before.atoms.filter((atom) => atom.documentId === id);
          const now = after.atoms.filter((atom) => atom.documentId === id);
          expect(now.map((atom) => encoder.encode(atom.text))).toEqual(
            was.map((atom) => encoder.encode(atom.text)),
          );
          expect(now).toEqual(was);
        }
        expect(after.documents.slice(0, before.documents.length)).toEqual(before.documents);
      }),
    );
  });
});

/** `ids` with `id` taken out and put right after `after`, first for null, as a passed move does. */
function movedIds(ids: readonly string[], id: string, after: string | null): string[] {
  const rest = ids.filter((other) => other !== id);
  const index = after === null ? -1 : rest.indexOf(after);
  return [...rest.slice(0, index + 1), id, ...rest.slice(index + 1)];
}

/** Each section's id and bytes, sorted by id: a Document's contents, whatever their order. */
function contents(atoms: readonly { readonly id: string; readonly text: string }[]) {
  return [...atoms]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((atom) => [atom.id, Array.from(encoder.encode(atom.text))]);
}

/** A Document of 2–6 sections, and moves: each picks a section and an anchor among them, or none. */
const moves = fc.record({
  sections: fc.array(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }), {
    minLength: 2,
    maxLength: 6,
  }),
  picks: fc.array(fc.record({ section: fc.nat(), anchor: fc.option(fc.nat(), { nil: null }) }), {
    minLength: 1,
    maxLength: 6,
  }),
});

describe('properties of moves (#103)', { timeout: 60_000 }, () => {
  it('keeps every Atom id and its bytes through any sequence of passed moves: only the order changes, as each move says', () => {
    fc.assert(
      fc.property(moves, ({ sections, picks }) => {
        const log = Log.founded(2, sections);
        const before = fold(log.records, R).atoms;
        let order = before.map((atom) => atom.id);
        picks.forEach(({ section, anchor }, i) => {
          const at = R + 20 + 10 * i;
          const id = order[section % order.length] ?? '';
          const after = anchor === null ? null : (order[anchor % order.length] ?? null);
          const move = log.move(at, id, after);
          log.vote(at + 1, 0, move, 4);
          log.vote(at + 2, 1, move, 4);
          // A move anchored on its own section is ignored, so it moves nothing (#103).
          if (after !== id) order = movedIds(order, id, after);
        });
        const after = fold(log.records, R + 20 + 10 * picks.length).atoms;
        expect(after.map((atom) => atom.id)).toEqual(order);
        expect(contents(after)).toEqual(contents(before));
      }),
    );
  });

  it('builds the same order whatever order the moves’ ballots arrive in: close time, then the moves’ relay order', () => {
    const scenario = moves.chain(({ sections, picks }) => {
      const count = Math.min(picks.length, sections.length);
      const ballots = Array.from({ length: 2 * count }, (_, i) => i);
      return fc.record({
        sections: fc.constant(sections),
        picks: fc.constant(picks.slice(0, count)),
        arrival: fc.shuffledSubarray(ballots, { minLength: ballots.length }),
        sameMinute: fc.boolean(),
      });
    });
    fc.assert(
      fc.property(scenario, ({ sections, picks, arrival, sameMinute }) => {
        const log = Log.founded(2, sections);
        const founded = fold(log.records, R).atoms.map((atom) => atom.id);
        // Each move takes a section of its own, so all of them are open at once.
        const free = [...founded];
        const planned = picks.map(({ section, anchor }, i) => {
          const [id = ''] = free.splice(section % free.length, 1);
          const others = founded.filter((other) => other !== id);
          const after = anchor === null ? null : (others[anchor % others.length] ?? null);
          return { id, after, proposal: log.move(R + 20 + i, id, after) };
        });
        const closes = new Map<number, number>();
        arrival.forEach((ballot, place) => {
          const index = Math.floor(ballot / 2);
          const at = sameMinute ? R + 100 : R + 100 + place;
          log.vote(at, ballot % 2, planned[index]?.proposal ?? '', 4);
          closes.set(index, at);
        });
        const inPassOrder = planned
          .map((move, index) => ({ ...move, close: closes.get(index) ?? 0, index }))
          .sort((a, b) => a.close - b.close || a.index - b.index);
        const order = inPassOrder.reduce<string[]>(
          (ids, move) => movedIds(ids, move.id, move.after),
          founded,
        );
        const state = fold(log.records, R + 100 + arrival.length);
        expect(state.proposals.every((p) => p.final && p.outcome.kind === 'pass')).toBe(true);
        expect(state.atoms.map((atom) => atom.id)).toEqual(order);
      }),
    );
  });
});

/** What {@link proposeIn} proposes: its kind, its Document, a section of it, and its text. */
interface InDocument {
  readonly kind: 'edit' | 'remove' | 'add' | 'new-document';
  readonly target: string;
  readonly section: string;
  readonly first: boolean;
  readonly text: string;
}

/** One Proposal at R + 20 in the Document `target` (#92), or a new Document beside it. */
function proposeIn(log: Log, { kind, target, section, first, text }: InDocument): string {
  if (kind === 'edit') return log.propose(R + 20, section, text);
  if (kind === 'remove') return log.propose(R + 20, section, '');
  if (kind === 'add') return log.addSection(R + 20, first ? null : section, text, target);
  return log.newDocument(R + 20, 'New', text);
}

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
    'new-document',
    'move',
    'class',
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
    proposals.push(log.propose(received, sectionOf(log, s), 'X'));
  },
  remove: (log, proposals, s, received) => {
    proposals.push(log.propose(received, sectionOf(log, s), ''));
  },
  // In a founded Document or a new one (once it may have passed, #92), anchored on a founded
  // Atom of either, an earlier add's Atom (once it may have passed), or the start.
  add: (log, proposals, s, received) => {
    const documents = [log.group, `${log.group}:1`, ...proposals];
    const document = documents[s.score % documents.length] ?? log.group;
    const anchors = [null, sectionOf(log, s), ...proposals];
    const after = anchors[s.who % anchors.length] ?? null;
    const text = s.score === 0 ? '' : `Add ${String(s.score)}`;
    proposals.push(log.addSection(received, after, text, document));
  },
  // A founded section or an earlier add's, after a founded section of either Document, an earlier
  // add's, itself, or the start (#103).
  move: (log, proposals, s, received) => {
    const sections = [sectionOf(log, s), ...proposals];
    const atom = sections[s.score % sections.length] ?? sectionOf(log, s);
    const anchors = [null, sectionOf(log, s), atom, ...proposals];
    const after = anchors[s.who % anchors.length] ?? null;
    proposals.push(log.move(received, atom, after));
  },
  // A founded section or an earlier add's, to any class or one the fold doesn't know (#116).
  class: (log, proposals, s, received) => {
    const sections = [sectionOf(log, s), ...proposals];
    const atom = sections[s.who % sections.length] ?? sectionOf(log, s);
    const to = ['ordinary', 'entrenched', 'eternal', 'sacred'][s.score % 4] ?? 'eternal';
    proposals.push(log.classify(received, atom, to));
  },
  'new-document': (log, proposals, s, received) => {
    const text = s.score === 0 ? ' \n\n' : `N${String(s.score)}\n\nM${String(s.who)}\n`;
    proposals.push(log.newDocument(received, s.target === 3 ? '' : `Doc ${String(s.who)}`, text));
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

/** The founded Document sections the random log starts with (#92). */
const FIRST_SECTIONS = ['A0', 'A1', 'A2'];
const SECOND_SECTIONS = ['B0', 'B1'];

/** A founded section a step names: one of the first Document's, or the second's for an odd `who`. */
function sectionOf(log: Log, s: Step): string {
  return s.who % 2 === 0
    ? `${log.group}.${String(s.target)}`
    : `${log.group}:1.${String(s.target % SECOND_SECTIONS.length)}`;
}

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
    const log = Log.founded(2, FIRST_SECTIONS, [{ title: 'Second', atoms: SECOND_SECTIONS }]);
    const proposals: string[] = [];
    let received = R + 10;
    for (const s of steps) {
      received += s.wait;
      applyStep(log, proposals, s, received);
    }
    return { records: log.records, relayNow: after === null ? null : received + after };
  });

/** The passed class Proposals on `atom` before `p` in relay order, the last of them last (#116). */
function passedClassesBefore(proposals: readonly Proposal[], atom: string, seq: number) {
  return proposals.filter(
    (q) =>
      q.target.kind === 'class' &&
      q.atom === atom &&
      q.seq < seq &&
      q.final &&
      q.outcome.kind === 'pass',
  );
}

/**
 * The class a kept Proposal should have opened at, by a model of #116's rule: entrenched for a
 * class Proposal, and for a change or move of a section whose last passed class Proposal before
 * it made it entrenched; ordinary otherwise. A kept Proposal on a section never overlaps a class
 * Proposal on it, so every earlier one had closed by the time it opened.
 */
function classAtOpening(proposals: readonly Proposal[], p: Proposal): 'ordinary' | 'entrenched' {
  const { kind } = p.target;
  if (kind === 'class') return 'entrenched';
  if (kind !== 'edit' && kind !== 'move') return 'ordinary';
  const last = passedClassesBefore(proposals, p.atom, p.seq).at(-1)?.target;
  return last?.kind === 'class' && last.to === 'entrenched' ? 'entrenched' : 'ordinary';
}

/**
 * One step of a log built around section classes (#116): a class Proposal, a change, a removal or a
 * move of one of three sections, which both members then pass, fail or leave open, after a wait.
 */
const classStep = fc.record({
  kind: fc.constantFrom('class', 'class', 'edit', 'remove', 'move'),
  section: fc.nat({ max: 2 }),
  to: fc.constantFrom('ordinary', 'entrenched', 'entrenched', 'eternal'),
  ballots: fc.constantFrom('pass', 'pass', 'fail', 'none'),
  wait: fc.integer({ min: 0, max: 30_000 }),
});

/** A random log of class Proposals and Proposals on the same sections (#116), and a relay time. */
const classLog = fc
  .record({ steps: fc.array(classStep, { maxLength: 12 }), after: fc.nat({ max: 30_000 }) })
  .map(({ steps, after }) => {
    const log = Log.founded(2, FIRST_SECTIONS);
    let received = R + 10;
    for (const s of steps) {
      received += s.wait;
      const atom = `${log.group}.${String(s.section)}`;
      const proposal =
        s.kind === 'class'
          ? log.classify(received, atom, s.to)
          : s.kind === 'move'
            ? log.move(received, atom, null)
            : log.propose(received, atom, s.kind === 'remove' ? '' : `New ${String(s.wait)}`);
      if (s.ballots === 'none') continue;
      const score = s.ballots === 'pass' ? 4 : 2;
      log.vote(received + 1, 0, proposal, score);
      log.vote(received + 2, 1, proposal, score);
    }
    return { records: log.records, relayNow: received + after };
  });

/** Random logs of every kind, and logs built around section classes (#116). */
const anyLog = fc.oneof(arbitraryLog, classLog);

describe('properties of section classes (#116)', { timeout: 120_000 }, () => {
  it('opens every Proposal at the class a model of the rule gives: entrenched for a class Proposal, and for a change, removal or move of an entrenched section', () => {
    fc.assert(
      fc.property(anyLog, ({ records, relayNow }) => {
        const { proposals, rules } = fold(records, relayNow);
        for (const p of proposals) {
          expect(p.class).toBe(classAtOpening(proposals, p));
          expect(p.outcome.bar).toEqual(rules.bars[p.class]);
        }
      }),
    );
  });

  it('gives each section the class of its last passed class Proposal, in close order, or ordinary', () => {
    fc.assert(
      fc.property(anyLog, ({ records, relayNow }) => {
        const { atoms, proposals } = fold(records, relayNow);
        for (const atom of atoms) {
          const passed = passedClassesBefore(proposals, atom.id, Number.POSITIVE_INFINITY);
          const closed = [...passed].sort((a, b) => closeTime(a) - closeTime(b));
          const last = closed.at(-1)?.target;
          expect(atom.class).toBe(last?.kind === 'class' ? last.to : 'ordinary');
        }
      }),
    );
  });

  it('keeps an eternal section for good: it stays, eternal, and no Proposal on it opens after the one that made it so', () => {
    fc.assert(
      fc.property(anyLog, ({ records, relayNow }) => {
        const { atoms, proposals } = fold(records, relayNow);
        const eternal = proposals.filter(
          (q) =>
            q.target.kind === 'class' &&
            q.target.to === 'eternal' &&
            q.final &&
            q.outcome.kind === 'pass',
        );
        for (const q of eternal) {
          expect(atoms.find((atom) => atom.id === q.atom)?.class).toBe('eternal');
          expect(proposals.filter((p) => p.atom === q.atom && p.seq > q.seq)).toEqual([]);
        }
      }),
    );
  });

  it('makes sections entrenched and eternal often enough in its logs to test the rule', () => {
    const samples = fc.sample(classLog, { numRuns: 200, seed: 116 });
    const states = samples.map(({ records, relayNow }) => fold(records, relayNow));
    const eternal = states.filter((state) => state.atoms.some((a) => a.class === 'eternal'));
    const entrenched = states.filter((state) =>
      state.proposals.some((p) => p.class === 'entrenched' && p.target.kind !== 'class'),
    );
    expect(eternal.length).toBeGreaterThan(20);
    expect(entrenched.length).toBeGreaterThan(20);
  });
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

const { ordinary: ORDINARY, entrenched: ENTRENCHED } = DEFAULT_RULES.bars;

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
        for (const bar of [ORDINARY, ENTRENCHED] satisfies Bar[]) {
          const first = tally({ ...ballots(eligible, versions, rows), bar });
          const second = tally({ ...ballots(eligible, versions, shuffled), bar });
          expect(second).toEqual(first);
        }
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

/** One event of a ballot-expiry scenario before it is signed: when it arrives, who signs it, what. */
interface Planned {
  readonly received: number;
  readonly author: string;
  readonly input: Unstamped;
}

/** Signs `planned` in relay order (stable by receipt minute) into a log of `group`. */
function signAll(group: string, genesis: LogRecord, planned: readonly Planned[]): LogRecord[] {
  const ordered = [...planned].sort((a, b) => a.received - b.received);
  return [
    genesis,
    ...ordered.map(({ received, author, input }, i) => {
      const draft = { ...input, group, ts: received * 60_000 };
      return { seq: i + 2, received, bytes: signedAs(author, draft).record };
    }),
  ];
}

/** What two devices must agree on: the Document, and each Proposal's ballot, close and outcome. */
function decided(state: GroupState) {
  return {
    atoms: state.atoms,
    proposals: state.proposals.map((p) => ({
      id: p.id,
      versions: p.versions,
      eligible: p.eligible,
      deadline: p.deadline,
      closedAt: p.closedAt,
      final: p.final,
      outcome: p.outcome,
      result: p.result?.id ?? null,
    })),
  };
}

/** A ballot-expiry scenario: members, extra versions and ballots on P, then a later Proposal Q. */
const expiryScenario = fc.record({
  count: fc.integer({ min: 1, max: 5 }),
  // Each extra version arrives `at` minutes in; a removal's text is `""` (#75).
  versions: fc.array(fc.record({ at: fc.integer({ min: 0, max: 40 }), removal: fc.boolean() }), {
    maxLength: 3,
  }),
  ballots: fc.array(
    fc.record({
      voter: fc.nat({ max: 4 }),
      at: fc.integer({ min: 0, max: 40 }),
      scores: fc.array(fc.option(score, { nil: null }), { minLength: 3, maxLength: 3 }),
    }),
    { maxLength: 12 },
  ),
  again: fc.option(
    fc.record({
      after: fc.integer({ min: 0, max: 30 }),
      votes: fc.array(fc.record({ voter: fc.nat({ max: 4 }), value: score }), { maxLength: 5 }),
    }),
    { nil: null },
  ),
  resultDelay: fc.integer({ min: 1, max: 60 }),
  later: fc.integer({ min: 0, max: 30_000 }),
});

describe('properties of ballot expiry', { timeout: 60_000 }, () => {
  it('folds the same Atoms and outcomes from the cleared log as from the full one', () => {
    fc.assert(
      fc.property(expiryScenario, (scenario) => {
        const start = Log.founded(scenario.count);
        const group = start.group;
        const [genesis, ...joins] = start.records;
        if (genesis === undefined) throw new Error('Expected a genesis.');
        const p0 = R + 20;
        const proposalInput: Unstamped = {
          type: 'proposal',
          body: { atom: `${group}.0`, title: 'T', why: 'W', text: 'P text' },
        };
        const pId = signedAs(member(0), { ...proposalInput, group, ts: p0 * 60_000 }).id;
        const planned: Planned[] = joins.map((record, i) => ({
          received: record.received,
          author: member(i + 1),
          input: { type: 'join', body: { name: member(i + 1) } },
        }));
        planned.push({ received: p0, author: member(0), input: proposalInput });
        const versionIds = [pId];
        scenario.versions.forEach(({ at, removal }, v) => {
          const text = removal ? '' : `Version ${String(v + 2)}`;
          const input: Unstamped = { type: 'version', body: { proposal: pId, text } };
          const received = p0 + at;
          planned.push({ received, author: member(0), input });
          versionIds.push(signedAs(member(0), { ...input, group, ts: received * 60_000 }).id);
        });
        let last = p0;
        for (const ballot of scenario.ballots) {
          const scores = Object.fromEntries(
            ballot.scores.flatMap((value, v) =>
              value === null || versionIds[v] === undefined ? [] : [[versionIds[v], value]],
            ),
          );
          const note = Object.values(scores).includes(0) ? { note: 'A reason.' } : {};
          const salt = { salt: `salt-${String(ballot.voter)}-${String(ballot.at)}` };
          const received = p0 + ballot.at;
          last = Math.max(last, received);
          planned.push({
            received,
            author: member(ballot.voter % scenario.count),
            input: { type: 'vote', body: { proposal: pId, scores, ...note, ...salt } },
          });
        }
        if (scenario.again !== null) {
          // Q follows every ballot on P, so in P's closing minute it comes after the closing ballot.
          const q0 = last + scenario.again.after;
          const qInput: Unstamped = {
            type: 'proposal',
            body: { atom: `${group}.0`, title: 'Q', why: 'W', text: 'Q text' },
          };
          planned.push({ received: q0, author: member(0), input: qInput });
          const qId = signedAs(member(0), { ...qInput, group, ts: q0 * 60_000 }).id;
          scenario.again.votes.forEach(({ voter, value }, i) => {
            const note = value === 0 ? { note: 'A reason.' } : {};
            planned.push({
              received: q0 + 1 + i,
              author: member(voter % scenario.count),
              input: { type: 'vote', body: { proposal: qId, scores: { [qId]: value }, ...note } },
            });
          });
        }
        const before = signAll(group, genesis, planned);
        const deadline = p0 + WINDOW;
        const p = fold(before, deadline + 1).proposals.find((candidate) => candidate.id === pId);
        if (p === undefined) throw new Error('Expected P to open.');
        // A device posts P's result once the relay's minute is past P's close.
        const resultAt = (p.closedAt ?? p.deadline) + scenario.resultDelay;
        planned.push({
          received: resultAt,
          author: member(0),
          input: { type: 'result', body: resultFor(p) },
        });
        const full = signAll(group, genesis, planned);
        const cleared = full.filter((record) => {
          const event = parseRecord(record.bytes)?.event;
          return event === undefined || event.type !== 'vote' || expiringProposal(event) !== pId;
        });
        const now = Math.max(resultAt, ...full.map((record) => record.received)) + scenario.later;
        const held = fold(full, now);
        expect(held.proposals.find((candidate) => candidate.id === pId)?.result).not.toBeNull();
        expect(decided(fold(cleared, now, [], [pId]))).toEqual(decided(held));
      }),
    );
  });

  it('gives the same commitment whatever order distinct voters’ ballots arrive in', () => {
    const scenario = electorate.chain(({ count, ballots }) =>
      fc.record({
        count: fc.constant(count),
        first: fc.constant(ballots),
        second: fc.shuffledSubarray(ballots, { minLength: ballots.length }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ count, first, second }) => {
        const commitOf = (order: readonly { voter: number; value: Score }[]) => {
          const log = Log.founded(count);
          const proposal = log.propose(R + 20, `${log.group}.0`, 'New text');
          order.forEach(({ voter, value }, i) => log.vote(R + 30 + i, voter, proposal, value));
          const p = fold(log.records, R + WINDOW + 100).proposals[0];
          if (p === undefined) throw new Error('Expected the Proposal.');
          return heldRecord(p);
        };
        const { commit, versions } = commitOf(first);
        expect(commitOf(second)).toMatchObject({ commit, versions });
      }),
    );
  });
});

/**
 * A priority ballot set (#107): 2 to 7 options, and each voter's row scores some of them (null:
 * not scored). The eligible count is at least the number of voters.
 */
const prioritySet = fc
  .record({
    options: fc.integer({ min: OPTIONS_MIN, max: OPTIONS_MAX }),
    rows: fc.array(
      fc.array(fc.option(score, { nil: null }), {
        minLength: OPTIONS_MAX,
        maxLength: OPTIONS_MAX,
      }),
      { maxLength: 30 },
    ),
    absent: fc.nat({ max: 30 }),
  })
  .map(({ options, rows, absent }) => ({
    eligible: rows.length + absent,
    rows: rows.map((row) => row.slice(0, options)),
    options,
  }));

describe('properties of the ranking (#107)', () => {
  it('starts with tally()’s winner, and is empty exactly when nothing passes', () => {
    fc.assert(
      fc.property(prioritySet, ({ eligible, options, rows }) => {
        const input = { ...ballots(eligible, options, rows), bar: ORDINARY };
        const outcome = tally(input);
        const [first] = rank(input);
        expect(first?.id).toBe(outcome.kind === 'pass' ? outcome.version : undefined);
      }),
    );
  });

  it('holds every option that passes at quorum, and only those, best first', () => {
    fc.assert(
      fc.property(prioritySet, ({ eligible, options, rows }) => {
        const input = { ...ballots(eligible, options, rows), bar: ORDINARY };
        const ranking = rank(input);
        const passing = input.versions.filter((option) => {
          const n = option.scores.length;
          const sum = option.scores.reduce((total, s) => total + s, 0);
          const zeros = option.scores.filter((s) => s === 0).length;
          const quorum = Math.max(
            1,
            Math.min(eligible, Math.max(3, Math.ceil((3 * eligible) / 10))),
          );
          return n >= quorum && sum / n >= 2 && zeros / n < 0.1;
        });
        expect(ranking.map((option) => option.id).sort()).toEqual(
          passing.map((option) => option.id).sort(),
        );
        for (const option of ranking)
          expect(option).toMatchObject({ atQuorum: true, passes: true });
        // Each option is at least as good as the next: a higher average, or an equal one with no
        // more zeros, and an exact tie keeps ballot order.
        const at = (id: string) => input.versions.findIndex((option) => option.id === id);
        ranking.slice(1).forEach((next, i) => {
          const prev = ranking[i];
          if (prev === undefined) throw new Error('Expected the previous option.');
          const left = prev.sum * next.scorers;
          const right = next.sum * prev.scorers;
          expect(left).toBeGreaterThanOrEqual(right);
          if (left === right) expect(prev.zeros).toBeLessThanOrEqual(next.zeros);
          if (left === right && prev.zeros === next.zeros) {
            expect(at(prev.id)).toBeLessThan(at(next.id));
          }
        });
      }),
    );
  });

  it('gives the same ranking whatever order the ballots arrive in', () => {
    const scenario = prioritySet.chain((set) =>
      fc.record({
        set: fc.constant(set),
        shuffled: fc.shuffledSubarray([...set.rows], { minLength: set.rows.length }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ set: { eligible, options, rows }, shuffled }) => {
        const first = rank({ ...ballots(eligible, options, rows), bar: ORDINARY });
        const second = rank({ ...ballots(eligible, options, shuffled), bar: ORDINARY });
        expect(second).toEqual(first);
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
          documents: [{ title: `Rules ${mark}`, atoms: [mark] }],
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
