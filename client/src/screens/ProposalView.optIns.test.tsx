/**
 * Rules ballots in the Proposal view (#117): the ballot opens with the
 * opt-in's warning, is headed by what it decides, shows a webhook only by its
 * last 4 characters, says when a steward has turned it off meanwhile, and its
 * result says what is now on or off.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { createEvent, type ParsedEvent, parseEvent, type Score } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { COVENANT } from '../shelf/covenant';
import { DOOR, lapsedNarrowing, LISTED, RELISTED } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { ProposalView, type ProposalViewProps } from './ProposalView';

type OnVote = (scores: Readonly<Record<string, Score>>, note: string) => Promise<void>;

const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
const BOT = { webhook: WEBHOOK };
const { warnings } = messages.optIns;

function setup(
  state: GroupState,
  proposalId: string,
  me: string,
  extra: Partial<ProposalViewProps> = {},
) {
  const onVote = vi.fn<OnVote>(() => Promise.resolve());
  const view = render(
    <ProposalView
      state={state}
      me={authorOf(me)}
      proposalId={proposalId}
      pending={[]}
      reachable
      now={state.at}
      own="none"
      onVote={onVote}
      onProposeAgain={() => undefined}
      onTell={() => Promise.resolve('copied')}
      {...extra}
    />,
  );
  return { user: userEvent.setup(), onVote, container: view.container };
}

/** Ana proposes turning the chat bot on in Ana, Ben and Cal's group. */
function botProposal() {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const id = log.rules('Ana', 'chatBot', BOT, { title: 'Turn on the Discord chat bot' });
  return { log, id };
}

describe('ProposalView: turning the chat bot on (#117)', () => {
  it('opens the ballot with the warning, and heads its one card with what it decides', async () => {
    const { log, id } = botProposal();
    setup(log.state(), id, 'ben');
    const ballot = screen.getByRole('region', { name: 'On the ballot' });
    const [first] = within(ballot).getAllByText(/./, { selector: 'p' });
    expect(first).toHaveTextContent(warnings.chatBot);
    const card = within(ballot).getByRole('region', { name: 'Turn on the Discord chat bot' });
    expect(within(card).getByText(/content-free nudges/)).toBeVisible();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add your version' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the webhook only by its last 4 characters, nowhere in full', () => {
    const { log, id } = botProposal();
    const { container } = setup(log.state(), id, 'ben');
    const card = screen.getByRole('region', { name: 'Turn on the Discord chat bot' });
    expect(within(card).getByText('WXYZ')).toBeVisible();
    expect(within(card).getByText(/Webhook ending in/)).toBeVisible();
    expect(container.innerHTML).not.toContain('sEcReT');
    expect(container.innerHTML).not.toContain('1199000000000000001');
  });

  it('queues a ballot scoring the Proposal itself', async () => {
    const { log, id } = botProposal();
    const { user, onVote } = setup(log.state(), id, 'ben');
    await user.click(screen.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(screen.getByRole('button', { name: 'Send your vote' }));
    expect(onVote).toHaveBeenCalledWith({ [id]: 4 }, '');
  });

  it('says the bot is on once the vote passes, with no Document text and no Propose again', () => {
    const { log, id } = botProposal();
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, id, 4);
    setup(log.state(), id, 'ana');
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('This passed. The Discord chat bot is on.')).toBeVisible();
    expect(within(result).queryByText(/The Document now reads/)).toBeNull();
    expect(within(result).getByText('Turn on the Discord chat bot')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose again' })).toBeNull();
  });
});

describe('ProposalView: a front door Proposal open when a member left (#288)', () => {
  /** Ana proposes opening the door, Ana and Cal score it, then Cal leaves and the key changes. */
  function exposedOpening() {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.rules('Ana', 'frontDoor', DOOR, { title: 'Open a front door' });
    for (const name of ['Ana', 'Cal']) log.vote(name, id, 4);
    log.leave('Cal');
    log.rotate('Ana');
    return { log, id };
  }

  it('says on the ballot that passing it won’t open the door, and how to reopen it', async () => {
    const { log, id } = exposedOpening();
    setup(log.state(), id, 'ben');
    const card = screen.getByRole('region', { name: 'Open a front door' });
    expect(within(card).getByText(/A member left while this vote was open/)).toHaveTextContent(
      messages.optIns.exposed.line,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('says its pass leaves the door closed', () => {
    const { log, id } = exposedOpening();
    log.vote('Ben', id, 4);
    const state = log.state();
    expect(state.optIns.frontDoor).toBe(false);
    setup(state, id, 'ana');
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText(messages.optIns.exposed.passed)).toBeVisible();
    expect(within(result).queryByText('This passed. Your group’s front door is open.')).toBeNull();
  });
});

describe('ProposalView: a steward’s Turn off now (#117)', () => {
  it('says who turned it off and that it stays off while the group votes', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const door = log.rules('Ana', 'frontDoor', DOOR, { title: 'Open a front door' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, door, 4);
    const off = log.rules('Ana', 'frontDoor', false, { title: 'Close the front door' });
    log.narrow('Ana', 'frontDoor', off);
    setup(log.state(), off, 'cal');
    expect(
      screen.getByText(/turned this off at once\. It stays off while your group votes\./),
    ).toHaveTextContent('Steward Ana turned this off at once.');
    const ballot = screen.getByRole('region', { name: 'On the ballot' });
    expect(within(ballot).getByText(warnings.frontDoor)).toBeVisible();
    expect(within(ballot).getByRole('region', { name: 'Close the front door' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing of a narrowing on an off-Proposal nobody narrowed', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const door = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, door, 4);
    const off = log.rules('Ben', 'frontDoor', false, { title: 'Close it' });
    setup(log.state(), off, 'cal');
    expect(screen.queryByText(/turned this off at once/)).toBeNull();
  });
});

describe('ProposalView: a rules Proposal still in the outbox (#117)', () => {
  it('shows what it decides and its warning, and the webhook only by its last 4', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const state = log.state();
    const { bytes } = createEvent({
      type: 'proposal',
      group: state.group ?? '',
      author: authorOf('ana'),
      ts: 0,
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: BOT },
        title: 'A bot for nudges',
        why: 'So people notice votes.',
      },
    });
    const parsed = parseEvent(bytes);
    if (parsed === null) throw new Error('Expected an event.');
    const pending: ParsedEvent[] = [parsed];
    const { container } = setup(state, parsed.id, 'ana', { pending });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A bot for nudges');
    const ballot = screen.getByRole('region', { name: 'On the ballot' });
    expect(within(ballot).getByText(warnings.chatBot)).toBeVisible();
    expect(
      within(ballot).getByRole('region', { name: 'Turn on the Discord chat bot' }),
    ).toBeVisible();
    expect(within(ballot).getByText('WXYZ')).toBeVisible();
    expect(container.innerHTML).not.toContain('sEcReT');
  });

  it('shows nothing on the ballot for a value the fold would refuse', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const state = log.state();
    const { bytes } = createEvent({
      type: 'proposal',
      group: state.group ?? '',
      author: authorOf('ana'),
      ts: 0,
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: { webhook: 'https://example.com/x' } },
        title: 'A bot',
        why: 'Why not.',
      },
    });
    const parsed = parseEvent(bytes);
    if (parsed === null) throw new Error('Expected an event.');
    setup(state, parsed.id, 'ana', { pending: [parsed] });
    const ballot = screen.getByRole('region', { name: 'On the ballot' });
    expect(within(ballot).queryByRole('region')).toBeNull();
  });
});

describe('ProposalView: a Proposal that lists the front door (#485; ADR-0081)', () => {
  const { covenant } = messages;

  /** Ana, Ben and Cal's group with the front door open, and Ana's Proposal setting it to `value`. */
  function listing(value: unknown, title = 'List the front door on the public shelf') {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    log.minute += 1;
    const id = log.rules('Ana', 'frontDoor', value, { title });
    return { log, id };
  }

  it('shows the covenant on the ballot, marked a draft, with what listing makes public', async () => {
    const { log, id } = listing({ ...DOOR, listed: true, covenant: COVENANT.hash });
    setup(log.state(), id, 'ben');
    const card = screen.getByRole('region', { name: 'List the front door on the public shelf' });
    const words = within(card).getByRole('region', { name: /The covenant/ });
    expect(within(words).getByText(covenant.draft)).toBeVisible();
    expect(within(words).getByText(covenant.draftLine)).toBeVisible();
    for (const clause of COVENANT.clauses) expect(within(words).getByText(clause)).toBeVisible();
    expect(within(words).getByText(covenant.exposure)).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('says so when the ballot names a covenant this app doesn’t carry, and shows no words for it', () => {
    const other = DOOR.sign;
    const { log, id } = listing({ ...DOOR, listed: true, covenant: other });
    setup(log.state(), id, 'ben');
    const words = screen.getByRole('region', { name: /The covenant/ });
    expect(within(words).getByText(covenant.unknown)).toBeVisible();
    expect(within(words).queryByText(COVENANT.clauses[0] ?? '')).toBeNull();
  });
});

describe('ProposalView: listing a door again after a narrowing ended its listing (#501)', () => {
  const { listing } = messages.optIns;

  /** A listed door whose narrowing lapsed, and Ben's Proposal listing it again at new keys. */
  function relisting() {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const open = log.rules('Ana', 'frontDoor', LISTED);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
    log.minute += 1;
    lapsedNarrowing(log);
    const relisted = { ...RELISTED, covenant: COVENANT.hash };
    const id = log.rules('Ben', 'frontDoor', relisted, { title: listing.motions.list });
    return { log, id };
  }

  it('words the ballot as a listing at a new link, at the higher bar, with the covenant', async () => {
    const { log, id } = relisting();
    const state = log.state();
    expect(state.proposals.find((p) => p.id === id)?.class).toBe('entrenched');
    setup(state, id, 'cal');
    const card = screen.getByRole('region', { name: listing.motions.list });
    expect(within(card).getByText(new RegExp(listing.lines.list))).toBeVisible();
    expect(within(card).getByText(/It moves to a new link/)).toBeVisible();
    expect(within(card).getByText(COVENANT.clauses[0] ?? '')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('words its pass as listed, read as it opened even once it has passed', () => {
    const { log, id } = relisting();
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, id, 4);
    log.minute += 1;
    setup(log.state(), id, 'ana');
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText(listing.passed.list)).toBeVisible();
  });
});
