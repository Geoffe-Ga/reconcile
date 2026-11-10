import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { ownBallot } from './ownBallot';

const ANA = authorOf('ana');
const BEN = authorOf('ben');
const CAL = authorOf('cal');

/** Ana proposes at the start minute in a group of Ana, Ben and Cal. */
function vote() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposal = log.propose('ana');
  return { log, proposal, deadline: deadlineOf(START_MINUTE) };
}

describe('ownBallot', () => {
  it('is counted once the fold counts the viewer’s ballot', () => {
    const { log, proposal, deadline } = vote();
    log.minute += 5;
    log.vote('ben', proposal, 3);
    const state = log.state(deadline);
    expect(ownBallot(state, log.records, proposal, BEN)).toBe('counted');
    expect(ownBallot(state, log.records, proposal, ANA)).toBe('none');
  });

  it('is late for a ballot the relay received at the deadline, and only for its author', () => {
    const { log, proposal, deadline } = vote();
    log.minute = deadline;
    log.vote('ben', proposal, 4);
    const state = log.state(deadline);
    expect(ownBallot(state, log.records, proposal, BEN)).toBe('late');
    expect(ownBallot(state, log.records, proposal, ANA)).toBe('none');
    expect(ownBallot(state, log.records, proposal, CAL)).toBe('none');
  });

  it('stays counted when a later ballot arrives too late to replace it', () => {
    const { log, proposal, deadline } = vote();
    log.vote('ben', proposal, 3);
    log.minute = deadline + 2;
    log.vote('ben', proposal, 1);
    const state = log.state(deadline + 2);
    expect(ownBallot(state, log.records, proposal, BEN)).toBe('counted');
  });

  it('is none for a ballot ignored for another reason before the close', () => {
    const { log, proposal, deadline } = vote();
    log.minute += 1;
    // A 0 needs a reason, so the fold ignores this ballot although it came in time.
    log.vote('ben', proposal, 0);
    const state = log.state(deadline);
    expect(state.ignored).toHaveLength(1);
    expect(ownBallot(state, log.records, proposal, BEN)).toBe('none');
  });

  it('is none for a late ballot on another Proposal, and for an unknown Proposal', () => {
    const { log, proposal, deadline } = vote();
    const other = log.propose('ana', { atom: 1, title: 'Bins' });
    log.minute = deadline;
    log.vote('ben', other, 4);
    const state = log.state(deadline);
    expect(ownBallot(state, log.records, proposal, BEN)).toBe('none');
    expect(ownBallot(state, log.records, other, BEN)).toBe('late');
    expect(ownBallot(state, log.records, 'unknown', BEN)).toBe('none');
  });

  it('is none for someone who joined after it opened, whenever their ballot came', () => {
    const { log, proposal, deadline } = vote();
    log.join('Dee');
    log.minute = deadline;
    log.vote('dee', proposal, 4);
    const state = log.state(deadline);
    expect(ownBallot(state, log.records, proposal, authorOf('dee'))).toBe('none');
  });

  it('ignores records that aren’t a signed event', () => {
    const { log, proposal, deadline } = vote();
    const junk = { seq: log.records.length + 1, received: deadline, bytes: new Uint8Array(9) };
    const records = [...log.records, junk];
    const state = log.state(deadline);
    const withJunk = { ...state, ignored: [...state.ignored, { seq: junk.seq, id: null }] };
    expect(ownBallot(withJunk, records, proposal, BEN)).toBe('none');
  });
});
