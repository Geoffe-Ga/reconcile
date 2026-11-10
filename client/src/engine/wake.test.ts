import { describe, expect, it } from 'vitest';

import { type EventDraft, type GroupEvent, parseRecord } from './event';
import { authorOf, signedAs } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import { wakeFor } from './wake';

/** The event `name` signs, as the outbox holds it. */
function eventOf(name: string, draft: EventDraft): GroupEvent {
  const parsed = parseRecord(signedAs(name.toLowerCase(), draft).record);
  if (parsed === null) throw new Error('Expected a signed event.');
  return parsed.event;
}

/** Ana and Ben with one open Proposal of Ana's, and the vote each would send on it. */
function openProposal() {
  const log = groupLog({ members: ['Ben'] });
  log.minute += 10;
  const proposal = log.propose('Ana');
  log.minute += 10;
  const vote = (name: string, scores: Record<string, 0 | 1 | 2 | 3 | 4>) =>
    eventOf(name, { type: 'vote', group: log.group, ts: 0, body: { proposal, scores } });
  return { log, proposal, vote };
}

describe('wakeFor: which of this device’s events wake the group’s phones (#99)', () => {
  it('wakes for a new Proposal', () => {
    const { log } = openProposal();
    const body = { atom: `${log.group}.1`, title: 'Bins', why: 'Smell.', text: 'Bins on Monday.' };
    const event = eventOf('Ben', { type: 'proposal', group: log.group, ts: 0, body });

    expect(wakeFor(log.state(), event)).toBe(true);
  });

  it('wakes for the ballot after which this device’s fold closes the Proposal early', () => {
    const { log, proposal, vote } = openProposal();
    log.vote('Ben', proposal, 3);

    expect(wakeFor(log.state(), vote('Ana', { [proposal]: 4 }))).toBe(true);
  });

  it('doesn’t wake for a ballot that leaves someone still to score', () => {
    const { log, proposal, vote } = openProposal();

    expect(wakeFor(log.state(), vote('Ana', { [proposal]: 4 }))).toBe(false);
  });

  it('wakes when a voter’s new ballot replaces one that missed a version', () => {
    const { log, proposal } = openProposal();
    const version = log.version('Ben', proposal, 'Quiet after midnight.');
    log.ballot('Ben', proposal, { [proposal]: 3, [version]: 2 });
    log.ballot('Ana', proposal, { [proposal]: 4 });
    const both = eventOf('Ana', {
      type: 'vote',
      group: log.group,
      ts: 0,
      body: { proposal, scores: { [proposal]: 4, [version]: 1 } },
    });
    const one = eventOf('Ana', {
      type: 'vote',
      group: log.group,
      ts: 0,
      body: { proposal, scores: { [version]: 1 } },
    });

    expect(wakeFor(log.state(), both)).toBe(true);
    expect(wakeFor(log.state(), one)).toBe(false);
  });

  it('doesn’t wake for a ballot on a Proposal that has closed, or one this device hasn’t seen', () => {
    const { log, proposal, vote } = openProposal();
    log.vote('Ben', proposal, 3);
    const closed = log.state(deadlineOf(log.minute));

    expect(wakeFor(closed, vote('Ana', { [proposal]: 4 }))).toBe(false);
    expect(wakeFor(log.state(), vote('Ana', { unknown: 4 }))).toBe(false);
  });

  it('doesn’t wake for a last ballot the fold would ignore: a voter who stepped down to Member', () => {
    const { log, proposal, vote } = openProposal();
    log.vote('Ana', proposal, 4);
    log.level('Ben', 'member');

    expect(wakeFor(log.state(), vote('Ben', { [proposal]: 3 }))).toBe(false);
  });

  it('counts only the eligible set: a newcomer still earning voting rights neither closes nor wakes (#101)', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.minute += 10;
    // Dee joins once the bootstrap's 3 voting members are in, so she waits for vouches.
    log.join('Dee');
    const proposal = log.propose('Ana');
    log.vote('Ana', proposal, 4);
    log.vote('Ben', proposal, 4);
    const by = (name: string) =>
      eventOf(name, {
        type: 'vote',
        group: log.group,
        ts: 0,
        body: { proposal, scores: { [proposal]: 3 } },
      });
    const state = log.state();

    expect(state.proposals[0]?.eligible).not.toContain(authorOf('dee'));
    expect(wakeFor(state, by('Dee'))).toBe(false);
    expect(wakeFor(state, by('Cal'))).toBe(true);
  });

  it('doesn’t wake for a join, a genesis, a level, a version, a leave or anything else', () => {
    const { log, proposal } = openProposal();
    const { group } = log;
    const genesis = {
      name: 'Riverside Tenants',
      founder: 'Cal',
      title: 'House rules',
      atoms: ['Quiet.'],
    };
    const others: EventDraft[] = [
      { type: 'genesis', group: '', ts: 0, body: genesis },
      { type: 'join', group, ts: 0, body: { name: 'Cal', level: 'co-creator' } },
      { type: 'level', group, ts: 0, body: { level: 'member' } },
      { type: 'version', group, ts: 0, body: { proposal, text: 'Quiet at nine.' } },
      { type: 'leave', group, ts: 0, body: {} },
      { type: 'chat-posted', group, ts: 0, body: { proposal, moment: 'open', nonce: 'n' } },
    ];
    for (const draft of others) {
      expect(wakeFor(log.state(), eventOf('Ben', draft))).toBe(false);
    }
  });
});
