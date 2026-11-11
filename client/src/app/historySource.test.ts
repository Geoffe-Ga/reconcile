import { describe, expect, it } from 'vitest';

import { proposalTally } from '../engine/fold';
import { groupLog } from '../test/votes';
import { coalitionHistory, groupHistory } from './historySource';

/** A group whose first section Ana changed, with Ben's vote: a pass, closed early. */
function changed() {
  const log = groupLog();
  const proposal = log.propose('Ana', { text: 'Quiet after 10pm.\n' });
  log.vote('Ana', proposal, 4);
  log.vote('Ben', proposal, 4);
  return { log, proposal, state: log.state() };
}

describe('groupHistory', () => {
  it('reads the group’s own histories, names its members, and opens each result in the group', () => {
    const { log, proposal, state } = changed();
    const source = groupHistory(state);
    expect(source.names).toBe(state);
    expect(source.historyOf(`${log.group}.0`).passed.map((entry) => entry.proposalId)).toEqual([
      proposal,
      null,
    ]);
    expect(source.resultHref(proposal)).toBe(`#/g/${log.group}/p/${proposal}`);
  });

  it('reads a cleared archive’s totals from the tallies it kept (#108)', () => {
    const { log, proposal, state } = changed();
    const decided = state.proposals.find((p) => p.id === proposal);
    if (decided === undefined) throw new Error('Expected the Proposal.');
    const tally = proposalTally(decided);
    const [won] = tally.versions;
    if (won === undefined) throw new Error('Expected a version.');
    const kept = { [proposal]: { ...tally, versions: [{ ...won, scorers: 7 }] } };
    const [entry] = groupHistory(state, kept).historyOf(`${log.group}.0`).passed;
    expect(entry?.totals?.scorers).toBe(7);
  });
});

describe('coalitionHistory', () => {
  it('opens a motion’s result in the group on this device whose seat decides it, or nowhere', () => {
    const { state } = changed();
    const source = coalitionHistory(state, [
      { id: 'decided-here', groupId: 'riverside' },
      { id: 'decided-elsewhere', groupId: null },
    ]);
    expect(source.names).toBe(state);
    expect(source.resultHref('decided-here')).toBe('#/g/riverside/p/decided-here');
    expect(source.resultHref('decided-elsewhere')).toBeNull();
    expect(source.resultHref('unknown')).toBeNull();
    expect(source.historyOf('nope.0')).toEqual({ passed: [], notPassed: [] });
  });
});
