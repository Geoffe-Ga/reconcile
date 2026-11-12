import { describe, expect, it } from 'vitest';

import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { composeOption, openProposalOn, optionFor, VERSIONS_MAX } from './composeOption';

/** Ana, Ben and Cal, with Ana's Proposal on the first Atom. */
function busyGroup() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const atom = `${log.group}.0`;
  const proposal = log.propose('Ana');
  return { log, atom, proposal };
}

describe('VERSIONS_MAX', () => {
  it('is 3: the Proposal’s own text and two more (ADR-0047)', () => {
    expect(VERSIONS_MAX).toBe(3);
  });
});

describe('optionFor', () => {
  it('offers a Proposal when nothing is open on the Atom', () => {
    expect(optionFor(undefined)).toBe('propose');
  });

  it('offers a version while the open ballot has fewer than three', () => {
    expect(optionFor({ versions: [1] })).toBe('add-version');
    expect(optionFor({ versions: [1, 2] })).toBe('add-version');
  });

  it('says the ballot is full at three versions, or more', () => {
    expect(optionFor({ versions: [1, 2, 3] })).toBe('ballot-full');
    expect(optionFor({ versions: [1, 2, 3, 4] })).toBe('ballot-full');
  });

  it('says a section’s protection is being decided while a class Proposal is open on it, whatever its ballot holds (#116)', () => {
    expect(optionFor({ versions: [1], target: { kind: 'class' } })).toBe('protecting');
    expect(optionFor({ versions: [], target: { kind: 'class' } })).toBe('protecting');
    expect(optionFor({ versions: [1, 2, 3], target: { kind: 'class' } })).toBe('protecting');
  });

  it('says a section is moving while a move is open on it, whatever its ballot holds (#103)', () => {
    expect(optionFor({ versions: [1], target: { kind: 'move' } })).toBe('moving');
    expect(optionFor({ versions: [1], target: { kind: 'edit' } })).toBe('add-version');
    expect(optionFor({ versions: [1], target: { kind: 'add' } })).toBe('add-version');
  });
});

describe('composeOption', () => {
  it('offers a Proposal on an Atom with none', () => {
    const log = groupLog();
    expect(composeOption(log.state(), `${log.group}.0`)).toBe('propose');
  });

  it('offers a version on an Atom with an open Proposal, and a Proposal on the others', () => {
    const { log, atom } = busyGroup();
    const state = log.state();
    expect(composeOption(state, atom)).toBe('add-version');
    expect(composeOption(state, `${log.group}.1`)).toBe('propose');
  });

  it('still offers a version with two on the ballot, and says it is full at three', () => {
    const { log, atom, proposal } = busyGroup();
    log.version('Ben', proposal, 'Quiet after midnight.\n');
    expect(composeOption(log.state(), atom)).toBe('add-version');
    log.version('Cal', proposal, 'Quiet after 10pm.\n');
    expect(composeOption(log.state(), atom)).toBe('ballot-full');
  });

  it('offers a Proposal again once the open one closes early', () => {
    const { log, atom, proposal } = busyGroup();
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 3);
    expect(log.state().proposals[0]?.final).toBe(true);
    expect(composeOption(log.state(), atom)).toBe('propose');
  });

  it('says a section with an open move is moving, takes no version, and is free once it closes (#103)', () => {
    const log = groupLog({ members: ['Ben'] });
    const atom = `${log.group}.0`;
    const move = log.move('Ana', atom, `${log.group}.1`);
    expect(composeOption(log.state(), atom)).toBe('moving');
    expect(composeOption(log.state(), `${log.group}.1`)).toBe('propose');
    log.vote('Ana', move, 4);
    log.vote('Ben', move, 4);
    expect(composeOption(log.state(), atom)).toBe('propose');
  });

  it('says a section with an open class Proposal is being protected, takes no version, and is free once it closes (#116)', () => {
    const log = groupLog({ members: ['Ben'] });
    const atom = `${log.group}.0`;
    const protect = log.protect('Ana', atom, 'entrenched');
    expect(composeOption(log.state(), atom)).toBe('protecting');
    expect(composeOption(log.state(), `${log.group}.1`)).toBe('propose');
    log.vote('Ana', protect, 4);
    log.vote('Ben', protect, 4);
    expect(composeOption(log.state(), atom)).toBe('propose');
  });

  it('offers a Proposal again once relay time reaches the deadline, not a minute before', () => {
    const { log, atom } = busyGroup();
    const deadline = deadlineOf(START_MINUTE);
    expect(composeOption(log.state(deadline - 1), atom)).toBe('add-version');
    expect(composeOption(log.state(deadline), atom)).toBe('propose');
  });
});

describe('openProposalOn', () => {
  it('finds the open Proposal on an Atom, and nothing once it has closed', () => {
    const { log, atom, proposal } = busyGroup();
    expect(openProposalOn(log.state(), atom)?.id).toBe(proposal);
    expect(openProposalOn(log.state(), `${log.group}.1`)).toBeUndefined();
    expect(openProposalOn(log.state(deadlineOf(START_MINUTE)), atom)).toBeUndefined();
  });
});
