/**
 * Properties of the fold (fast-check): every device that folds the same relay
 * records builds the same state, and the Document changes only on a final pass.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createEvent, type EventInput, type Score } from './event';
import { fold, type LogRecord, VOTE_WINDOW_MINUTES } from './fold';

const R = 29_375_000;
const encoder = new TextEncoder();

/** Member `i`'s author id. Member 0 founds the group. */
function member(i: number): string {
  return `m${String(i)}`;
}

/** An event before the log stamps its group and time. */
type Unstamped<E = EventInput> = E extends EventInput ? Omit<E, 'group' | 'ts'> : never;

/** A score from 0 to 4. */
const score = fc.constantFrom<Score>(0, 1, 2, 3, 4);

/** Builds a relay-ordered log, one seq per event. */
class Log {
  readonly records: LogRecord[] = [];
  group = '';

  add(received: number, input: Unstamped): string {
    const { bytes, id } = createEvent({ ...input, group: this.group, ts: received * 60_000 });
    this.records.push({ seq: this.records.length + 1, received, bytes });
    return id;
  }

  /** Genesis by member 0 at R, then members 1..count-1 join. */
  static founded(count: number, atoms: readonly string[] = ['A0', 'A1']): Log {
    const log = new Log();
    const body = { name: 'G', founder: 'Founder', title: 'Doc', atoms };
    log.group = log.add(R, { type: 'genesis', author: member(0), body });
    for (let i = 1; i < count; i += 1) {
      log.add(R + i, { type: 'join', author: member(i), body: { name: member(i) } });
    }
    return log;
  }

  propose(received: number, atom: string, text: string): string {
    const body = { atom, title: 'T', why: 'W', text };
    return this.add(received, { type: 'proposal', author: member(0), body });
  }

  vote(received: number, voter: number, proposal: string, value: Score): string {
    const note = value === 0 ? { note: 'A reason.' } : {};
    const body = { proposal, scores: { [proposal]: value }, ...note };
    return this.add(received, { type: 'vote', author: member(voter), body });
  }
}

/** Relay minutes after R: anywhere in the window, or right at the deadline of a Proposal made at R + 20. */
const minutesAfterR = fc.oneof(
  fc.integer({ min: 0, max: VOTE_WINDOW_MINUTES + 100 }),
  fc.integer({ min: VOTE_WINDOW_MINUTES + 19, max: VOTE_WINDOW_MINUTES + 21 }),
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

describe('properties of the fold', () => {
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

  it('gives deep-equal state when it folds the same records twice', () => {
    fc.assert(
      fc.property(arbitraryLog, ({ records, relayNow }) => {
        const copy = records.map((r) => ({ ...r, bytes: r.bytes.slice() }));
        expect(fold(copy, relayNow)).toEqual(fold(records, relayNow));
        expect(fold(records, relayNow)).toEqual(fold(records, relayNow));
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

/** One step of a random log: a join, a Proposal, a ballot, a repeat or garbage, after a wait. */
const step = fc.record({
  kind: fc.constantFrom('join', 'propose', 'vote', 'repeat', 'garbage'),
  who: fc.integer({ min: 0, max: 5 }),
  target: fc.integer({ min: 0, max: 3 }),
  score,
  wait: fc.integer({ min: 0, max: 4_000 }),
});

type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

/** Appends one random step to the log at relay minute `received`. */
function applyStep(log: Log, proposals: string[], s: Step, received: number): void {
  const seq = log.records.length + 1;
  switch (s.kind) {
    case 'join':
      log.add(received, { type: 'join', author: member(s.who), body: { name: 'N' } });
      break;
    case 'propose':
      proposals.push(log.propose(received, `${log.group}.${String(s.target)}`, 'X'));
      break;
    case 'vote':
      log.vote(received, s.who, proposals[s.target] ?? 'unknown', s.score);
      break;
    case 'repeat': {
      const earlier = log.records[s.target % log.records.length]?.bytes;
      log.records.push({ seq, received, bytes: earlier ?? encoder.encode('{') });
      break;
    }
    case 'garbage':
      log.records.push({ seq, received, bytes: encoder.encode('{') });
  }
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
