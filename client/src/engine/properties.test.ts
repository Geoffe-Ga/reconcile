/**
 * Properties of the fold (fast-check): every device that folds the same relay
 * records builds the same state, the Document changes only on a final pass, a level change
 * never reaches back into a Proposal that's already open, and an Atom never has two open
 * Proposals or a ballot more than three versions. And of the bars (#94): the entrenched bar is
 * never easier than the ordinary one, and neither depends on the order ballots arrive in. And of
 * ballot expiry (#111): a device that has cleared a closed Proposal's ballots, keeping its result,
 * folds the same Document and outcomes as one that still holds them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { signedAs } from '../test/keys';
import { LEVELS } from './capabilities';
import { VERSIONS_MAX } from './composeOption';
import { type EventDraft, parseRecord, type Score } from './event';
import { expiringProposal, resultFor } from './expiry';
import { fold, type GroupState, heldRecord, type LogRecord } from './fold';
import { type Bar, DEFAULT_RULES, defaultWindowMinutes } from './rules';
import { tally, type TallyInput } from './tally';

const R = 29_375_000;
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

  /** Genesis by member 0 at R, then members 1..count-1 join. */
  static founded(count: number, atoms: readonly string[] = ['A0', 'A1']): Log {
    const log = new Log();
    const body = { name: 'G', founder: 'Founder', title: 'Doc', atoms };
    log.group = log.add(R, member(0), { type: 'genesis', body });
    for (let i = 1; i < count; i += 1) {
      log.add(R + i, member(i), { type: 'join', body: { name: member(i) } });
    }
    return log;
  }

  propose(received: number, atom: string, text: string): string {
    const body = { atom, title: 'T', why: 'W', text };
    return this.add(received, member(0), { type: 'proposal', body });
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
        const withForgery = [
          ...records.slice(0, at),
          { seq: 0, received: records[at]?.received ?? R, bytes: forged },
          ...records.slice(at),
        ];
        const state = fold(withForgery, relayNow);
        expect(state.ignored).toContainEqual({ seq: 0, id: null });
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

  it('gives every Proposal its class’s window and tallies it at its class’s bar', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const { proposals, rules } = fold(records, relayNow);
        for (const p of proposals) {
          // No target is entrenched until a later issue registers one (#116, #115, #117, #108).
          expect(p.class).toBe('ordinary');
          expect(p.deadline).toBe(p.received + defaultWindowMinutes(rules, p.class));
          expect(p.outcome.bar).toEqual(rules.bars[p.class]);
        }
      }),
    );
  });

  it('changes only the target Atom on a final pass, and no Atom on a fail or lapse', () => {
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
        const expected = before.map((atom, i) =>
          passed && i === atomIndex ? { ...atom, text: p.text } : atom,
        );
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
  versions: fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 3 }),
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
        scenario.versions.forEach((offset, v) => {
          const input: Unstamped = {
            type: 'version',
            body: { proposal: pId, text: `Version ${String(v + 2)}` },
          };
          const received = p0 + offset;
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
        expect(decided(fold(cleared, now, [pId]))).toEqual(decided(held));
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
