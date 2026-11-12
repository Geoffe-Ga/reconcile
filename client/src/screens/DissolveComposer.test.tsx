import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SendOutcome } from '../app/useSend';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { held, pastPressFallback } from '../test/press';
import { groupLog } from '../test/votes';
import { DissolveComposer, type DissolveComposerProps } from './DissolveComposer';

const [, VOTING] = LEVELS;

/** Wed 11 Nov 2026 at noon UTC: the device clock the closing line counts from. */
const NOW = Date.UTC(2026, 10, 11, 12);
const WARNING =
  'Each copy of Reconcile will erase this group. No app can stop someone who already kept a copy, a screenshot or a backup file.';

type OnPropose = DissolveComposerProps['onPropose'];

interface Options {
  readonly me?: string;
  readonly leaving?: boolean;
  readonly outcome?: SendOutcome | Error | Promise<SendOutcome>;
}

function renderComposer(state: GroupState, options: Options = {}) {
  const { me = 'ana', leaving = false, outcome = 'proposed' } = options;
  const onPropose = vi.fn<OnPropose>(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
  );
  render(
    <DissolveComposer
      state={state}
      me={authorOf(me)}
      now={NOW}
      leaving={leaving}
      onPropose={onPropose}
    />,
  );
  return { user: userEvent.setup(), onPropose };
}

/** Ana founds; Ben joins as a Co-Creator and Cal as a Collaborator. */
function group() {
  return groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
}

async function fill(user: UserEvent, title: string, why: string): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: 'Title' }));
  await user.paste(title);
  await user.click(screen.getByRole('textbox', { name: 'Why' }));
  await user.paste(why);
}

const days = () => screen.getByRole('textbox', { name: 'Voting time (days)' });

async function typeDays(user: UserEvent, value: string): Promise<void> {
  await user.clear(days());
  await user.type(days(), value);
}

describe('DissolveComposer', () => {
  it('says what passing does and the bar it needs, with the wipe unchecked and its warning tied to it', async () => {
    renderComposer(group().state());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Propose dissolving the group' }),
    ).toBeVisible();
    expect(document.title).toBe('Propose dissolving · Reconcile');
    expect(screen.getByText(/If your group passes this, it ends\./)).toBeVisible();
    expect(
      screen.getByText(
        'Dissolving needs more support than an ordinary change: an average of at least 3.0, with under 5% zeros.',
      ),
    ).toBeVisible();
    const wipe = screen.getByRole('checkbox', { name: 'Also erase it from every device' });
    expect(wipe).not.toBeChecked();
    expect(wipe).toHaveAccessibleDescription(WARNING);
    expect(days()).toHaveValue('14');
    expect(await axeViolations()).toEqual([]);
  });

  it('queues the title, why, entrenched voting time and wipe the proposer chose', async () => {
    const { user, onPropose } = renderComposer(group().state());
    await fill(user, '  Dissolve Riverside  ', 'We have all moved out.');
    await typeDays(user, '21');
    await user.click(screen.getByRole('checkbox', { name: 'Also erase it from every device' }));
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Propose dissolving' }));
    expect(onPropose).toHaveBeenCalledExactlyOnceWith({
      title: 'Dissolve Riverside',
      why: 'We have all moved out.',
      window: 21,
      wipe: true,
    });
    expect(screen.getByRole('button', { name: 'Propose dissolving' })).toBeDisabled();
  });

  it('refuses 13 days, under the entrenched minimum, and sends once it is 14', async () => {
    const { user, onPropose } = renderComposer(group().state());
    await fill(user, 'Dissolve', 'Time to stop.');
    await typeDays(user, '13');
    await user.click(screen.getByRole('button', { name: 'Propose dissolving' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Choose from 14 to 28 days.')).toBeVisible();
    await typeDays(user, '14');
    await user.click(screen.getByRole('button', { name: 'Propose dissolving' }));
    expect(onPropose).toHaveBeenCalledExactlyOnceWith({
      title: 'Dissolve',
      why: 'Time to stop.',
      window: 14,
      wipe: false,
    });
  });

  it('asks for a title and a why before sending anything', async () => {
    const { user, onPropose } = renderComposer(group().state());
    await user.click(screen.getByRole('button', { name: 'Propose dissolving' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Give your Proposal a title.')).toBeVisible();
    expect(screen.getByText('Say why you’re proposing this.')).toBeVisible();
  });

  it('says when it couldn’t be saved, or was too long, and lets the proposer try again', async () => {
    const failing = renderComposer(group().state(), { outcome: new Error('quota') });
    await fill(failing.user, 'Dissolve', 'Done.');
    await failing.user.click(screen.getByRole('button', { name: 'Propose dissolving' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your Proposal couldn’t be saved on this device. Try again.',
    );
    expect(screen.getByRole('button', { name: 'Propose dissolving' })).toBeEnabled();
  });

  it('ties "too long to send" to the why', async () => {
    const { user } = renderComposer(group().state(), { outcome: 'too-large' });
    await fill(user, 'Dissolve', 'Done.');
    await user.click(screen.getByRole('button', { name: 'Propose dissolving' }));
    expect(
      await screen.findByText('This is too long to send. Shorten it, then try again.'),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Why' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('proposes once when it is tapped again while it proposes and the save fails (#193)', async () => {
    const proposing = held<SendOutcome>();
    const { user, onPropose } = renderComposer(group().state(), { outcome: proposing.promise });
    await fill(user, 'Dissolve', 'Done.');
    const propose = screen.getByRole('button', { name: 'Propose dissolving' });
    await user.click(propose);
    expect(propose).toBeDisabled();
    await user.click(propose);
    proposing.resolve('failed');
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(propose).toBeEnabled();
    expect(onPropose).toHaveBeenCalledTimes(1);
  });
});

describe('DissolveComposer: when there is no form', () => {
  it('tells someone who can’t propose why', () => {
    renderComposer(group().state(), { me: 'cal' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose dissolving now' }),
    ).toBeVisible();
    expect(screen.getByText('Your place in this group doesn’t include proposing.')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says a dissolve Proposal is already open', () => {
    const log = group();
    log.proposeDissolve('ana', false);
    renderComposer(log.state(), { me: 'ben' });
    expect(screen.getByText(/A Proposal to dissolve this group is already open\./)).toBeVisible();
  });

  it('offers nothing to someone leaving the group', () => {
    renderComposer(group().state(), { leaving: true });
    expect(screen.getByText('You can’t propose changes in a group you’re leaving.')).toBeVisible();
  });

  it('shows a suspended member when their suspension ends instead', () => {
    const log = group();
    log.suspend('ana', 'Ben', 'Threats.');
    renderComposer(log.state(), { me: 'ben' });
    expect(screen.getByText(/^A steward suspended you until /)).toBeVisible();
  });
});
