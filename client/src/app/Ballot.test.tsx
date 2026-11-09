import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Score } from '../engine/event';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp, proposeFrom } from '../test/members';
import { Ballot, type BallotProps } from './Ballot';
import { castBallot } from './proposals';

freshIndexedDBPerTest();

const PILLS = [
  '0 · Strongly opposed',
  '1 · Opposed',
  '2 · Neutral',
  '3 · Supportive',
  '4 · Strongly supportive',
];

type OnVote = (score: Score, note: string) => Promise<void>;

function setup(props: Partial<BallotProps> = {}) {
  const onVote = vi.fn<OnVote>(() => Promise.resolve());
  const all: BallotProps = {
    initialScore: null,
    initialNote: '',
    hasVoted: false,
    isDisabled: false,
    pending: false,
    reachable: true,
    onVote,
    ...props,
  };
  document.title = 'Proposal · Reconcile';
  render(
    <main>
      <h1>Proposal</h1>
      <Ballot {...all} />
    </main>,
  );
  return { user: userEvent.setup(), onVote: props.onVote ?? onVote };
}

const note = () => screen.getByRole('textbox');
const send = () => screen.getByRole('button', { name: /your vote/ });

describe('Ballot', () => {
  it('offers five score pills, each with its number and label, and a note', async () => {
    setup();
    const group = screen.getByRole('radiogroup', { name: 'Your score' });
    const pills = within(group).getAllByRole('radio');
    expect(pills.map((radio) => radio.closest('label')?.textContent)).toEqual(PILLS);
    for (const name of PILLS) expect(screen.getByRole('radio', { name })).not.toBeChecked();
    expect(group).toHaveAccessibleDescription('Everyone in your group sees your score and note.');
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).not.toBeRequired();
    expect(send()).toHaveTextContent('Send your vote');
    expect(await axeViolations()).toEqual([]);
  });

  it('colors each pill from its own score token', () => {
    setup();
    const classes = PILLS.map(
      (name) => screen.getByRole('radio', { name }).closest('label')?.className,
    );
    expect(classes).toEqual([0, 1, 2, 3, 4].map((n) => `score-pill score-pill-${String(n)}`));
  });

  it('sends the chosen score and note', async () => {
    const { user, onVote } = setup();
    await user.click(screen.getByRole('radio', { name: '3 · Supportive' }));
    await user.type(note(), 'Works for me.');
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith(3, 'Works for me.');
  });

  it('asks for a score before sending', async () => {
    const { user, onVote } = setup();
    await user.click(send());
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.getByRole('radiogroup')).toHaveAccessibleDescription(
      'Everyone in your group sees your score and note. Choose a score from 0 to 4.',
    );
  });

  it('blocks a 0 without a reason, with a visible message tied to the note', async () => {
    const { user, onVote } = setup();
    await user.click(screen.getByRole('radio', { name: '0 · Strongly opposed' }));
    const reason = screen.getByRole('textbox', { name: 'Your reason for a 0' });
    expect(reason).toBeRequired();
    await user.type(reason, '   ');
    await user.click(send());

    expect(onVote).not.toHaveBeenCalled();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText('Add your reason for the 0.');
    expect(error).toBeVisible();
    expect(reason.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(await axeViolations()).toEqual([]);

    await user.type(reason, 'It would end band practice.');
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith(0, '   It would end band practice.');
  });

  it('drops the need for a reason when the 0 changes to another score', async () => {
    const { user, onVote } = setup();
    await user.click(screen.getByRole('radio', { name: '0 · Strongly opposed' }));
    await user.click(send());
    expect(onVote).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: '1 · Opposed' }));
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).not.toBeRequired();
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith(1, '');
  });

  it('clears the missing-reason message as soon as the 0 changes, so Send stays put', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('radio', { name: '0 · Strongly opposed' }));
    await user.click(send());
    expect(screen.getByText('Add your reason for the 0.')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: '3 · Supportive' }));
    expect(screen.queryByText('Add your reason for the 0.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).not.toHaveAttribute(
      'aria-invalid',
    );
  });

  it('counts the note’s limit in code points after NFC, not UTF-16 units', async () => {
    const { user, onVote } = setup();
    await user.click(screen.getByRole('radio', { name: '2 · Neutral' }));
    await user.click(note());
    // 280 "é" typed as e + combining accent: 560 code points, 280 after NFC.
    await user.paste('é'.repeat(280));
    await user.click(send());
    expect(onVote).toHaveBeenCalledTimes(1);

    await user.click(note());
    await user.paste('x');
    await user.click(send());
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(note()).toHaveAccessibleDescription('Keep the note to 280 characters or fewer.');
  });

  it('starts from the ballot already cast, and offers to update it', () => {
    setup({ initialScore: 4, initialNote: 'Yes please.', hasVoted: true });
    expect(screen.getByRole('radio', { name: '4 · Strongly supportive' })).toBeChecked();
    expect(note()).toHaveValue('Yes please.');
    expect(send()).toHaveTextContent('Update your vote');
  });

  it('is disabled, and says why, once voting has closed', async () => {
    setup({ isDisabled: true, initialScore: 3, initialNote: 'Fine by me.', hasVoted: true });
    for (const name of PILLS) expect(screen.getByRole('radio', { name })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    expect(note()).toBeDisabled();
    expect(note()).toHaveValue('Fine by me.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Voting has closed, so this ballot can’t change.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('leaves out an empty note and the send button once voting has closed', () => {
    setup({ isDisabled: true });
    for (const name of PILLS) expect(screen.getByRole('radio', { name })).not.toBeChecked();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('stays disabled while it saves, and sends once however often it is pressed', async () => {
    let finish: () => void = () => undefined;
    const onVote = vi.fn<OnVote>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = setup({ onVote });
    await user.click(screen.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(send());
    expect(send()).toBeDisabled();
    await user.click(send());
    finish();
    expect(await screen.findByText('Sent')).toBeVisible();
    expect(send()).toBeEnabled();
    expect(onVote).toHaveBeenCalledTimes(1);
  });

  it('says so when the ballot couldn’t be saved', async () => {
    const onVote = vi.fn<OnVote>(() => Promise.reject(new Error('quota')));
    const { user } = setup({ onVote });
    await user.click(screen.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your vote couldn’t be saved on this device. Try again.',
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('shows where a ballot waiting in the outbox has got to', () => {
    setup({ pending: true, reachable: false, hasVoted: true, initialScore: 2 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved on this device. It will send when you’re back online.',
    );
  });
});

describe('Ballot, in the app', () => {
  const mounted: MountedApp[] = [];
  const opened: TestDevice[] = [];

  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount();
    for (const device of opened.splice(0)) device.services.store.close();
    window.history.replaceState(null, '', '#/');
  });

  it('replaces a voter’s earlier ballot in the result when they vote again before the close', async () => {
    const user = userEvent.setup();
    const { groupId, devices } = await members(createFakeRelay(), ['Ana', 'Ben', 'Cy']);
    opened.push(...devices);
    const [ana, ben, cy] = devices;
    if (ana === undefined || ben === undefined || cy === undefined) throw new Error('Expected 3.');
    go(`#/g/${groupId}/doc`);
    const app = mountApp(ben.services, 'b');
    mounted.push(app);
    const b = within(app.container);
    await proposeFrom(b, user, 2, {
      title: 'Bins on Monday',
      text: 'Bins go out on Monday.',
    });

    // Ben first blocks his own Proposal with a 0, then changes his mind before the close.
    await user.click(await b.findByRole('radio', { name: '0 · Strongly opposed' }));
    await user.type(b.getByRole('textbox', { name: 'Your reason for a 0' }), 'Wrong day.');
    await user.click(b.getByRole('button', { name: 'Send your vote' }));
    await b.findByText('Sent');
    await user.click(b.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(b.getByRole('button', { name: 'Update your vote' }));
    await waitFor(() => {
      expect(b.getByRole('status')).toHaveTextContent(/^Sent$/);
    });

    // Ana and Cy score 3. Were Ben's 0 still counted, a third of the scores would be zeros.
    const proposal = window.location.hash.split('/').at(-1) ?? '';
    for (const device of [ana, cy]) {
      await device.services.sync.syncOnce();
      const me = (await device.services.store.getGroup(groupId))?.me.author ?? '';
      await castBallot(device.services, groupId, me, { proposal, score: 3, note: '' });
      await device.services.sync.syncOnce();
    }
    await act(() => ben.services.sync.syncOnce());
    expect(await b.findByRole('region', { name: 'Result' })).toHaveTextContent(
      'This passed. The Document now reads:Bins go out on Monday.',
    );
  });
});
