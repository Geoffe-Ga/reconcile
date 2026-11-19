/**
 * The shelf line (#430; ADR-0081; docs/spec/listed-doors.md §5.1): while a
 * group is listed, a Dispatch put to its vote can carry a second scored line,
 * "Put {name} to this on the public shelf", tallied on its own at the
 * ordinary bar. It passes only if the Dispatch line passes, and the fold
 * lists the Dispatch as published only if the group was still listed when
 * the vote closed. The golden vectors in vectors/shelf-line-*.json pin the
 * exact cases; these are the issue's examples and properties.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DOOR, lapsedNarrowing, LISTED, RELISTED } from '../test/door';
import { deadlineOf, groupLog, type LogBuilder } from '../test/votes';
import { publishedBy, shelfLineId } from './dispatches';
import type { Score } from './event';
import { heldRecord, type GroupState, type Proposal, shelfPassed } from './fold';

/** Ana and `members`, whose front door is open and listed by an entrenched vote of all 4s. */
function listedGroup(members: readonly string[] = ['Ben', 'Cal']): LogBuilder {
  const log = groupLog({ members });
  const listing = log.rules('Ana', 'frontDoor', LISTED, { title: 'List our door' });
  for (const name of ['Ana', ...members]) log.vote(name, listing, 4);
  log.minute += 1;
  return log;
}

const WORDS = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };

/** `name`'s ballot on the shelf Proposal `id`: the Dispatch line, then the shelf line, each when given. */
function cast(log: LogBuilder, name: string, id: string, dispatch?: Score, shelf?: Score) {
  const scores = {
    ...(dispatch === undefined ? {} : { [id]: dispatch }),
    ...(shelf === undefined ? {} : { [shelfLineId(id)]: shelf }),
  };
  const zero = dispatch === 0 || shelf === 0;
  log.ballot(name, id, scores, zero ? 'Not like this.' : undefined);
}

/** The listed group's shelf Proposal, with Ana's, Ben's and Cal's scores on each line, in order. */
function votes(scores: { dispatch: readonly Score[]; shelf: readonly Score[] }) {
  const log = listedGroup();
  const id = log.rising('Ana', 0, WORDS, undefined, true);
  log.minute += 1;
  ['Ana', 'Ben', 'Cal'].forEach((name, i) => {
    cast(log, name, id, scores.dispatch[i], scores.shelf[i]);
  });
  log.minute += 1;
  return { log, id, state: log.state() };
}

/** The one Proposal with id `id` in `state`. */
function proposalIn(state: GroupState, id: string): Proposal {
  const found = state.proposals.find((proposal) => proposal.id === id);
  if (found === undefined) throw new Error(`Expected the Proposal ${id}.`);
  return found;
}

describe('the shelf line (#430)', () => {
  it('publishes nothing when the Dispatch passes and the shelf line fails', () => {
    const { state, id } = votes({ dispatch: [4, 3, 3], shelf: [4, 0, 1] });
    expect(state.dispatches.map((dispatch) => dispatch.id)).toContain(id);
    expect(publishedBy(state)).toEqual([]);
  });

  it('publishes the Dispatch when both lines pass, and the ballot carries a second version with no text', () => {
    const { state, id } = votes({ dispatch: [4, 3, 3], shelf: [3, 3, 2] });
    const proposal = proposalIn(state, id);
    expect(proposal.versions.map((version) => version.id)).toEqual([id, `${id}.shelf`]);
    expect(proposal.versions.map((version) => version.text)).toEqual(['', '']);
    expect(proposal.outcome).toMatchObject({ kind: 'pass', version: id });
    expect(proposal.final).toBe(true);
    expect(shelfPassed(proposal)).toBe(true);
    expect(state.dispatches.map((dispatch) => dispatch.id)).toEqual([id]);
    expect(publishedBy(state)).toEqual([id]);
  });

  it('publishes nothing when the shelf line passes and the Dispatch line fails', () => {
    const { state, id } = votes({ dispatch: [4, 0, 1], shelf: [4, 4, 4] });
    const proposal = proposalIn(state, id);
    expect(proposal.outcome.kind).toBe('fail');
    expect(shelfPassed(proposal)).toBe(false);
    expect(state.dispatches).toEqual([]);
    expect(publishedBy(state)).toEqual([]);
  });

  it('closes early only once everyone has scored both lines', () => {
    const log = listedGroup();
    const id = log.rising('Ana', 0, WORDS, undefined, true);
    for (const name of ['Ana', 'Ben', 'Cal']) cast(log, name, id, 4);
    expect(proposalIn(log.state(), id).final).toBe(false);
    for (const name of ['Ana', 'Ben', 'Cal']) cast(log, name, id, 4, 4);
    expect(proposalIn(log.state(), id).final).toBe(true);
  });

  it('ignores a ballot with a 0 on the shelf line and no reason', () => {
    const log = listedGroup();
    const id = log.rising('Ana', 0, WORDS, undefined, true);
    log.ballot('Ben', id, { [id]: 4, [`${id}.shelf`]: 0 });
    expect(proposalIn(log.state(), id).ballots).toEqual([]);
  });

  it('opens a shelf line only while the door is listed in effect', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', DOOR, { title: 'Open our door' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    log.minute += 1;
    log.rising('Ana', 0, WORDS, undefined, true);
    log.rising('Ana', 1, WORDS, undefined, true);
    expect(log.state().proposals.map((p) => p.id)).toEqual([open]);
  });

  it('still takes a shelf line once a steward’s narrowing ended the listing and lapsed, as builds before #501 do', () => {
    // The fold reads the standing door here, not listingInEffect: reading the
    // ended listing would refuse what older builds take, a split (#501). Send
    // a Dispatch doesn't offer the line then, and the keeper posts no entry.
    const log = lapsedNarrowing(listedGroup());
    expect(log.state().optIns.frontDoor).toEqual(LISTED);
    const id = log.rising('Ana', 0, WORDS, undefined, true);
    expect(proposalIn(log.state(), id).versions.map((v) => v.id)).toEqual([id, `${id}.shelf`]);
  });

  it('opens a shelf line again once one fresh vote lists the door at new keys (#501)', () => {
    const log = lapsedNarrowing(listedGroup());
    const relist = log.rules('Ana', 'frontDoor', RELISTED, { title: 'List our door again' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, relist, 4);
    log.minute += 1;
    const id = log.rising('Ana', 0, WORDS, undefined, true);
    expect(proposalIn(log.state(), id).versions.map((v) => v.id)).toEqual([id, `${id}.shelf`]);
  });

  it('takes a shelf line only on a Dispatch that stays in the group, and a ceiling of 0 only with one', () => {
    // A rising Dispatch with a shelf line would split from a build before #430,
    // which reads it as a plain rising Dispatch and ignores the shelf line's
    // ballots; with a reach of 0 such a build only lags (listed-doors.md §5.1).
    const log = listedGroup();
    const stays = log.rising('Ana', 0, WORDS, undefined, true);
    log.rising('Ana', 2, WORDS, undefined, true);
    log.rising('Ana', 0, WORDS);
    const state = log.state();
    expect(proposalIn(state, stays).target).toEqual({ kind: 'dispatch', ceiling: 0, shelf: true });
    expect(state.proposals.at(-1)?.id).toBe(stays);
    expect(state.ignored.slice(-2).map(({ seq }) => seq)).toEqual([
      log.records.length - 1,
      log.records.length,
    ]);
  });

  it('publishes nothing when the listing ends before the vote closes, and keeps what closed while listed', () => {
    const log = listedGroup();
    const early = log.rising('Ana', 0, WORDS, undefined, true);
    const late = log.rising('Ana', 0, { title: 'Picnic', text: 'Bring food.' }, undefined, true);
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) cast(log, name, early, 4, 4);
    log.minute += 1;
    const unlist = log.rules('Ana', 'frontDoor', DOOR, { title: 'Unlist our door' });
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, unlist, 4);
    log.minute += 1;
    for (const name of ['Ana', 'Ben', 'Cal']) cast(log, name, late, 4, 4);
    log.minute += 1;
    const state = log.state();
    expect(state.dispatches.map((dispatch) => dispatch.id)).toEqual([early, late]);
    expect(shelfPassed(proposalIn(state, late))).toBe(true);
    expect(publishedBy(state)).toEqual([early]);
  });

  it('reads the listing at each vote’s close, however late the fold reaches it', () => {
    const log = listedGroup(['Ben', 'Cal', 'Dee']);
    const opened = log.minute;
    const id = log.rising('Ana', 0, WORDS, undefined, true);
    log.minute += 1;
    for (const name of ['Ana', 'Ben']) cast(log, name, id, 4, 4);
    log.minute += 1;
    cast(log, 'Cal', id, 3, 3);
    // An unlisting that closes at its deadline, after the shelf Proposal's own deadline.
    const unlist = log.rules('Ana', 'frontDoor', DOOR, { title: 'Unlist our door' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, unlist, 4);
    const after = deadlineOf(log.minute) + 1;
    expect(publishedBy(log.state(deadlineOf(opened)))).toEqual([id]);
    expect(publishedBy(log.state(after))).toEqual([id]);
    expect(log.state(after).optIns.frontDoor).toEqual(DOOR);
  });

  it('keeps a cleared Proposal published, from the result its counts are read from', () => {
    const { log, id, state } = votes({ dispatch: [4, 3, 3], shelf: [3, 3, 2] });
    const proposal = proposalIn(state, id);
    log.result('Ben', { ...heldRecord(proposal), outcome: { kind: 'pass', version: id } });
    log.minute += 1;
    const cleared = log.state(log.minute, [id]);
    expect(proposalIn(cleared, id).cleared).toBe(true);
    expect(shelfPassed(proposalIn(cleared, id))).toBe(true);
    expect(publishedBy(cleared)).toEqual([id]);
  });

  it('changes neither line’s outcome with the order of the ballots (property)', () => {
    const score = fc.constantFrom<Score>(0, 1, 2, 3, 4);
    const ballot = fc.record({ dispatch: score, shelf: score });
    fc.assert(
      fc.property(fc.array(ballot, { minLength: 3, maxLength: 3 }), (ballots) => {
        const outcomes = [ballots, [...ballots].reverse()].map((ordered) => {
          const log = listedGroup();
          const id = log.rising('Ana', 0, WORDS, undefined, true);
          const names = ['Ana', 'Ben', 'Cal'];
          const voters = ordered === ballots ? names : [...names].reverse();
          ordered.forEach((b, i) => {
            log.minute += 1;
            cast(log, voters[i] ?? '', id, b.dispatch, b.shelf);
          });
          const state = log.state(deadlineOf(log.minute));
          const proposal = proposalIn(state, id);
          return {
            outcome: proposal.outcome,
            shelf: shelfPassed(proposal),
            published: publishedBy(state).length,
          };
        });
        expect(outcomes[0]).toEqual(outcomes[1]);
      }),
      { numRuns: 40 },
    );
  });
});
