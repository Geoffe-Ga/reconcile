/**
 * Send a Dispatch (#112): a title, a text and an optional Document, shown
 * only to someone who holds `dispatch`. The form counts code points after
 * NFC, as the fold's limits do, and queues nothing it would refuse.
 */
import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { DispatchValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { axeViolations } from '../test/axe';
import { authorOf } from '../test/keys';
import { held, pastPressFallback } from '../test/press';
import { groupLog } from '../test/votes';
import { SendDispatch } from './SendDispatch';

const [FOLLOWING, VOTING] = LEVELS;
const { sendDispatch } = messages;

interface Options {
  readonly me?: string;
  readonly leaving?: boolean;
  readonly fails?: boolean;
  /** What every send returns, in place of `fails`. */
  readonly sending?: Promise<void>;
}

function renderSend(state: GroupState, options: Options = {}) {
  const { me = 'ana', leaving = false, fails = false, sending } = options;
  const onSend = vi.fn<(values: DispatchValues) => Promise<void>>(
    () =>
      sending ??
      (fails ? Promise.reject(new Error('IndexedDB refused the write.')) : Promise.resolve()),
  );
  render(<SendDispatch state={state} me={authorOf(me)} leaving={leaving} onSend={onSend} />);
  return { user: userEvent.setup(), onSend };
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

  it('sends once when it is tapped again while it sends and the save fails (#193)', async () => {
    const sending = held<undefined>();
    const { user, onSend } = renderSend(group().state(), { sending: sending.promise });
    await fill(user, 'Meet on Sunday');
    await user.click(submit());
    expect(submit()).toBeDisabled();
    await user.click(submit());
    sending.reject();
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(submit()).toBeEnabled();
    expect(onSend).toHaveBeenCalledTimes(1);
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
