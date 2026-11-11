/**
 * Removal on screen (#115; ADR-0016, ADR-0049, ADR-0059): Propose removing on
 * the People list, the removal composer with the bar in the engine's words,
 * the ballot with the response, the one-time form for the person it names,
 * the result, a suspension a removal vote extends, and the removed member's
 * read-only copy, which says plainly that they keep what they already had.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { RemovalValues } from '../app/proposals';
import { formatDate, formatMinute, MINUTE_MS } from '../app/time';
import type { SendOutcome } from '../app/useSend';
import { LEVELS } from '../engine/capabilities';
import { createEvent, parseEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES } from '../engine/rules';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog, type LogBuilder, START_MINUTE } from '../test/votes';
import { GroupHome, type GroupHomeProps } from './GroupHome';
import { ProposalView, type ProposalViewProps } from './ProposalView';
import { RemovalComposer, type RemovalComposerProps } from './RemovalComposer';

const [FOLLOWING] = LEVELS;
const KIM = authorOf('kim');
const BAR_LINE =
  'This needs a higher bar: an average of at least 3.0, and no more than one 0 unless fewer than 5% scored 0.';

function renderHome(state: GroupState, me: string, props: Partial<GroupHomeProps> = {}) {
  const now = state.at;
  render(
    <GroupHome
      state={state}
      me={authorOf(me)}
      makeInviteLink={() => Promise.resolve(`https://reconcile.example/#join/${'s'.repeat(43)}`)}
      copyText={() => Promise.resolve()}
      now={now}
      sync={{
        reachable: true,
        lastSyncAt: now * MINUTE_MS,
        deviceNow: now * MINUTE_MS,
        missingHistory: false,
      }}
      pending={[]}
      onChooseLevel={() => Promise.resolve()}
      onSuspend={() => Promise.resolve()}
      onVouch={() => Promise.resolve()}
      onLeave={() => Promise.resolve()}
      {...props}
    />,
  );
  return userEvent.setup();
}

function renderProposal(
  state: GroupState,
  proposalId: string,
  me: string,
  props: Partial<ProposalViewProps> = {},
) {
  render(
    <ProposalView
      state={state}
      me={authorOf(me)}
      proposalId={proposalId}
      pending={[]}
      reachable
      now={state.at}
      own="none"
      onVote={() => Promise.resolve()}
      onProposeAgain={() => undefined}
      onTell={() => Promise.resolve('copied')}
      {...props}
    />,
  );
  return userEvent.setup();
}

function renderComposer(
  state: GroupState,
  me: string,
  member: string,
  props: Partial<RemovalComposerProps> = {},
) {
  const onPropose = vi.fn<(values: RemovalValues) => Promise<SendOutcome>>(() =>
    Promise.resolve('proposed'),
  );
  render(
    <RemovalComposer
      state={state}
      me={authorOf(me)}
      member={authorOf(member)}
      onPropose={onPropose}
      {...props}
    />,
  );
  return { user: userEvent.setup(), onPropose };
}

/** A paragraph whose whole text, across its parts, is `text`. */
const paragraph = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === 'P' && element.textContent === text;

/** Ana, Ben, Cal, Dee and Kim, all holding voting rights. */
function five(): LogBuilder {
  return groupLog({ members: ['Ben', 'Cal', 'Dee', 'Kim'] });
}

/** Five with an edit open and Ana's removal of Kim passed, Ben's remove folded, as Kim's device last saw it. */
function removed() {
  const log = five();
  const edit = log.propose('Ana', { title: 'Later quiet hours' });
  const removal = log.proposeRemoval('Ana', 'Kim', { title: 'Remove Kim' });
  for (const voter of ['Ana', 'Ben', 'Cal', 'Dee']) log.vote(voter, removal, 4);
  log.minute += 1;
  log.remove('Ben', removal);
  return { log, edit, removal, state: log.state() };
}

/** The pending events a queued record holds, as the outbox gives them. */
function pendingOf(state: GroupState, type: 'removal-response', body: object) {
  const { bytes } = createEvent({
    type,
    group: state.group ?? '',
    author: KIM,
    ts: 0,
    body: body as { proposal: string; text: string },
  });
  const parsed = parseEvent(bytes);
  return parsed === null ? [] : [parsed];
}

describe('Propose removing on the People list', () => {
  it('sits on each other person’s row for a voting member, and opens the removal composer', async () => {
    const state = five().state();
    renderHome(state, 'ana');
    const people = screen.getByRole('region', { name: 'People' });
    const link = within(people).getByRole('link', { name: 'Propose removing Kim' });
    expect(link).toHaveTextContent(/^Propose removing$/);
    expect(link).toHaveAttribute('href', `#/g/${state.group ?? ''}/remove/${KIM}`);
    expect(within(people).getAllByRole('link', { name: /^Propose removing / })).toHaveLength(4);
    expect(within(people).queryByRole('link', { name: 'Propose removing Ana' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('is offered to a Collaborator, but not to a Member, nor while leaving', () => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Ben: LEVELS[1], Kim: FOLLOWING } });
    renderHome(log.state(), 'ben');
    expect(screen.getByRole('link', { name: 'Propose removing Kim' })).toBeVisible();
    cleanup();
    renderHome(log.state(), 'kim');
    expect(screen.queryByRole('link', { name: /^Propose removing / })).toBeNull();
    cleanup();
    renderHome(log.state(), 'ana', { leaving: true });
    expect(screen.queryByRole('link', { name: /^Propose removing / })).toBeNull();
  });

  it('is gone for someone whose removal is open, and the vote shows for the others', () => {
    const log = five();
    log.proposeRemoval('Ana', 'Kim', { title: 'Remove Kim' });
    renderHome(log.state(), 'ben');
    expect(screen.queryByRole('link', { name: 'Propose removing Kim' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Propose removing Dee' })).toBeVisible();
    const needs = screen.getByRole('region', { name: 'Needs your vote' });
    expect(within(needs).getByRole('link', { name: /Remove Kim/ })).toBeVisible();
    cleanup();
    // Kim isn't eligible, so it doesn't wait on her.
    renderHome(log.state(), 'kim');
    expect(screen.queryByRole('region', { name: 'Needs your vote' })).toBeNull();
    const open = screen.getByRole('region', { name: 'Open Proposals' });
    expect(within(open).getByRole('link', { name: /Remove Kim/ })).toBeVisible();
  });
});

describe('a suspension a removal vote extends (ADR-0059)', () => {
  it('says on the row and to the person that it lasts until the vote closes, by its deadline', async () => {
    const log = five();
    log.suspend('Ana', 'Kim', 'Threats in the chat.');
    log.minute += 6 * DAY_MINUTES;
    const removal = log.proposeRemoval('Ben', 'Kim');
    const state = log.state();
    const deadline = state.proposals.find((p) => p.id === removal)?.deadline ?? 0;
    const line = `Suspended until the vote on removing them closes, by ${formatMinute(deadline)}.`;
    renderHome(state, 'ana');
    const people = screen.getByRole('region', { name: 'People' });
    expect(within(people).getByText(line)).toBeVisible();
    cleanup();
    renderHome(state, 'kim');
    expect(
      screen.getByText(
        `A steward suspended you until the vote on removing you closes, by ${formatMinute(deadline)}. You can read and post one response on that vote, but not propose or vote.`,
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('the removal composer', () => {
  it('says what the ballot decides, the bar and the response in the engine’s words, and proposes', async () => {
    const state = five().state();
    const { user, onPropose } = renderComposer(state, 'ana', 'kim');
    expect(screen.getByRole('heading', { level: 1, name: 'Propose a removal' })).toBeVisible();
    expect(screen.getByText('Remove', { exact: false, selector: 'p.heading-3' })).toHaveTextContent(
      'Remove Kim from the group',
    );
    expect(
      screen.getByText(
        'If this passes, they leave the group, and the group gets a new key, so they see nothing new. They keep what they already had.',
      ),
    ).toBeVisible();
    expect(screen.getByText(BAR_LINE, { exact: false })).toHaveTextContent(
      `${BAR_LINE} Kim can’t vote on it, but can post one response.`,
    );
    expect(screen.getByText('Voting runs 14 days, and nobody can make it shorter.')).toBeVisible();
    expect(screen.queryByRole('group', { name: /Voting time/ })).toBeNull();
    const title = screen.getByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Remove Kim');
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Propose this removal' }));
    expect(onPropose).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Why' }), '  Threats in the chat.  ');
    await user.clear(title);
    await user.type(title, ' Kim has to go ');
    await user.click(screen.getByRole('button', { name: 'Propose this removal' }));
    expect(onPropose).toHaveBeenCalledWith({
      member: KIM,
      title: 'Kim has to go',
      why: 'Threats in the chat.',
    });
  });

  it('says when it couldn’t be saved, and ties a Proposal too large to send to the why', async () => {
    const state = five().state();
    for (const outcome of ['failed', 'too-large'] as const) {
      const { user } = renderComposer(state, 'ana', 'kim', {
        onPropose: () => Promise.resolve(outcome),
      });
      await user.type(screen.getByRole('textbox', { name: 'Why' }), 'Threats.');
      await user.click(screen.getByRole('button', { name: 'Propose this removal' }));
      if (outcome === 'failed') {
        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Your Proposal couldn’t be saved on this device. Try again.',
        );
      } else {
        expect(screen.getByRole('textbox', { name: 'Why' })).toHaveAccessibleDescription(
          /too long/i,
        );
      }
      cleanup();
    }
  });

  it.each([
    [
      'yourself',
      'ana',
      'ana',
      'You can’t propose removing yourself. To go, choose Leave this group.',
    ],
    ['as a Member', 'kim', 'ben', 'Your place in this group doesn’t include proposing a removal.'],
    [
      'someone who isn’t a member',
      'ana',
      'hal',
      'They aren’t in this group now. Go back to your group to see who is.',
    ],
  ])('offers no form for removing %s', async (_case, me, member, line) => {
    const log = groupLog({ members: ['Ben', 'Kim'], levels: { Kim: FOLLOWING } });
    renderComposer(log.state(), me, member);
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose this removal now' }),
    ).toBeVisible();
    expect(screen.getByText(line)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no form while one is open, while leaving, or to a suspended member', () => {
    const log = five();
    log.proposeRemoval('Ana', 'Kim');
    renderComposer(log.state(), 'ben', 'kim');
    expect(
      screen.getByText(
        'A vote on removing them is already open, or has passed. Go back to your group to see it.',
      ),
    ).toBeVisible();
    cleanup();
    renderComposer(log.state(), 'ben', 'dee', { leaving: true });
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    cleanup();
    log.suspend('Ana', 'Ben');
    renderComposer(log.state(), 'ben', 'dee');
    expect(screen.getByText(/^A steward suspended you until/)).toBeVisible();
  });
});

describe('a removal’s ballot', () => {
  it('shows what it decides, that Kim hasn’t responded, and the removal bar’s zeros line', async () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim', { title: 'Remove Kim' });
    log.vote('Ben', removal, 4);
    renderProposal(log.state(), removal, 'cal');
    expect(
      screen.getByRole('heading', { level: 3, name: 'Remove Kim from the group' }),
    ).toBeVisible();
    expect(screen.getByText(paragraph('Kim hasn’t posted a response.'))).toBeVisible();
    expect(screen.getByText('Voting runs 14 days')).toBeVisible();
    expect(screen.getByText('one at most, or under 5%')).toBeVisible();
    expect(screen.getByRole('meter', { name: 'Zeros · one at most, or under 5%' })).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Your score' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('gives Kim no ballot and the one-time form, which posts her response trimmed', async () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    const onRespond = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const user = renderProposal(log.state(), removal, 'kim', { onRespond });
    expect(
      screen.getByText(
        'This Proposal would remove you, so you don’t vote on it. You can post one response.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup', { name: 'Your score' })).toBeNull();
    const field = screen.getByRole('textbox', { name: 'Your response' });
    expect(field).toHaveAccessibleDescription(
      'Everyone in the group reads it on the ballot. You can post one, and can’t change it after.',
    );
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Post your response' }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(field).toHaveAccessibleDescription(/Write your response first\./);
    // Pasted, not typed: 1,001 keystrokes would outlast the test's time under load.
    await user.click(field);
    await user.paste(`${'a'.repeat(1_000)}🌿`);
    await user.click(screen.getByRole('button', { name: 'Post your response' }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(field).toHaveAccessibleDescription(/Keep your response to 1,000 characters or fewer\./);
    await user.clear(field);
    await user.type(field, '  I wasn’t there.  ');
    await user.click(screen.getByRole('button', { name: 'Post your response' }));
    expect(onRespond).toHaveBeenCalledWith('I wasn’t there.');
  });

  it('says when her response couldn’t be saved', async () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    const user = renderProposal(log.state(), removal, 'kim', {
      onRespond: () => Promise.reject(new Error('full')),
    });
    await user.type(screen.getByRole('textbox', { name: 'Your response' }), 'I wasn’t there.');
    await user.click(screen.getByRole('button', { name: 'Post your response' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your response couldn’t be saved on this device. Try again.',
    );
  });

  it('offers the form to Kim while a steward has her suspended', () => {
    const log = five();
    log.suspend('Ana', 'Kim');
    const removal = log.proposeRemoval('Ben', 'Kim');
    renderProposal(log.state(), removal, 'kim', { onRespond: () => Promise.resolve() });
    expect(screen.getByRole('textbox', { name: 'Your response' })).toBeVisible();
  });

  it('shows her response to everyone as plain text, line breaks kept, and no form once she has', async () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    log.respond('Kim', removal, 'I wasn’t there.\n<b>Ask Dee.</b>');
    for (const me of ['ben', 'kim']) {
      renderProposal(log.state(), removal, me, { onRespond: () => Promise.resolve() });
      const block = screen.getByRole('region', { name: 'Kim’s response' });
      const text = within(block).getByText(/I wasn’t there\./);
      expect(text.tagName).toBe('BDI');
      expect(text.textContent).toBe('I wasn’t there.\n<b>Ask Dee.</b>');
      expect(block.querySelector('b')).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Your response' })).toBeNull();
      expect(await axeViolations()).toEqual([]);
      cleanup();
    }
  });

  it('shows Kim’s own response while it waits to send, with its status', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    const state = log.state();
    const pending = pendingOf(state, 'removal-response', {
      proposal: removal,
      text: 'On its way.',
    });
    renderProposal(state, removal, 'kim', { pending, onRespond: () => Promise.resolve() });
    const block = screen.getByRole('region', { name: 'Kim’s response' });
    expect(block).toHaveTextContent('On its way.');
    expect(within(block).getByText(/Sending/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Your response' })).toBeNull();
  });

  it('shows no form while leaving, and nothing on a closed removal with no response', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    renderProposal(log.state(), removal, 'kim', {
      leaving: true,
      onRespond: () => Promise.resolve(),
    });
    expect(screen.queryByRole('textbox', { name: 'Your response' })).toBeNull();
    cleanup();
    renderProposal(log.state(START_MINUTE + 14 * DAY_MINUTES), removal, 'ben');
    expect(screen.queryByText(paragraph('Kim hasn’t posted a response.'))).toBeNull();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Remove Kim from the group' }),
    ).toBeVisible();
  });

  it('shows a removal waiting to send as what its ballot will decide', () => {
    const log = five();
    const state = log.state();
    const { bytes, id } = createEvent({
      type: 'proposal',
      group: state.group ?? '',
      author: authorOf('ana'),
      ts: 0,
      body: { target: { kind: 'remove', member: KIM }, title: 'Remove Kim', why: 'Threats.' },
    });
    const pending = [parseEvent(bytes)].flatMap((event) => (event === null ? [] : [event]));
    renderProposal(state, id, 'ana', { pending });
    expect(
      screen.getByRole('heading', { level: 3, name: 'Remove Kim from the group' }),
    ).toBeVisible();
  });
});

describe('a removal’s result', () => {
  it('says Kim is no longer in the group, and to Kim that she isn’t', async () => {
    const { state, removal } = removed();
    renderProposal(state, removal, 'ben');
    expect(screen.getByText('This passed.', { exact: false })).toHaveTextContent(
      'This passed. Kim is no longer in this group.',
    );
    expect(await axeViolations()).toEqual([]);
    cleanup();
    renderProposal(state, removal, 'kim');
    expect(screen.getByText('This passed. You’re no longer in this group.')).toBeVisible();
    expect(screen.getByText(/This Proposal would remove you/)).toBeVisible();
  });

  it('lists its reasons when it fails, and offers nothing to propose again', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    for (const [voter, score] of [
      ['Ana', 0],
      ['Ben', 0],
      ['Cal', 4],
      ['Dee', 4],
    ] as const) {
      log.vote(voter, removal, score, 'Talk first.');
    }
    renderProposal(log.state(), removal, 'ben');
    expect(screen.getByText('This didn’t pass.')).toBeVisible();
    expect(screen.getByText('Too many zeros: 2 of 4.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Propose again' })).toBeNull();
  });
});

describe('the removed member’s copy (ADR-0016)', () => {
  it('says plainly that they keep what they had and won’t see anything new, with no controls', async () => {
    const { state, edit } = removed();
    const passedAt = state.removals[0]?.passedAt ?? 0;
    const onRemove = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const user = renderHome(state, 'kim', {
      sync: { reachable: false, lastSyncAt: null, deviceNow: 0, missingHistory: true },
      onRemove,
    });
    expect(
      screen.getByText(
        `You were removed from this group by a vote on ${formatDate(passedAt)}. You keep what’s already on this device, but you won’t see anything new.`,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Can’t reach the relay/)).toBeNull();
    const cut = screen.getByRole('region', { name: 'Open when you were removed' });
    // What the vote cut off leads; the Dispatches this device kept follow it (#112).
    const order = Array.from(document.querySelectorAll('h2.eyebrow'), (h) => h.textContent);
    expect(order.indexOf('Dispatches')).toBeGreaterThan(
      order.indexOf('Open when you were removed'),
    );
    const card = within(cut).getByRole('link', { name: /Later quiet hours/ });
    expect(card).toHaveTextContent('You won’t see how this ends');
    expect(card).toHaveAttribute('href', `#/g/${state.group ?? ''}/p/${edit}`);
    for (const name of ['People', 'Stewards', 'Rules', 'Invite people', 'Needs your vote']) {
      expect(screen.queryByRole('region', { name })).toBeNull();
    }
    expect(screen.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    expect(screen.queryByText(/A steward suspended you/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Remove from this device' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this group from this device?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove from this device' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('shows a Proposal open when they were removed as cut off, with no ballot', async () => {
    const { state, edit } = removed();
    renderProposal(state, edit, 'kim');
    expect(screen.getByText('Open Proposal')).toBeVisible();
    expect(screen.getByText('You won’t see how this ends')).toBeVisible();
    expect(screen.queryByRole('radiogroup', { name: 'Your score' })).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('reads a decided Proposal they weren’t eligible on as a read-only copy', () => {
    const log = five();
    const removal = log.proposeRemoval('Ana', 'Kim');
    for (const voter of ['Ana', 'Ben', 'Cal', 'Dee']) log.vote(voter, removal, 4);
    log.minute += 1;
    // Opened once Kim's removal had passed, so she isn't in its eligible set.
    const steward = log.steward('Ana', 1, 'Ben');
    log.remove('Ben', removal);
    const state = log.state(log.minute + 8 * DAY_MINUTES);
    renderProposal(state, steward, 'kim');
    expect(
      screen.getByText('This is a read-only copy. Nothing new can be proposed or voted on.'),
    ).toBeVisible();
  });
});
