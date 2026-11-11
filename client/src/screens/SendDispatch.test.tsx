/**
 * Send a Dispatch (#112): a title, a text and an optional Document, shown
 * only to someone who holds `dispatch`. The form counts code points after
 * NFC, as the fold's limits do, and queues nothing it would refuse.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { DispatchValues, RisingValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { SendDispatch } from './SendDispatch';

const [FOLLOWING, VOTING] = LEVELS;
const { sendDispatch } = messages;

interface Options {
  readonly me?: string;
  readonly leaving?: boolean;
  readonly fails?: boolean;
  /** Whether the group sits in a formed coalition, so a Dispatch can rise (#126). */
  readonly rises?: boolean;
}

function renderSend(state: GroupState, options: Options = {}) {
  const { me = 'ana', leaving = false, fails = false, rises = false } = options;
  const saved = () =>
    fails ? Promise.reject(new Error('IndexedDB refused the write.')) : Promise.resolve();
  const onSend = vi.fn<(values: DispatchValues) => Promise<void>>(saved);
  const onPropose = vi.fn<(values: RisingValues) => Promise<void>>(saved);
  render(
    <SendDispatch
      state={state}
      me={authorOf(me)}
      leaving={leaving}
      onSend={onSend}
      {...(rises ? { onPropose } : {})}
    />,
  );
  return { user: userEvent.setup(), onSend, onPropose };
}

/** Ana founds; Ben joins as a Collaborator and Kim as a Member. */
function group() {
  return groupLog({ members: ['Ben', 'Kim'], levels: { Ben: VOTING, Kim: FOLLOWING } });
}

const title = () => screen.getByRole('textbox', { name: 'Title' });
const text = () => screen.getByRole('textbox', { name: 'Text (optional)' });
const submit = () => screen.getByRole('button', { name: 'Send Dispatch' });

async function fill(user: UserEvent, heading: string, body = ''): Promise<void> {
  await user.click(title());
  await user.paste(heading);
  if (body === '') return;
  await user.click(text());
  await user.paste(body);
}

describe('SendDispatch', () => {
  it('asks for a title, a text and, optionally, a Document, saying who sees it', async () => {
    renderSend(group().state());
    expect(screen.getByRole('heading', { level: 1, name: 'Send a Dispatch' })).toBeVisible();
    expect(document.title).toBe('Send a Dispatch · Reconcile');
    expect(screen.getByText(sendDispatch.lede)).toBeVisible();
    expect(title()).toHaveValue('');
    expect(text()).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'No Document' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'House rules' })).not.toBeChecked();
    expect(screen.getByText(sendDispatch.visibility)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('queues the trimmed title and text with no Document', async () => {
    const { user, onSend } = renderSend(group().state());
    await fill(user, '  Meet on Sunday  ', '  Bring a chair.\nWe start at 10.  ');
    await user.click(submit());
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      title: 'Meet on Sunday',
      text: 'Bring a chair.\nWe start at 10.',
      doc: null,
    });
  });

  it('queues the Document chosen', async () => {
    const log = group();
    const { user, onSend } = renderSend(log.state());
    await fill(user, 'Read the rules');
    await user.click(screen.getByText('House rules'));
    expect(screen.getByRole('radio', { name: 'House rules' })).toBeChecked();
    await user.click(submit());
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      title: 'Read the rules',
      text: '',
      doc: log.group,
    });
  });

  it('refuses an 81-code-point title, with a message tied to the field, and queues nothing', async () => {
    const { user, onSend } = renderSend(group().state());
    await fill(user, 'a'.repeat(81));
    await user.click(submit());
    expect(onSend).not.toHaveBeenCalled();
    expect(title()).toBeInvalid();
    expect(title()).toHaveAccessibleDescription(
      `${sendDispatch.titleHint} Keep the title to 80 characters or fewer.`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('takes 80 code points, counted after NFC, so 80 decomposed é send', async () => {
    const { user, onSend } = renderSend(group().state());
    await fill(user, 'é'.repeat(80));
    await user.click(submit());
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('refuses a 501-code-point text and a blank title, and queues nothing', async () => {
    const { user, onSend } = renderSend(group().state());
    await fill(user, '   ', 'b'.repeat(501));
    await user.click(submit());
    expect(onSend).not.toHaveBeenCalled();
    expect(title()).toHaveAccessibleDescription(
      `${sendDispatch.titleHint} ${sendDispatch.titleMissing}`,
    );
    expect(text()).toHaveAccessibleDescription(
      `${sendDispatch.textHint} Keep it to 500 characters or fewer.`,
    );
  });

  it('says so when the Dispatch couldn’t be saved, and lets them try again', async () => {
    const { user, onSend } = renderSend(group().state(), { fails: true });
    await fill(user, 'Meet on Sunday');
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(sendDispatch.failed);
    expect(submit()).toBeEnabled();
    await user.click(submit());
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a Collaborator', 'ben'],
    ['a Member', 'kim'],
  ])('shows %s no form, only why', async (_who, me) => {
    renderSend(group().state(), { me });
    expect(
      screen.getByRole('heading', { level: 1, name: sendDispatch.notAllowedTitle }),
    ).toBeVisible();
    expect(screen.getByText(sendDispatch.notAllowed)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers how far it can go once the group sits in a formed coalition, this group only first (#126)', async () => {
    renderSend(group().state(), { rises: true });
    const picker = screen.getByRole('radiogroup', { name: sendDispatch.ceilingLabel });
    const options = within(picker).getAllByRole('radio');
    expect(
      options.map(
        (option) => option.getAttribute('aria-label') ?? option.closest('label')?.textContent,
      ),
    ).toEqual(['This group only', 'One level up', 'Two levels up', 'As far as the coalitions go']);
    expect(within(picker).getByRole('radio', { name: 'This group only' })).toBeChecked();
    expect(within(picker).getByRole('radio', { name: 'One level up' })).toHaveAccessibleDescription(
      sendDispatch.ceilingHints[1],
    );
    expect(submit()).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('puts it to a vote with the ceiling chosen, its Document and the trimmed words, and says so (#126)', async () => {
    const log = group();
    const { user, onSend, onPropose } = renderSend(log.state(), { rises: true });
    await fill(user, '  Rally Saturday  ', 'Meet at the river.');
    await user.click(screen.getByText('House rules'));
    await user.click(screen.getByText('As far as the coalitions go'));
    expect(screen.getByText(sendDispatch.visibilityVote)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send Dispatch' })).toBeNull();
    await user.click(screen.getByRole('button', { name: sendDispatch.submitVote }));
    expect(onPropose).toHaveBeenCalledExactlyOnceWith({
      title: 'Rally Saturday',
      text: 'Meet at the river.',
      doc: log.group,
      ceiling: 'coalitions',
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    ['One level up', 1],
    ['Two levels up', 2],
  ] as const)('reads %s as a ceiling of %s (#126)', async (label, ceiling) => {
    const { user, onPropose } = renderSend(group().state(), { rises: true });
    await fill(user, 'Rally');
    await user.click(screen.getByText(label));
    await user.click(screen.getByRole('button', { name: sendDispatch.submitVote }));
    expect(onPropose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ceiling }));
  });

  it('sends it at once with This group only, as before (#126)', async () => {
    const { user, onSend, onPropose } = renderSend(group().state(), { rises: true });
    await fill(user, 'Meet on Sunday');
    await user.click(screen.getByText('One level up'));
    await user.click(screen.getByText('This group only'));
    await user.click(submit());
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      title: 'Meet on Sunday',
      text: '',
      doc: null,
    });
    expect(onPropose).not.toHaveBeenCalled();
  });

  it('offers no ceiling where the group sits in no formed coalition (#126)', () => {
    renderSend(group().state());
    expect(screen.queryByRole('radiogroup', { name: sendDispatch.ceilingLabel })).toBeNull();
  });

  it('shows a suspended Co-Creator until when, in place of the form', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.suspend('Ana', 'Ben', 'Spam.');
    renderSend(log.state(), { me: 'ben' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/A steward suspended you until/)).toBeVisible();
  });

  it('shows no form while this device’s leave waits for the relay', () => {
    renderSend(group().state(), { leaving: true });
    expect(screen.getByRole('heading', { level: 1, name: messages.leave.noProposingTitle }));
    expect(screen.getByText(sendDispatch.leaving)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
