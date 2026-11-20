/**
 * Properties of the fold (fast-check): every device that folds the same relay
 * records builds the same state, the Document changes only on a final pass, a level change
 * or a leave never reaches back into a Proposal that's already open, a member who has left
 * acts no more, an Atom never has two open Proposals or a ballot more than three versions,
 * and adds and section removals (#75) only ever add or take out whole Atoms. And of the bars (#94):
 * the entrenched bar is never easier than the ordinary one, and neither depends on the order
 * ballots arrive in. And of windows (#106): a Proposal opens only for a window its class
 * allows, and runs exactly that long. And of epochs (#98): a record read from another epoch's
 * mailbox changes nothing, not even relay time, and a leave stranded in the old mailbox after a
 * key change ends a membership only through its copy in the new one, so a device that never
 * read the old copy folds the same (#225). And of removal (#115): nothing the member a
 * removal names sends on it counts, they are taken out once whoever posts the remove, and after
 * the pass only their leave counts; removal's bar is never harder than the entrenched one and
 * never depends on ballot order. And of coalitions (#100): a motion's outcome doesn't depend on
 * the order distinct seats' results arrive in, and nothing a group reports carries a name, note,
 * score or key from inside it. And of a priority vote's ranking (#107): it holds exactly the
 * options that pass, best first, its first is always the tally's winner, and the order ballots
 * arrive in never changes it. And of ballot expiry (#111): a device that has cleared a closed
 * Proposal's ballots, keeping its result, folds the same Document and outcomes as one that still
 * holds them, even for an event in the closing minute before the closing ballot (#289), and reads
 * the same section history. And of section history (#104): replaying a section's passed texts,
 * oldest first, ends at its current text or its removal, and a Document's change log holds each
 * final pass once. And of the front door (#288): no door ever stands whose secrets a record
 * sealed under a key someone who has left held carried, whatever order Proposals, ballots, leaves
 * and key changes come in. And of moves (#103): passed moves only ever reorder a Document,
 * keeping its Atom ids and their bytes, and every device that folds the same records builds the
 * same order, which follows close time, then the moves' relay order, whatever order their ballots
 * arrive in. And of section classes (#116): every Proposal on a section opens at the class its
 * section's last passed class Proposal gave it, a section's class is that Proposal's, and once a
 * section is eternal no Proposal on it ever opens again.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  folded,
  foldLogs,
  Logs,
  NestedLogs,
  type NestedSeat,
  seatKey,
  seatOf,
} from '../test/coalitions';
import { doorOf } from '../test/door';
import { authorOf, signedAs, testKx } from '../test/keys';
import { LEVELS } from './capabilities';
import { coalitionOutcome, HORIZON_STEP_MINUTES } from './coalition';
import { resultsToReport, seatIn } from './crossing';
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
import { changeLog, sectionHistory } from './history';
import { type FrontDoor, isFrontDoor } from './optIns';
import { OPTIONS_MAX, OPTIONS_MIN } from './priority';
import { type Bar, DAY_MINUTES, DEFAULT_RULES, defaultWindowMinutes, validWindow } from './rules';
import { rank, tally, tallyDetail, type TallyInput } from './tally';

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
  /** The epoch whose mailboxes the next record is read from (#98). */
  epoch = 0;

  /** Appends `input`, signed by `author`'s test key. */
  add(received: number, author: string, input: Unstamped): string {
    const draft = { ...input, group: this.group, ts: received * 60_000 };
    const { record, id } = signedAs(author, draft);
    const epoch = this.epoch === 0 ? {} : { epoch: this.epoch };
    this.records.push({ seq: this.records.length + 1, received, bytes: record, ...epoch });
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

/** An opaque recovery share's box (#109): the fold never opens one, so any base64url will do. */
const SHARE_BOX = 'c2hhcmUtYm94';

/** A 16-byte alert tag, as a recovery-cancel names one (#118). */
const ALERT_TAG = 'YWxlcnQtdGFnLTE2Ynl0ZQ';

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
  'recovery-share': (log, at, who, _value, { count }) =>
    log.add(at, member(who % count), { type: 'recovery-share', body: { box: SHARE_BOX } }),
  'recovery-alert': (log, at, who, _value, { count }) =>
    log.add(at, member(who % count), { type: 'recovery-alert', body: { box: SHARE_BOX } }),
  'recovery-cancel': (log, at, who, _value, { count }) =>
    log.add(at, member(who % count), { type: 'recovery-cancel', body: { alert: ALERT_TAG } }),
} satisfies Record<
  string,
  (log: Log, at: number, who: number, value: Score, context: LateContext) => string
>;

/** The kinds of late event, for fast-check to pick from. */
const LATE_KINDS = Object.keys(LATE) as (keyof typeof LATE)[];

/** A step of the front door property (#288). */
type DoorStep =
  | { readonly kind: 'propose'; readonly door: number }
  | { readonly kind: 'vote' }
  | { readonly kind: 'leave'; readonly who: number }
  | { readonly kind: 'rotate' }
  | { readonly kind: 'wait' };

/** What the front door property plays on: a log, its size, the relay minute, and the latest Proposal. */
interface DoorPlay {
  readonly log: Log;
  readonly count: number;
  at: number;
  latest: string;
}

/**
 * Plays one step a minute after the last: member 0 proposes one of three
 * doors, everyone scores the latest Proposal 4, a member other than the
 * founder leaves, member 0 changes the key into the next epoch (#98), from
 * which later records are read when it lands, or an entrenched window passes.
 */
function playDoorStep(play: DoorPlay, step: DoorStep): void {
  const { log, count } = play;
  play.at += 1;
  switch (step.kind) {
    case 'propose': {
      const value = doorOf(0x10 + step.door, 0x20 + step.door);
      const body = { target: { kind: 'rules', optIn: 'frontDoor', value }, title: 'T', why: 'W' };
      play.latest = log.add(play.at, member(0), { type: 'proposal', body } as Unstamped);
      return;
    }
    case 'vote':
      for (let voter = 0; voter < count; voter += 1) log.vote(play.at, voter, play.latest, 4);
      return;
    case 'leave':
      log.leave(play.at, 1 + (step.who % (count - 1)));
      return;
    case 'rotate':
      log.add(play.at, member(0), {
        type: 'key-rotate',
        body: { ...LATE_ROTATE, epoch: log.epoch + 1 },
      });
      log.epoch = fold(log.records, play.at).epoch;
      return;
    case 'wait':
      play.at += defaultWindowMinutes(DEFAULT_RULES, 'entrenched');
  }
}

/** The front door a record's rules Proposal carries, whether the fold applied it or not, or null. */
function doorCarriedBy(record: LogRecord): FrontDoor | null {
  const event = parseRecord(record.bytes)?.event;
  if (event?.type !== 'proposal' || !('target' in event.body)) return null;
  const { target } = event.body;
  return target.kind === 'rules' && isFrontDoor(target.value) ? target.value : null;
}

/**
 * Expects that no record carrying either secret of the door standing in
 * `state` was sealed under a key anyone who left held: each was read from a
 * later epoch than every leave the fold applied.
 */
function expectNoExposedDoor(log: Log, state: GroupState): void {
  const standing = state.rules.optIns.frontDoor;
  if (standing === false) return;
  const ignored = new Set(state.ignored.map((record) => record.seq));
  const leaves = log.records.filter(
    (record) => !ignored.has(record.seq) && parseRecord(record.bytes)?.event.type === 'leave',
  );
  const carriers = log.records.filter((record) => {
    const carried = doorCarriedBy(record);
    return carried?.sign === standing.sign || carried?.box === standing.box;
  });
  for (const leave of leaves) {
    for (const carrier of carriers) expect(carrier.epoch ?? 0).toBeGreaterThan(leave.epoch ?? 0);
  }
}

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

  it('ends a membership whose leave was stranded after a key change only where its copy reaches the new mailbox, alike with or without the old copy (#225)', () => {
    const scenario = fc.record({
      count: fc.integer({ min: 3, max: 6 }),
      who: fc.nat(),
      proposalFirst: fc.boolean(),
      gap: fc.integer({ min: 0, max: 3 * DAY_MINUTES }),
    });
    fc.assert(
      fc.property(scenario, ({ count, who, proposalFirst, gap }) => {
        const log = Log.founded(count);
        log.leave(R + 1, count - 1);
        log.add(R + 2, member(0), { type: 'key-rotate', body: LATE_ROTATE });
        const leaver = 1 + (who % (count - 2));
        const stranded = log.leave(R + 3, leaver);
        // A Proposal in the new mailbox lands before the copy, or after it.
        log.propose(proposalFirst ? R + 4 : R + 5 + gap, `${log.group}.0`, 'New text');
        const [rotated, leave, proposal] = [log.records.slice(0, -2), ...log.records.slice(-2)];
        if (leave === undefined || proposal === undefined) throw new Error('two records');
        const copyAt = proposalFirst ? R + 5 + gap : R + 4;
        const copy = { seq: 0, received: copyAt, bytes: leave.bytes, epoch: 1 };
        const newer = { ...proposal, epoch: 1 };
        const ordered = proposalFirst ? [newer, copy] : [copy, newer];
        const after = ordered.map((record, i) => ({ ...record, seq: leave.seq + 1 + i }));
        const now = R + 10 * DAY_MINUTES;
        const both = fold([...rotated, leave, ...after], now);
        const copyOnly = fold([...rotated, ...after], now);
        expect({ ...both, ignored: [] }).toEqual({ ...copyOnly, ignored: [] });
        expect(both.former.map((m) => m.author)).toContain(authorOf(member(leaver)));
        expect([both.epoch, both.rotationDue, both.stranded]).toEqual([1, true, []]);
        const withoutCopy = after.filter((record) => record.bytes !== leave.bytes);
        const alone = fold([...rotated, leave, ...withoutCopy], now);
        expect(alone.stranded).toEqual([
          {
            id: stranded,
            seq: leave.seq,
            author: authorOf(member(leaver)),
            member: authorOf(member(leaver)),
          },
        ]);
        expect({ ...alone, ignored: [], stranded: [] }).toEqual({
          ...fold([...rotated, ...withoutCopy], now),
          ignored: [],
        });
      }),
    );
  });

  /** Each recovery event (#109, #118), its body, and the one field of the state it may change. */
  const RECOVERY = [
    { type: 'recovery-share', body: { box: SHARE_BOX }, field: 'recoveryShares' },
    { type: 'recovery-alert', body: { box: SHARE_BOX }, field: 'recoveryAlerts' },
    { type: 'recovery-cancel', body: { alert: ALERT_TAG }, field: 'recoveryCancels' },
  ] as const;

  it.each(RECOVERY)(
    'keeps a $type from anyone, wherever it lands, out of everything but $field (#109, #118)',
    ({ type, body, field }) => {
      const scenario = arbitraryLog.chain((log) =>
        fc.record({
          log: fc.constant(log),
          who: fc.integer({ min: 0, max: 5 }),
          at: fc.nat({ max: log.records.length }),
        }),
      );
      fc.assert(
        fc.property(scenario, ({ log: { records, relayNow }, who, at }) => {
          const group = fold(records, null).group ?? '';
          const draft = { type, group, ts: 0, body } as EventDraft;
          const { record, id } = signedAs(member(who), draft);
          // A well-shaped event, so it is kept unless its author isn't a member there.
          expect(parseRecord(record)).not.toBeNull();
          // It lands at its neighbour's receipt, so relay time moves no further than without it.
          const received = records[at]?.received ?? records.at(-1)?.received ?? R;
          const posted = { seq: 0, received, bytes: record };
          const state = fold([...records.slice(0, at), posted, ...records.slice(at)], relayNow);
          const without = fold(records, relayNow);
          const apart = { ignored: [], [field]: [] };
          expect({ ...state, ...apart }).toEqual({ ...without, ...apart });
          const kept = state[field].map((entry) => entry.id);
          const ignored = state.ignored.some((entry) => entry.seq === 0);
          expect(kept).toEqual(ignored ? [] : [id]);
        }),
      );
    },
  );

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

  it('never lets a front door stand whose secrets someone who has left could read (#288)', () => {
    const step = fc.oneof(
      fc.record({ kind: fc.constant('propose' as const), door: fc.nat({ max: 2 }) }),
      fc.record({ kind: fc.constant('vote' as const) }),
      fc.record({ kind: fc.constant('leave' as const), who: fc.nat({ max: 2 }) }),
      fc.record({ kind: fc.constant('rotate' as const) }),
      fc.record({ kind: fc.constant('wait' as const) }),
    );
    const scenario = fc.record({
      count: fc.integer({ min: 3, max: 4 }),
      steps: fc.array(step, { maxLength: 10 }),
    });
    fc.assert(
      fc.property(scenario, ({ count, steps }) => {
        const play: DoorPlay = { log: Log.founded(count), count, at: R + 20, latest: '' };
        for (const next of steps) playDoorStep(play, next);
        expectNoExposedDoor(play.log, fold(play.log.records, play.at + 1));
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

/** One Proposal of a section-history scenario (#104): its kind, what it picks, its text, three ballots and a wait. */
const historyStep = fc.record({
  kind: fc.constantFrom<InDocument['kind']>('edit', 'remove', 'add', 'new-document'),
  pick: fc.nat(),
  first: fc.boolean(),
  text: fc.constantFrom('X', 'Y\n', '# Z\n\nW', 'V\n\nU\n\nT'),
  scores: fc.array(fc.option(score, { nil: null }), { minLength: 3, maxLength: 3 }),
  wait: fc.oneof(fc.integer({ min: 1, max: 60 }), fc.constant(WINDOW + 10)),
});

/**
 * A log of three members and two founded Documents, then one Proposal per
 * step in a Document's section, or a new Document, each scored by up to three
 * ballots, folded once every Proposal has closed.
 */
const historyLog = fc.array(historyStep, { maxLength: 12 }).map((steps) => {
  const log = Log.founded(3, FIRST_SECTIONS, [{ title: 'Second', atoms: SECOND_SECTIONS }]);
  let received = R + 10;
  for (const s of steps) {
    const now = fold(log.records, received);
    const target = now.documents[s.pick % now.documents.length]?.id ?? log.group;
    const sections = now.atoms.filter((atom) => atom.documentId === target);
    const section = sections[s.pick % Math.max(1, sections.length)]?.id ?? `${target}.0`;
    const proposal = proposeIn(log, { ...s, target, section }, received);
    s.scores.forEach((value, voter) => {
      if (value !== null) log.vote(received + 1 + voter, voter, proposal, value);
    });
    received += 4 + s.wait;
  }
  return fold(log.records, received + WINDOW + 10);
});

/** Every section id a history scenario could have made: founded, added, or a new Document's. */
function everySection(state: GroupState): string[] {
  const founded = state.founding?.atoms.map((atom) => atom.id) ?? [];
  const made = state.proposals.flatMap((p) => {
    if (p.target.kind === 'add') return [p.id];
    if (p.target.kind !== 'new-document') return [];
    return [0, 1, 2, 3].map((i) => `${p.id}.${String(i)}`);
  });
  return [...founded, ...made];
}

describe('properties of section history (#104)', { timeout: 60_000 }, () => {
  it('replays a section’s passed texts, oldest first, to its current text or its removal', () => {
    fc.assert(
      fc.property(historyLog, (state) => {
        for (const id of everySection(state)) {
          const oldestFirst = [...sectionHistory(state, id).passed].reverse();
          const now = state.atoms.find((atom) => atom.id === id);
          if (oldestFirst.length === 0) {
            expect(now, id).toBeUndefined();
            continue;
          }
          expect(['founded', 'added', 'created']).toContain(oldestFirst[0]?.change.kind);
          expect(oldestFirst.slice(1).map((entry) => entry.change.kind)).not.toContain('founded');
          expect(oldestFirst.at(-1)?.text, id).toBe(now?.text ?? '');
          const dates = oldestFirst.map((entry) => entry.decidedAt);
          expect(dates).toEqual([...dates].sort((a, b) => a - b));
        }
      }),
    );
  });

  it('logs each final pass once, in the Document it changed, opening a history that holds it', () => {
    fc.assert(
      fc.property(historyLog, (state) => {
        const rows = state.documents.flatMap((document) => changeLog(state, document.id));
        const logged = rows.flatMap((row) => (row.proposalId === null ? [] : [row.proposalId]));
        const passed = state.proposals.filter((p) => p.final && p.outcome.kind === 'pass');
        expect([...logged].sort()).toEqual(passed.map((p) => p.id).sort());
        for (const row of rows) {
          if (row.section === null) continue;
          const history = sectionHistory(state, row.section).passed;
          expect(history.map((entry) => entry.proposalId)).toContain(row.proposalId);
        }
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

/** One Proposal at `at` (R + 20 by default) in the Document `target` (#92), or a new Document beside it. */
function proposeIn(
  log: Log,
  { kind, target, section, first, text }: InDocument,
  at = R + 20,
): string {
  if (kind === 'edit') return log.propose(at, section, text);
  if (kind === 'remove') return log.propose(at, section, '');
  if (kind === 'add') return log.addSection(at, first ? null : section, text, target);
  return log.newDocument(at, 'New', text);
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
        const after = fold(cleared, now, [], [pId]);
        expect(decided(after)).toEqual(decided(held));
        // A section's history shows totals and never a ballot, so it reads the same (#104).
        expect(sectionHistory(after, `${group}.0`)).toEqual(sectionHistory(held, `${group}.0`));
      }),
    );
  });

  it('folds the same from the cleared log wherever a Proposal on the same Atom falls in the closing minute (#289)', () => {
    const scenario = fc.record({
      count: fc.integer({ min: 2, max: 3 }),
      ballots: fc.array(fc.record({ at: fc.integer({ min: 1, max: 3 }), value: score }), {
        minLength: 3,
        maxLength: 3,
      }),
      anchor: fc.nat(),
      slot: fc.nat(),
    });
    fc.assert(
      fc.property(scenario, ({ count, ballots, anchor, slot }) => {
        const start = Log.founded(count);
        const group = start.group;
        const [genesis] = start.records;
        if (genesis === undefined) throw new Error('Expected a genesis.');
        const p0 = R + 20;
        const pInput: Unstamped = {
          type: 'proposal',
          body: { atom: `${group}.0`, title: 'P', why: 'W', text: 'P text' },
        };
        const pId = signedAs(member(0), { ...pInput, group, ts: p0 * 60_000 }).id;
        const planned: Planned[] = start.records.slice(1).map((record, i) => ({
          received: record.received,
          author: member(i + 1),
          input: { type: 'join', body: { name: member(i + 1) } },
        }));
        planned.push({ received: p0, author: member(0), input: pInput });
        const after = planned.length;
        // Everyone scores P once, so its last ballot in relay order closes it early.
        const voters = ballots.slice(0, count);
        voters.forEach(({ at, value }, i) => {
          const note = value === 0 ? { note: 'A reason.' } : {};
          const body = {
            proposal: pId,
            scores: { [pId]: value },
            ...note,
            salt: `salt-${String(i)}`,
          };
          planned.push({ received: p0 + at, author: member(i), input: { type: 'vote', body } });
        });
        // Q lands in some ballot's minute, before or after any of P's ballots in relay order.
        const qAt = p0 + (voters[anchor % count]?.at ?? 0);
        const qInput: Unstamped = {
          type: 'proposal',
          body: { atom: `${group}.0`, title: 'Q', why: 'W', text: 'Q text' },
        };
        planned.splice(after + (slot % (count + 1)), 0, {
          received: qAt,
          author: member(0),
          input: qInput,
        });
        const p = fold(signAll(group, genesis, planned), p0 + WINDOW).proposals.find(
          (candidate) => candidate.id === pId,
        );
        if (p === undefined || p.closedAt === null) throw new Error('Expected P to close early.');
        const resultAt = p.closedAt + 1;
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
        const now = resultAt + 1;
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
          const now = expired ? deadline + HORIZON_STEP_MINUTES : deadline;
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

/** A result a seat may report, or none. */
const maybeResult = fc.option(fc.constantFrom<'pass' | 'fail'>('pass', 'fail'), { nil: null });

/** What a lower seat reports on a motion (#375): a pass, a fail, both (a contest), or nothing. */
type LowerReport = 'pass' | 'fail' | 'contest' | null;

/** A {@link LowerReport}. */
const lowerReport = fc.constantFrom<LowerReport>('pass', 'fail', 'contest', null);

/** The results a seat posts for `report`, a contest's pass before its fail. */
function reportsOf(report: LowerReport): ('pass' | 'fail')[] {
  if (report === null) return [];
  return report === 'contest' ? ['pass', 'fail'] : [report];
}

/** The result a seat counts as for `report`: a contest counts as a fail (`seatResult`). */
function seatValue(report: LowerReport): 'pass' | 'fail' | null {
  return report === 'contest' ? 'fail' : report;
}

/** The outcome kind `results` reach over `seats` seats, as `coalitionOutcome` decides it. */
function outcomeOver(results: readonly ('pass' | 'fail' | null)[], expired: boolean) {
  const passes = results.filter((r) => r === 'pass').length;
  const fails = results.filter((r) => r === 'fail').length;
  return coalitionOutcome({ seats: results.length, passes, fails, expired }).kind;
}

const STATEMENT_D = { name: 'Metro Renters', title: 'Shared ground', atoms: ['Rent stays fair.'] };

const STATEMENT_F = { name: 'State Renters', title: 'Shared ground', atoms: ['Renters have a voice.'] };

/** The text F's motion gives its first section in the staggered property (#387). */
const STAGGERED_TEXT = 'Renters have a voice everywhere.';

/** The draws a time is picked from, as a fraction of its span: 0 to DRAW − 1. */
const DRAW = 10_000;

/** How many report times a run draws: enough for every seat at every level to contest. */
const TIMES = 32;

/**
 * When things land in one run of the staggered property (#387): a draw for
 * each report, in seat order, a contest's pass before its fail; extra minutes
 * at which C's devices cross up to D (`crossC`) and D's up to F (`crossD`),
 * anywhere while the motion is open above; and where in the day between its
 * own horizon and the level above's each level's devices cross once more
 * (`lastC`, `lastD`), as some device of theirs always does.
 */
interface StaggeredTiming {
  readonly times: readonly number[];
  readonly crossC: readonly number[];
  readonly crossD: readonly number[];
  readonly lastC: number;
  readonly lastD: number;
}

/**
 * One run of the staggered property (#387): what C's seats report, what D's
 * seats besides C's report (`middle`), what F's besides D's report (`upper`),
 * and two timings to compare.
 */
interface StaggeredRun {
  readonly lower: readonly LowerReport[];
  readonly middle: readonly LowerReport[];
  readonly upper: readonly LowerReport[];
  readonly first: StaggeredTiming;
  readonly second: StaggeredTiming;
}

/** One step of a staggered run: a seat's report in a coalition, or a lower log's devices crossing up. */
type StaggeredStep =
  | {
      readonly at: number;
      readonly kind: 'report';
      readonly log: string;
      readonly who: string;
      readonly seat: string;
      readonly result: 'pass' | 'fail';
    }
  | { readonly at: number; readonly kind: 'cross'; readonly lower: string; readonly upper: string };

/** The participant bound to each lower log's seat in the log above it, who posts its results there. */
const CROSSER: Readonly<Record<string, string>> = { C: 'q', D: 'r' };

/** The minute a draw `n` picks in `[start, end)`. */
function within(n: number, start: number, end: number): number {
  return start + Math.floor((n * (end - start)) / DRAW);
}

/** Seat names and participants for a level's seats: `L0`, `l0`, and so on. */
function seatsNamed(reports: readonly LowerReport[], seat: string, who: string) {
  return reports.map((_, i) => ({ seat: `${seat}${String(i)}`, who: `${who}${String(i)}` }));
}

/**
 * Three levels for the staggered property (#387): C of `run.lower`'s seats;
 * D of C and `run.middle`'s; F of D and `run.upper`'s, each formed, and each
 * coalition's seat above passed by every seat beneath it. Returns F's motion,
 * received at R + 30, which opens in D and, through D, in C.
 */
function staggeredNest(logs: NestedLogs, run: StaggeredRun): string {
  const c = seatsNamed(run.lower, 'L', 'l');
  logs.formedIn('C', R, c.map((s) => [s.seat] as const), c.map((s) => s.who));
  const intoD = logs.sealedInto('C', R + 3, 'l0', 'D', STATEMENT_D);
  c.forEach(({ seat, who }) => logs.resultIn('C', R + 4, who, intoD, seat, 'pass'));
  const d = [{ seat: 'C', who: 'q' }, ...seatsNamed(run.middle, 'E', 'e')];
  const dSeats = d.map((s, i): NestedSeat => (i === 0 ? ['C', 1] : [s.seat]));
  logs.formedIn('D', R + 5, dSeats, d.map((s) => s.who), STATEMENT_D);
  const intoF = logs.sealedInto('D', R + 8, 'q', 'F', STATEMENT_F);
  // C decides D's motion to take F's seat for its own seat too, so C's seats pass it as D's do.
  c.forEach(({ seat, who }) => logs.resultIn('C', R + 9, who, intoF, seat, 'pass'));
  d.forEach(({ seat, who }) => logs.resultIn('D', R + 9, who, intoF, seat, 'pass'));
  const f = [{ seat: 'D', who: 'r' }, ...seatsNamed(run.upper, 'G', 'g')];
  const fSeats = f.map((s, i): NestedSeat => (i === 0 ? ['D', 2] : [s.seat]));
  logs.formedIn('F', R + 10, fSeats, f.map((s) => s.who), STATEMENT_F);
  return logs.motionIn('F', R + 30, 'g0', STAGGERED_TEXT);
}

/**
 * Every step of a staggered run, in time order: each seat's reports at their
 * drawn minutes, before its own level's horizon, and each lower log's
 * crossings, the extra ones while the motion is open above and the last one
 * between its own horizon and the level above's.
 */
function staggeredSteps(run: StaggeredRun, timing: StaggeredTiming): StaggeredStep[] {
  const open = R + 31;
  const [hC, hD, hF] = [1, 2, 3].map((k) => R + 30 + WINDOW + k * HORIZON_STEP_MINUTES);
  const ends = { C: hC ?? 0, D: hD ?? 0, F: hF ?? 0 };
  let next = 0;
  const levels = [
    ['C', seatsNamed(run.lower, 'L', 'l'), run.lower],
    ['D', seatsNamed(run.middle, 'E', 'e'), run.middle],
    ['F', seatsNamed(run.upper, 'G', 'g'), run.upper],
  ] as const;
  const reports = levels.flatMap(([log, seats, said]) =>
    seats.flatMap(({ seat, who }, i) =>
      reportsOf(said[i] ?? null).map((result): StaggeredStep => {
        const at = within(timing.times[next++] ?? 0, open, ends[log]);
        return { at, kind: 'report', log, who, seat, result };
      }),
    ),
  );
  const cross = (lower: string, upper: string, at: number): StaggeredStep => ({
    at,
    kind: 'cross',
    lower,
    upper,
  });
  const crossings = [
    ...timing.crossC.map((n) => cross('C', 'D', within(n, open, ends.D))),
    cross('C', 'D', within(timing.lastC, ends.C, ends.D)),
    ...timing.crossD.map((n) => cross('D', 'F', within(n, open, ends.F))),
    cross('D', 'F', within(timing.lastD, ends.D, ends.F)),
  ];
  return [...reports, ...crossings].sort((a, b) => a.at - b.at);
}

/** `lower`'s devices crossing up to `upper` at minute `at`: they post whatever it owes there now. */
function crossUp(logs: NestedLogs, lower: string, upper: string, at: number): void {
  const owed = owedUp(logs.foldAll(at), lower, upper);
  for (const body of owed) {
    logs.add(upper, at, CROSSER[lower] ?? '', { type: 'group-result', body });
  }
}

/**
 * Plays one staggered run (#387) with `timing`, then folds every log at F's
 * horizon: C's, D's and F's outcome on F's motion and whether each is final,
 * and F's first section.
 */
function staggered(run: StaggeredRun, timing: StaggeredTiming) {
  const logs = new NestedLogs();
  const motion = staggeredNest(logs, run);
  for (const step of staggeredSteps(run, timing)) {
    if (step.kind === 'report') {
      logs.resultIn(step.log, step.at, step.who, motion, step.seat, step.result);
    } else {
      crossUp(logs, step.lower, step.upper, step.at);
    }
  }
  const states = logs.foldAll(R + 30 + WINDOW + 3 * HORIZON_STEP_MINUTES);
  const decided = (log: string) => {
    const p = states[log]?.proposals.find((proposal) => proposal.id === motion);
    return { final: p?.final, outcome: p?.outcome.kind };
  };
  return {
    C: decided('C'),
    D: decided('D'),
    F: decided('F'),
    atoms: states.F?.atoms.map((atom) => atom.text.trim()),
  };
}

/** The groups of the nested canary property: each log, its three voters, first the founder. */
const CANARY_GROUPS = [
  ['A', ['ana', 'ben', 'cal']],
  ['B', ['dee', 'eve', 'fay']],
] as const;

/**
 * Groups A and B, every name, title, Atom and note carrying `mark`, form C;
 * C and E form D; a motion opens in D, and A and B score it with
 * `scores[0]` and `scores[1]` (#122).
 */
function canaryLines(mark: string, scores: readonly (readonly Score[])[]) {
  const logs = new NestedLogs();
  const statementC = { name: `C ${mark}`, title: `T ${mark}`, atoms: [mark] };
  for (const [log, voters] of CANARY_GROUPS) {
    const documents = [{ title: mark, atoms: [mark] }];
    const body = { name: `Group ${mark}`, founder: `F ${mark}`, documents };
    logs.add(log, R, voters[0], { type: 'genesis', body });
    for (const voter of voters.slice(1)) {
      const join = { name: `${voter} ${mark}`, level: CREATING };
      logs.add(log, R + 1, voter, { type: 'join', body: join });
    }
    const held = logs.reconcileInto(log, R + 2, voters[0], 'C', log, statementC);
    voters.forEach((voter) => logs.vote(log, R + 3, voter, held, 4));
  }
  logs.formedIn('C', R + 5, [['A'], ['B']], ['ca', 'cb'], statementC);
  const into = logs.sealedInto('C', R + 9, 'ca', 'D', STATEMENT_D);
  logs.resultIn('C', R + 10, 'ca', into, 'A', 'pass');
  logs.resultIn('C', R + 10, 'cb', into, 'B', 'pass');
  logs.formedIn('D', R + 11, [['C', 1], ['E']], ['q', 'e'], STATEMENT_D);
  const motion = logs.motionIn('D', R + 20, 'e', 'Rent stays fair for everyone.');
  CANARY_GROUPS.forEach(([log, voters], g) => {
    voters.forEach((voter, i) => {
      logs.vote(log, R + 21, voter, motion, scores[g]?.[i] ?? 4, `Note ${mark}`);
    });
  });
  return { logs, motion };
}

/** What `lower` owes `upper` for the seat it holds there, folded in `states`, or nothing. */
function owedUp(states: Readonly<Record<string, GroupState>>, lower: string, upper: string) {
  const [below, above] = [states[lower], states[upper]];
  const seat = below === undefined || above === undefined ? null : seatIn(below, above);
  return seat === null || below === undefined || above === undefined
    ? []
    : resultsToReport(below, above, seat);
}

describe('properties of nested coalitions (#122)', { timeout: 120_000 }, () => {
  it('decides a motion in D the same whatever order the lower results arrive in, C’s and its groups’ alike', () => {
    const scenario = fc.record({
      lower: fc.array(maybeResult, { minLength: 6, maxLength: 6 }),
      lowerSeats: fc.integer({ min: 2, max: 6 }),
      others: fc.array(maybeResult, { minLength: 4, maxLength: 4 }),
      otherSeats: fc.integer({ min: 1, max: 4 }),
      orderLower: fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
      orderUpper: fc.array(fc.nat(), { minLength: 5, maxLength: 5 }),
      expired: fc.boolean(),
    });
    fc.assert(
      fc.property(scenario, (s) => {
        const lower = s.lower.slice(0, s.lowerSeats);
        const others = s.others.slice(0, s.otherSeats);
        const byOrder = (order: readonly number[]) => (a: number, b: number) =>
          (order[a] ?? 0) - (order[b] ?? 0) || a - b;
        const lowerIn = (sorted: boolean) => {
          const seats = lower.map((_, i) => i);
          return sorted ? seats : [...seats].sort(byOrder(s.orderLower));
        };
        // Index 0 stands for C's own result, the rest for D's other seats.
        const upperIn = (sorted: boolean) => {
          const seats = [0, ...others.map((_, i) => i + 1)];
          return sorted ? seats : [...seats].sort(byOrder(s.orderUpper));
        };
        const decide = (sorted: boolean) => {
          const logs = new NestedLogs();
          const cSeats = lower.map((_, i) => [`L${String(i)}`] as const);
          logs.formedIn(
            'C',
            R,
            cSeats,
            lower.map((_, i) => `l${String(i)}`),
          );
          const into = logs.sealedInto('C', R + 5, 'l0', 'D', STATEMENT_D);
          cSeats.forEach(([seat], i) =>
            logs.resultIn('C', R + 6, `l${String(i)}`, into, seat, 'pass'),
          );
          const dSeats: NestedSeat[] = [
            ['C', 1],
            ...others.map((_, i) => [`E${String(i)}`] as const),
          ];
          const dWho = ['q', ...others.map((_, i) => `e${String(i)}`)];
          logs.formedIn('D', R + 7, dSeats, dWho, STATEMENT_D);
          const motion = logs.motionIn('D', R + 20, 'e0', 'Rent stays fair for everyone.');
          lowerIn(sorted).forEach((i, n) => {
            const result = lower[i];
            if (result !== undefined && result !== null) {
              logs.resultIn('C', R + 21 + n, `l${String(i)}`, motion, `L${String(i)}`, result);
            }
          });
          // C's devices cross from C's horizon on (#387), with D's other seats' results among them.
          const at = R + 20 + WINDOW + HORIZON_STEP_MINUTES;
          const upper = upperIn(sorted);
          upper.forEach((i, n) => {
            const when = at + n;
            if (i === 0) {
              const states = logs.foldAll(when);
              const [c, d] = [states.C, states.D];
              if (c === undefined || d === undefined) throw new Error('Expected C and D.');
              const seat = seatIn(c, d);
              if (seat === null) throw new Error('Expected C’s seat in D.');
              for (const body of resultsToReport(c, d, seat)) {
                logs.add('D', when, 'q', { type: 'group-result', body });
              }
              return;
            }
            const result = others[i - 1];
            if (result !== undefined && result !== null) {
              logs.resultIn('D', when, `e${String(i - 1)}`, motion, `E${String(i - 1)}`, result);
            }
          });
          const horizonD = R + 20 + WINDOW + 2 * HORIZON_STEP_MINUTES;
          const d = logs.foldAll(s.expired ? horizonD : at + 10).D;
          const p = d?.proposals.find((proposal) => proposal.id === motion);
          return { outcome: p?.outcome.kind, final: p?.final, atoms: d?.atoms };
        };
        const first = decide(true);
        expect(decide(false)).toEqual(first);
        // C's outcome is final at its horizon, where a missing result counts as a fail.
        const fromC = outcomeOver(lower, true);
        const crossed = fromC === 'open' ? null : fromC;
        const kind = outcomeOver([crossed, ...others], s.expired);
        expect(first.outcome).toBe(kind === 'open' ? 'lapse' : kind);
        expect(first.final).toBe(kind === 'fail' || s.expired);
      }),
      { numRuns: 30 },
    );
  });

  it('decides every level of three the same whatever the order and timing of results, at any seat count: only final outcomes cross up (#387)', () => {
    const seats = (min: number) => fc.array(lowerReport, { minLength: min, maxLength: 5 });
    const draws = fc.array(fc.nat({ max: DRAW - 1 }), { minLength: 0, maxLength: 3 });
    const timing = fc.record({
      times: fc.array(fc.nat({ max: DRAW - 1 }), { minLength: TIMES, maxLength: TIMES }),
      crossC: draws,
      crossD: draws,
      lastC: fc.nat({ max: DRAW - 1 }),
      lastD: fc.nat({ max: DRAW - 1 }),
    });
    const scenario = fc.record({
      lower: fc.array(lowerReport, { minLength: 2, maxLength: 6 }),
      middle: seats(1),
      upper: seats(1),
      first: timing,
      second: timing,
    });
    // #375's counterexample: of C's five seats four pass, C's devices cross, then L0's contest.
    const early = { times: [0, 5000, 100, 200, 300], crossC: [400], crossD: [], lastC: 0, lastD: 0 };
    const late = { times: [0, 5000, 100, 200, 300], crossC: [], crossD: [], lastC: 9999, lastD: 9999 };
    const pad = (t: StaggeredTiming) => ({
      ...t,
      times: [...t.times, ...Array<number>(TIMES - t.times.length).fill(9000)],
    });
    const withdrawn: StaggeredRun = {
      lower: ['contest', 'pass', 'pass', 'pass', null],
      middle: ['pass'],
      upper: ['pass'],
      first: pad(early),
      second: pad(late),
    };
    // The recovery: after the contest and a crossing, L4's pass makes C pass after all.
    const recovered: StaggeredRun = {
      lower: ['contest', 'pass', 'pass', 'pass', 'pass'],
      middle: ['pass'],
      upper: ['pass'],
      first: pad({ ...early, times: [0, 5000, 100, 200, 300, 6000], crossC: [400, 5200] }),
      second: pad({ ...late, times: [0, 5000, 100, 200, 300, 6000] }),
    };
    fc.assert(
      fc.property(scenario, (run) => {
        const first = staggered(run, run.first);
        // The same outcome at every level, whatever the order and timing of results.
        expect(staggered(run, run.second)).toEqual(first);
        // And the one each level's final outcome gives, level by level from the groups up.
        const c = outcomeOver(run.lower.map(seatValue), true);
        const d = outcomeOver([c === 'open' ? null : c, ...run.middle.map(seatValue)], true);
        const f = outcomeOver([d === 'open' ? null : d, ...run.upper.map(seatValue)], true);
        expect(first).toMatchObject({
          C: { final: true, outcome: c },
          D: { final: true, outcome: d },
          F: { final: true, outcome: f },
        });
        expect(first.atoms).toEqual([f === 'pass' ? STAGGERED_TEXT : STATEMENT_F.atoms[0]]);
      }),
      { numRuns: 25, examples: [[withdrawn], [recovered]] },
    );
  });

  it('carries only a pass or fail for one motion and seat up each line, never a ballot, note, name or count', () => {
    const scenario = fc.record({
      canary: fc.stringMatching(/^[a-z0-9]{8}$/),
      scoresA: fc.array(score, { minLength: 3, maxLength: 3 }),
      scoresB: fc.array(score, { minLength: 3, maxLength: 3 }),
    });
    fc.assert(
      fc.property(scenario, ({ canary, scoresA, scoresB }) => {
        const mark = `canary${canary}`;
        const { logs, motion } = canaryLines(mark, [scoresA, scoresB]);
        const states = logs.foldAll(R + 20 + WINDOW);
        const owed = (['A', 'B'] as const).flatMap((log) => owedUp(states, log, 'C'));
        expect(owed.filter((body) => body.motion === motion)).toHaveLength(2);
        owed.forEach((body, i) => {
          const who = body.seat === seatKey('A') ? 'ca' : 'cb';
          logs.add('C', R + 30 + i, who, { type: 'group-result', body });
        });
        // C's pass crosses up once final, at its horizon (#387).
        const after = logs.foldAll(R + 20 + WINDOW + HORIZON_STEP_MINUTES);
        const upward = owedUp(after, 'C', 'D');
        expect(upward.map((body) => body.motion)).toContain(motion);
        const voters = CANARY_GROUPS.flatMap(([, names]) => names);
        const forbidden = [mark, ...voters.map(authorOf), 'scores', 'note'];
        for (const body of [...owed, ...upward]) {
          expect(Object.keys(body).sort()).toEqual(['motion', 'result', 'seat']);
          expect(['pass', 'fail']).toContain(body.result);
          const text = JSON.stringify(body);
          for (const secret of forbidden) expect(text).not.toContain(secret);
        }
        // D's log never names a lower group's seat: only C's and E's results reach it.
        const seatsInD = new Set(after.D?.coalition?.results.map((r) => r.seat));
        expect([...seatsInD].sort()).toEqual([seatKey('C'), seatKey('E')].sort());
      }),
      { numRuns: 15 },
    );
  });
});
