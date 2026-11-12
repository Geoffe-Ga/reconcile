/**
 * What crosses group lines (docs/spec/phase-1-spec.md §4 Coalitions; ADR-0036, ADR-0009; #100).
 *
 * A device that holds a seat folds both logs: its group's and the coalition's.
 * Motions cross one way, from the coalition into each member group, carrying
 * only their place in relay order, class, window, deadline and bar
 * ({@link motionsFor}). Results cross the other way, and only as a signed
 * pass or fail per motion and seat ({@link resultsToReport}): no ballot,
 * voter, score, count, note or name leaves a group. {@link resultMismatches}
 * shows a group what the coalition recorded for its seat that disagrees with
 * its own vote, so it can talk it out. Nothing here reads a person's key in
 * one log to find them in the other.
 *
 * Coalitions nest (#122; ADR-0036, ADR-0074). A coalition's member may be a
 * coalition, which decides each motion from above as it decides its own,
 * from its own seats' results, and reports its one result up. Motions travel
 * down every line, each with the chain it came through, and results travel
 * up one line at a time: a higher coalition sees only its own seats' pass or
 * fail. {@link foldTogether} folds a device's logs in that order.
 *
 * Dispatches rise the same way (#126; ADR-0037). A level that passes a
 * Dispatch whose ceiling leaves levels above it owes the coalition directly
 * above one promotion record ({@link promotionsOwed}), which opens there as a
 * motion and in every group beneath it, but the seat it came from: that
 * seat already passed it, so its result comes from its own fold, `pass` only
 * when it holds exactly the Dispatch the record names, passed. No ballot,
 * score or note goes with it; a voter's own device carries their score
 * (`store/carry.ts`).
 */
import {
  foundingSeats,
  type GroupResult,
  MAX_LEVEL,
  type Motion,
  RESULT_GRACE_MINUTES,
  resultsCount,
  seatLevel,
  withinCeiling,
} from './coalition';
import type {
  GroupResultBody,
  GroupResultValue,
  PromoteProposalBody,
  PromoteTarget,
} from './event';
import {
  closeTime,
  fold,
  type GroupState,
  type HeldSeat,
  type LogRecord,
  type Proposal,
} from './fold';

/** The seat key `group` holds in `coalition`: one of its reconcile Proposals' keys that the genesis names, or null. */
export function seatIn(
  group: Pick<GroupState, 'coalitions'>,
  coalition: Pick<GroupState, 'coalition'>,
): string | null {
  const seats = coalition.coalition?.seats ?? [];
  const held = group.coalitions.find((c) => seats.some((seat) => seat.key === c.key));
  return held?.key ?? null;
}

/** The coalitions a motion came through above `proposal`'s log: none for the log's own (#122). */
function chainOf(proposal: Pick<Proposal, 'target'>): readonly string[] {
  const { target } = proposal;
  return target.kind === 'motion' ? [target.coalition, ...target.chain] : [];
}

/**
 * The motions `seatKey`'s member decides: each motion in `coalition` whose
 * snapshot holds the seat, with where the relay put it and the class, window,
 * deadline and bar the coalition set. `fold`'s `outside` opens each as a
 * Proposal. A coalition passes on the motions it decides for its own seats
 * above as well (#122), each with the chain of coalitions it came through, so
 * a motion opens in every group beneath the coalition whose motion it is,
 * with that coalition's deadline and bar. A promotion record (#126) opens no
 * new vote beneath the seat it came from, which already passed its
 * Dispatch: that seat's result comes from its own fold ({@link resultsToReport}).
 */
export function motionsFor(coalition: GroupState, seatKey: string): Motion[] {
  const { group, coalition: info } = coalition;
  if (group === null || info === null) return [];
  const mine = new Set(info.motions.filter((m) => m.seats.includes(seatKey)).map((m) => m.id));
  return coalition.proposals
    .filter((p) => mine.has(p.id) && !promotedFrom(p, seatKey))
    .map((p) => ({
      id: p.id,
      coalition: group,
      chain: chainOf(p),
      seq: p.seq,
      received: p.received,
      class: p.class,
      window: p.window,
      deadline: p.deadline,
      bar: p.outcome.bar,
    }));
}

/** One log a device folds beside its others: its records, the relay's `now` for it, and what it cleared (#111). */
export interface LogToFold {
  readonly records: readonly LogRecord[];
  readonly relayNow: number | null;
  readonly cleared?: readonly string[];
}

/**
 * Folds every log a device holds as it must (#122): each one with the motions
 * its seats decide in the coalitions above it, each of those folded the same
 * way first, so a motion opens down every line and each log decides it from
 * its own ballots or its own seats' results. A coalition follows the lines up
 * at most {@link MAX_LEVEL} deep, and a log met again on its own way up, as a
 * cycle of false seats would make, is taken as it folds alone. Returns the
 * states in the order the logs were given.
 */
export function foldTogether(logs: readonly LogToFold[]): GroupState[] {
  const alone = logs.map((log) => fold(log.records, log.relayNow, [], log.cleared ?? []));
  const done = new Map<number, GroupState>();
  const visit = (index: number, path: readonly number[]): GroupState => {
    const found = done.get(index);
    if (found !== undefined) return found;
    const own = alone[index] ?? fold([], null);
    if (path.includes(index) || path.length > MAX_LEVEL) return own;
    const outside = alone.flatMap((above, i) => {
      const seat = i === index || above.coalition === null ? null : seatIn(own, above);
      return seat === null ? [] : motionsFor(visit(i, [...path, index]), seat);
    });
    const log = logs[index];
    const state =
      outside.length === 0 || log === undefined
        ? own
        : fold(log.records, log.relayNow, outside, log.cleared ?? []);
    done.set(index, state);
    return state;
  };
  return logs.map((_, index) => visit(index, []));
}

/** Whether `proposal` is a promotion record that came from the seat `seatKey` (#126). */
function promotedFrom(proposal: Pick<Proposal, 'target'>, seatKey: string): boolean {
  return proposal.target.kind === 'promote' && proposal.target.from === seatKey;
}

/** Whether a genesis says what the group passed: the same name, title and Atoms, in order. */
function sameStatement(held: HeldSeat, founding: Pick<HeldSeat, 'name' | 'title' | 'atoms'>) {
  const { atoms } = founding;
  const sameAtoms =
    atoms.length === held.atoms.length && atoms.every((a, i) => a === held.atoms[i]);
  return held.name === founding.name && held.title === founding.title && sameAtoms;
}

/** The level a log holds its seats at: 0 for a group, a coalition's own (#122). */
function ownLevel(log: Pick<GroupState, 'coalition'>): number {
  return log.coalition?.level ?? 0;
}

/** Whether the genesis states `seatKey` at the lower log's own level, which it can check (#122). */
function sameLevel(lower: GroupState, coalition: GroupState, seatKey: string): boolean {
  const seat = coalition.coalition?.seats.find((s) => s.key === seatKey);
  return seat !== undefined && seatLevel(seat) === ownLevel(lower);
}

/**
 * The member's own result on the genesis: its reconcile vote's outcome once
 * final, a lapse as `fail`, and `fail` too when the genesis's name, title or
 * Atoms differ from the target it voted on, or when it states the member's
 * seat at another level than its own (#122); null while it's still voting.
 */
function genesisResult(
  group: GroupState,
  coalition: GroupState,
  seatKey: string,
): GroupResultValue | null {
  const held = group.coalitions.find((c) => c.key === seatKey);
  const founding = coalition.coalition?.founding;
  if (held === undefined || founding === undefined || held.outcome === 'open') return null;
  const same = sameStatement(held, founding) && sameLevel(group, coalition, seatKey);
  return held.outcome === 'pass' && same ? 'pass' : 'fail';
}

/**
 * The member's own result on `motion`. A group's is its Proposal's outcome
 * once final, a lapse or fail as `fail`. A coalition's (#122) is its seats'
 * pass as soon as it is certain, before results on it stop counting, since a
 * pass that waited for that would reach the coalition above too late, or a
 * fail once final; a contest that later turns its pass into a fail crosses
 * as that fail too. Null while it's still deciding, or never opened it.
 */
function motionResult(group: GroupState, coalitionId: string, motion: string) {
  const own = group.proposals.find(
    (p) => p.id === motion && p.target.kind === 'motion' && p.target.coalition === coalitionId,
  );
  if (own === undefined) return null;
  const pass = own.outcome.kind === 'pass';
  if (group.coalition !== null && pass) return 'pass';
  if (!own.final) return null;
  return pass ? 'pass' : 'fail';
}

/**
 * Where a Dispatch that may rise stands in a log below (#126): the Proposal
 * that carries it there, a group's own Dispatch put to a vote, under the
 * Dispatch's id, or a coalition's promotion motion for it; the level a
 * record from it states above, one more than the lines it had crossed; and
 * whether it has passed: a group's once its pass is final, a coalition's
 * once its seats' pass is certain, as its results cross (#122).
 */
interface Rising {
  readonly proposal: Proposal;
  readonly dispatch: PromoteTarget['dispatch'];
  readonly ceiling: PromoteTarget['ceiling'];
  readonly level: number;
  readonly passed: boolean;
  /** The relay minute from which a record no longer goes up: its results' horizon. */
  readonly until: number;
}

/** A group's own Dispatch put to a vote (#126), as {@link Rising}: level 1 above it, passed once final. */
function groupRising(proposal: Proposal): Rising | null {
  const { id, target, dispatch, outcome, final } = proposal;
  if (target.kind !== 'dispatch' || dispatch === null) return null;
  const until = closeTime(proposal) + RESULT_GRACE_MINUTES;
  const passed = outcome.kind === 'pass' && final;
  return {
    proposal,
    dispatch: { id, ...dispatch },
    ceiling: target.ceiling,
    level: 1,
    passed,
    until,
  };
}

/** A coalition's promotion motion (#126), as {@link Rising}: one level higher, passed once certain. */
function coalitionRising(proposal: Proposal): Rising | null {
  const { target, outcome, deadline } = proposal;
  if (target.kind !== 'promote') return null;
  const { dispatch, ceiling, level } = target;
  const until = deadline + RESULT_GRACE_MINUTES;
  return { proposal, dispatch, ceiling, level: level + 1, passed: outcome.kind === 'pass', until };
}

/** The Dispatches `log` holds that may rise, each as {@link Rising} (#126). */
function risingIn(log: GroupState): Rising[] {
  const read = log.coalition === null ? groupRising : coalitionRising;
  return log.proposals.flatMap((proposal) => {
    const rising = read(proposal);
    return rising === null ? [] : [rising];
  });
}

/** Whether a promotion record says exactly what `rising` holds: id, title, text, ceiling and level. */
function sameRecord(rising: Rising, target: PromoteTarget): boolean {
  const { dispatch, ceiling, level } = rising;
  const same = dispatch.id === target.dispatch.id && dispatch.title === target.dispatch.title;
  return (
    same &&
    dispatch.text === target.dispatch.text &&
    ceiling === target.ceiling &&
    level === target.level
  );
}

/**
 * The seat's own result on a promotion record that came from it (#126;
 * ADR-0075 §1): `pass` only when its own fold holds the Dispatch the record
 * names, with that id, title, text, ceiling and level, passed; `fail` for a
 * record its fold doesn't hold, one that says anything else, or one whose
 * Dispatch didn't pass; null while that is still being decided. So a forged
 * or altered record fails.
 */
function promoteResult(lower: GroupState, target: PromoteTarget): GroupResultValue | null {
  const held = risingIn(lower).find((r) => r.dispatch.id === target.dispatch.id);
  if (held === undefined || !sameRecord(held, target)) return 'fail';
  if (held.passed) return 'pass';
  return held.proposal.final ? 'fail' : null;
}

/** The group's own result on the genesis or a motion, or null while it doesn't have one. */
function ownResult(
  group: GroupState,
  coalition: GroupState,
  seatKey: string,
  motion: string,
): GroupResultValue | null {
  if (coalition.group === null) return null;
  if (motion === coalition.group) return genesisResult(group, coalition, seatKey);
  const { target } = coalition.proposals.find((p) => p.id === motion) ?? {};
  if (target?.kind === 'promote' && target.from === seatKey) return promoteResult(group, target);
  return motionResult(group, coalition.group, motion);
}

/**
 * The promotion records `lower` owes `coalition` for its seat `seatKey`
 * (#126; ADR-0037), as `proposal` bodies to post from a participant bound to
 * that seat: one for each Dispatch `lower` has passed whose ceiling leaves
 * this level, never past {@link MAX_LEVEL}, that `coalition`, formed, holds
 * no record of yet, while its results still count there. Each carries the
 * Dispatch's id, title and text, its ceiling, the level it reaches here and
 * the seat, and nothing else: no Document, ballot, score, count, note or
 * name of the level below.
 */
export function promotionsOwed(
  lower: GroupState,
  coalition: GroupState,
  seatKey: string,
): PromoteProposalBody[] {
  const info = coalition.coalition;
  if (info?.status !== 'formed' || !info.seats.some((seat) => seat.key === seatKey)) return [];
  const held = new Set(
    coalition.proposals.flatMap((p) => (p.target.kind === 'promote' ? [p.target.dispatch.id] : [])),
  );
  return risingIn(lower)
    .filter((r) => r.passed && r.level <= MAX_LEVEL && withinCeiling(r.level, r.ceiling))
    .filter((r) => coalition.at < r.until && !held.has(r.dispatch.id))
    .map(({ dispatch, ceiling, level }) => ({
      target: { kind: 'promote', dispatch, ceiling, level, from: seatKey },
      title: dispatch.title,
      why: '',
    }));
}

/**
 * What `group` owes `coalition` for its seat `seatKey`, as `group-result`
 * bodies to post from a participant bound to that seat: its result on the
 * genesis (its reconcile outcome, or `fail` for a genesis that says something
 * else) when it is a founding seat, never for a group admitted since (#114),
 * then on each motion its seat decides, a lapse as `fail`. Only those the
 * group has decided, while results still count, and that the coalition
 * hasn't recorded yet. Each carries the motion, the seat and the result, and
 * nothing else.
 */
export function resultsToReport(
  group: GroupState,
  coalition: GroupState,
  seatKey: string,
): GroupResultBody[] {
  const { group: id, coalition: info, at } = coalition;
  if (id === null || info === null || info.status === 'declined') return [];
  if (!info.seats.some((seat) => seat.key === seatKey)) return [];
  const genesis = foundingSeats(info).includes(seatKey) ? [id] : [];
  const motions = info.motions.filter((m) => m.seats.includes(seatKey)).map((m) => m.id);
  return [...genesis, ...motions].flatMap((motion) => {
    const result = ownResult(group, coalition, seatKey, motion);
    if (result === null || !resultsCount(info, id, motion, at)) return [];
    const recorded = info.results.some(
      (r) => r.motion === motion && r.seat === seatKey && r.result === result,
    );
    return recorded ? [] : [{ motion, seat: seatKey, result }];
  });
}

/**
 * The results `coalition` recorded for `seatKey` that `group` should see: any
 * that differ from its own decided result, and both sides of a contested
 * seat, which counts as a fail whatever the group decided. Each is the
 * recorded result, with the participant who posted it.
 */
export function resultMismatches(
  group: GroupState,
  coalition: GroupState,
  seatKey: string,
): GroupResult[] {
  const results = (coalition.coalition?.results ?? []).filter((r) => r.seat === seatKey);
  const said = (motion: string, result: GroupResultValue) =>
    results.some((r) => r.motion === motion && r.result === result);
  return results.filter((r) => {
    const own = ownResult(group, coalition, seatKey, r.motion);
    const contested = said(r.motion, 'pass') && said(r.motion, 'fail');
    return contested || (own !== null && own !== r.result);
  });
}
