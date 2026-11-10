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

describe('ProposalView: a steward’s Turn off now (#117)', () => {
  it('says who turned it off and that it stays off while the group votes', async () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const door = log.rules('Ana', 'frontDoor', true, { title: 'Open a front door' });
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
    const door = log.rules('Ana', 'frontDoor', true);
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
