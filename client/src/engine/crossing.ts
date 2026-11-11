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
 */
import { type GroupResult, type Motion, resultsCount } from './coalition';
import type { GroupResultBody, GroupResultValue } from './event';
import type { GroupState, HeldSeat } from './fold';

/** The seat key `group` holds in `coalition`: one of its reconcile Proposals' keys that the genesis names, or null. */
export function seatIn(
  group: Pick<GroupState, 'coalitions'>,
  coalition: Pick<GroupState, 'coalition'>,
): string | null {
  const seats = coalition.coalition?.seats ?? [];
  const held = group.coalitions.find((c) => seats.some((seat) => seat.key === c.key));
  return held?.key ?? null;
}

/**
 * The motions `seatKey`'s group decides: each motion in `coalition` whose
 * snapshot holds the seat, with where the relay put it and the class, window,
 * deadline and bar the coalition set. `fold`'s `outside` opens each as a group
 * Proposal.
 */
export function motionsFor(coalition: GroupState, seatKey: string): Motion[] {
  const { group, coalition: info } = coalition;
  if (group === null || info === null) return [];
  const mine = new Set(info.motions.filter((m) => m.seats.includes(seatKey)).map((m) => m.id));
  return coalition.proposals
    .filter((p) => mine.has(p.id))
    .map((p) => ({
      id: p.id,
      coalition: group,
      seq: p.seq,
      received: p.received,
      class: p.class,
      window: p.window,
      deadline: p.deadline,
      bar: p.outcome.bar,
    }));
}

/** Whether a genesis says what the group passed: the same name, title and Atoms, in order. */
function sameStatement(held: HeldSeat, founding: Pick<HeldSeat, 'name' | 'title' | 'atoms'>) {
  const { atoms } = founding;
  const sameAtoms =
    atoms.length === held.atoms.length && atoms.every((a, i) => a === held.atoms[i]);
  return held.name === founding.name && held.title === founding.title && sameAtoms;
}

/**
 * The group's own result on the genesis: its reconcile vote's outcome once
 * final, a lapse as `fail`, and `fail` too when the genesis's name, title or
 * Atoms differ from the target it voted on; null while it's still voting.
 */
function genesisResult(
  group: GroupState,
  coalition: GroupState,
  seatKey: string,
): GroupResultValue | null {
  const held = group.coalitions.find((c) => c.key === seatKey);
  const founding = coalition.coalition?.founding;
  if (held === undefined || founding === undefined || held.outcome === 'open') return null;
  return held.outcome === 'pass' && sameStatement(held, founding) ? 'pass' : 'fail';
}

/**
 * The group's own result on `motion`: its Proposal's outcome once final, a
 * lapse or fail as `fail`, or null while it's still voting or never opened it.
 */
function motionResult(group: GroupState, coalitionId: string, motion: string) {
  const own = group.proposals.find(
    (p) => p.id === motion && p.target.kind === 'motion' && p.target.coalition === coalitionId,
  );
  if (own?.final !== true) return null;
  return own.outcome.kind === 'pass' ? 'pass' : 'fail';
}

/** The group's own result on the genesis or a motion, or null while it doesn't have one. */
function ownResult(
  group: GroupState,
  coalition: GroupState,
  seatKey: string,
  motion: string,
): GroupResultValue | null {
  if (coalition.group === null) return null;
  return motion === coalition.group
    ? genesisResult(group, coalition, seatKey)
    : motionResult(group, coalition.group, motion);
}

/**
 * What `group` owes `coalition` for its seat `seatKey`, as `group-result`
 * bodies to post from a participant bound to that seat: its result on the
 * genesis (its reconcile outcome, or `fail` for a genesis that says something
 * else), then on each motion its seat decides, a lapse as `fail`. Only those
 * the group has decided, while results still count, and that the coalition
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
  const motions = info.motions.filter((m) => m.seats.includes(seatKey)).map((m) => m.id);
  return [id, ...motions].flatMap((motion) => {
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
