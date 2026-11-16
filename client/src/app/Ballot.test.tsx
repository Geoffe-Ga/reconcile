import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Score } from '../engine/event';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER, go, members, type MountedApp, mountApp, proposeFrom } from '../test/members';
import { pastPressFallback } from '../test/press';
import { Ballot, type BallotProps } from './Ballot';
import { castBallot } from './proposals';
import type { VersionView } from './versionViews';

freshIndexedDBPerTest();

const PILLS = [
  '0 · Strongly opposed',
  '1 · Opposed',
  '2 · Neutral',
  '3 · Supportive',
  '4 · Strongly supportive',
];

type OnVote = (scores: Readonly<Record<string, Score>>, note: string) => Promise<void>;

const CURRENT = 'Quiet hours start at ten.\n';
const V1: VersionView = { id: 'v1', number: 1, author: 'Ana', text: 'Quiet from eleven.\n' };
const V2: VersionView = { id: 'v2', number: 2, author: 'Ben', text: 'Quiet from midnight.\n' };
const V3: VersionView = { id: 'v3', number: 3, author: 'Cy', text: 'Quiet from nine.\n' };

function setup(props: Partial<BallotProps> = {}) {
  const onVote = vi.fn<OnVote>(() => Promise.resolve());
  const all: BallotProps = {
    versions: [V1],
    current: CURRENT,
    initialScores: {},
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
      <h2>Changes to section 1</h2>
      <Ballot {...all} />
    </main>,
  );
  return { user: userEvent.setup(), onVote: props.onVote ?? onVote };
}

const note = () => screen.getByRole('textbox');
const send = () => screen.getByRole('button', { name: /your vote/ });
const versionCard = (n: number) =>
  screen.getByRole('region', { name: new RegExp(`^Version ${String(n)} ·`) });
const scoreFor = (n: number) =>
  screen.getByRole('radiogroup', { name: `Score for version ${String(n)}` });

/** Picks `pill` in version `n`'s score group. */
async function pick(user: ReturnType<typeof userEvent.setup>, n: number, pill: string) {
  await user.click(within(scoreFor(n)).getByRole('radio', { name: pill }));
}

describe('Ballot', () => {
  it('offers five score pills, each with its number and label, and a note', async () => {
    setup();
    const group = scoreFor(1);
    const pills = within(group).getAllByRole('radio');
    expect(pills.map((radio) => radio.closest('label')?.textContent)).toEqual(PILLS);
    for (const name of PILLS) expect(screen.getByRole('radio', { name })).not.toBeChecked();
    expect(group).toHaveAccessibleDescription('Everyone in your group sees your scores and note.');
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).not.toBeRequired();
    expect(send()).toHaveTextContent('Send your vote');
    expect(await axeViolations()).toEqual([]);
  });

  it('scores a move like a one-version Proposal: its pills read “Your score” under where it moves the section (#103)', async () => {
    const move = { line: 'Moves this section to the start', text: 'Bins go out on Tuesday.\n' };
    const { user, onVote } = setup({
      versions: [{ id: 'm', number: 1, author: 'Ana', text: '', move }],
      current: null,
    });
    expect(screen.getByRole('region', { name: 'Moves this section to the start' })).toBeVisible();
    const pills = screen.getByRole('radiogroup', { name: 'Your score' });
    await user.click(within(pills).getByRole('radio', { name: '3 · Supportive' }));
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ m: 3 }, '');
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
    expect(onVote).toHaveBeenCalledWith({ v1: 3 }, 'Works for me.');
  });

  it('shows each version under its number and author, its diff, and its own five pills', async () => {
    setup({ versions: [V1, V2, V3] });
    for (const version of [V1, V2, V3]) {
      const card = screen.getByRole('region', {
        name: `Version ${String(version.number)} · ${version.author}`,
      });
      expect(card.querySelector('.word-diff')).not.toBeNull();
      const group = within(card).getByRole('radiogroup', {
        name: `Score for version ${String(version.number)}`,
      });
      expect(within(group).getAllByRole('radio')).toHaveLength(5);
    }
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
  });

  it('sends a score for every version, keyed by version id, with one note', async () => {
    const { user, onVote } = setup({ versions: [V1, V2] });
    await pick(user, 1, '2 · Neutral');
    await pick(user, 2, '4 · Strongly supportive');
    await user.type(note(), 'Midnight suits us.');
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 2, v2: 4 }, 'Midnight suits us.');
  });

  it('asks for a score on every version before sending', async () => {
    const { user, onVote } = setup({ versions: [V1, V2] });
    await pick(user, 1, '3 · Supportive');
    await user.click(send());
    expect(onVote).not.toHaveBeenCalled();
    expect(scoreFor(2)).toHaveAccessibleDescription(
      'Choose a score from 0 to 4. Everyone in your group sees your scores and note.',
    );
    await pick(user, 2, '1 · Opposed');
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 3, v2: 1 }, '');
  });

  it('needs a reason when any version scores 0', async () => {
    const { user, onVote } = setup({ versions: [V1, V2] });
    await pick(user, 1, '4 · Strongly supportive');
    await pick(user, 2, '0 · Strongly opposed');
    const reason = screen.getByRole('textbox', { name: 'Your reason for a 0' });
    expect(reason).toBeRequired();
    await user.click(send());
    expect(onVote).not.toHaveBeenCalled();
    await user.type(reason, 'Midnight is too late.');
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 4, v2: 0 }, 'Midnight is too late.');
  });

  it('asks what would make it a 3 when a voter gives a 1 and no 0, keeping the note optional', async () => {
    const { user, onVote } = setup({ versions: [V1, V2] });
    await pick(user, 1, '1 · Opposed');
    await pick(user, 2, '3 · Supportive');
    const prompt = screen.getByRole('textbox', { name: 'What would make this a 3 for you?' });
    expect(prompt).not.toBeRequired();
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 1, v2: 3 }, '');
    await pick(user, 2, '0 · Strongly opposed');
    expect(screen.getByRole('textbox', { name: 'Your reason for a 0' })).toBeRequired();
    await pick(user, 2, '4 · Strongly supportive');
    await pick(user, 1, '2 · Neutral');
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).not.toBeRequired();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows what goes under each version’s pills, such as its consent meter', () => {
    setup({
      versions: [V1, V2],
      below: (version) => <p>{`Meter for ${version.id}`}</p>,
    });
    expect(within(versionCard(1)).getByText('Meter for v1')).toBeVisible();
    expect(within(versionCard(2)).getByText('Meter for v2')).toBeVisible();
  });

  it('prefills the earlier ballot and asks for a score on a version added since', async () => {
    const { user, onVote } = setup({
      versions: [V1, V2],
      initialScores: { v1: 3 },
      initialNote: 'Fine by me.',
      hasVoted: true,
    });
    expect(
      screen.getByText('A new version was added. Score it to update your ballot.'),
    ).toBeVisible();
    expect(within(scoreFor(1)).getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    for (const radio of within(scoreFor(2)).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(note()).toHaveValue('Fine by me.');
    expect(send()).toHaveTextContent('Update your vote');
    expect(await axeViolations()).toEqual([]);
    await pick(user, 2, '2 · Neutral');
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 3, v2: 2 }, 'Fine by me.');
  });

  it('asks for nothing new when the earlier ballot scores every version', () => {
    setup({ versions: [V1, V2], initialScores: { v1: 3, v2: 1 }, hasVoted: true });
    expect(screen.queryByText(/A new version was added/)).not.toBeInTheDocument();
  });

  it('asks for nothing new once voting has closed', () => {
    setup({ versions: [V1, V2], initialScores: { v1: 3 }, hasVoted: true, isDisabled: true });
    expect(screen.queryByText(/A new version was added/)).not.toBeInTheDocument();
  });

  it('ignores an earlier score for a version that isn’t on this ballot', async () => {
    const { user, onVote } = setup({ initialScores: { v1: 2, gone: 4 }, hasVoted: true });
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 2 }, '');
  });

  it('asks for a score before sending', async () => {
    const { user, onVote } = setup();
    await user.click(send());
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.getByRole('radiogroup')).toHaveAccessibleDescription(
      'Choose a score from 0 to 4. Everyone in your group sees your scores and note.',
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
    expect(onVote).toHaveBeenCalledWith({ v1: 0 }, '   It would end band practice.');
  });

  it('drops the need for a reason when the 0 changes to another score', async () => {
    const { user, onVote } = setup();
    await user.click(screen.getByRole('radio', { name: '0 · Strongly opposed' }));
    await user.click(send());
    expect(onVote).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: '1 · Opposed' }));
    expect(
      screen.getByRole('textbox', { name: 'What would make this a 3 for you?' }),
    ).not.toBeRequired();
    await user.click(send());
    expect(onVote).toHaveBeenCalledWith({ v1: 1 }, '');
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
    setup({ initialScores: { v1: 4 }, initialNote: 'Yes please.', hasVoted: true });
    expect(screen.getByRole('radio', { name: '4 · Strongly supportive' })).toBeChecked();
    expect(note()).toHaveValue('Yes please.');
    expect(send()).toHaveTextContent('Update your vote');
  });

  it('is disabled, and says why, once voting has closed', async () => {
    setup({
      isDisabled: true,
      initialScores: { v1: 3 },
      initialNote: 'Fine by me.',
      hasVoted: true,
    });
    for (const name of PILLS) expect(screen.getByRole('radio', { name })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '3 · Supportive' })).toBeChecked();
    expect(note()).toBeDisabled();
    expect(note()).toHaveValue('Fine by me.');
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
    expect(screen.getByText('Voting has closed, so this ballot can’t change.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('leaves out an empty note and the send button once voting has closed', () => {
    setup({ isDisabled: true });
    for (const name of PILLS) expect(screen.getByRole('radio', { name })).not.toBeChecked();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /your vote/ })).not.toBeInTheDocument();
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
    // A press on a disabled React Aria button still gets pointerdown and pointerup
    // (Chromium sends both), and usePress clicks the button itself when no click
    // follows within 80 ms. Wait past that so a late click can't hide (#190).
    await pastPressFallback();
    expect(send()).toBeEnabled();
    expect(screen.getByText('Sent')).toBeVisible();
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
    setup({ pending: true, reachable: false, hasVoted: true, initialScores: { v1: 2 } });
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
    const user = userEvent.setup(APP_USER);
    const { groupId, devices } = await members(createFakeRelay(), ['Ana', 'Ben']);
    opened.push(...devices);
    const [ana, ben] = devices;
    if (ana === undefined || ben === undefined) throw new Error('Expected 2.');
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
    await user.click(b.getByRole('textbox', { name: 'Your reason for a 0' }));
    await user.paste('Wrong day.');
    await user.click(b.getByRole('button', { name: 'Send your vote' }));
    await b.findByText('Sent');
    await user.click(b.getByRole('radio', { name: '4 · Strongly supportive' }));
    await user.click(b.getByRole('button', { name: 'Update your vote' }));
    // The ballot's own status line: Tell your group has one of its own on this page (#77).
    await waitFor(() => {
      expect(app.container.querySelector('.ballot-send [role="status"]')).toHaveTextContent(
        /^Sent$/,
      );
    });

    // Ana scores 3. Were Ben's 0 still counted, at least a third of the scores would be zeros.
    const proposal = window.location.hash.split('/').at(-1) ?? '';
    await ana.services.sync.syncOnce();
    await castBallot(ana.services, groupId, { proposal, scores: { [proposal]: 3 }, note: '' });
    await ana.services.sync.syncOnce();
    await act(() => ben.services.sync.syncOnce());
    expect(await b.findByRole('region', { name: 'Result' })).toHaveTextContent(
      'This passed. The Document now reads:Bins go out on Monday.',
    );
  });
});
