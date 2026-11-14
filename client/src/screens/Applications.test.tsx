/**
 * Applications on group home (#121): each one's name, message and date as
 * plain text, Send an invite while this member may record it, "Invited by"
 * once the log says so, and Dismiss on this device only.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { base64url } from '../crypto/base64url';
import { LEVELS } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import type { ReceivedApplication } from '../store/applications';
import { axeViolations } from '../test/axe';
import { DOOR } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { Applications, type InviteOutcome } from './Applications';

const { door } = messages;
const [, VOTING] = LEVELS;

/** An application id: a SHA-256, from repeated `byte`s. */
const idOf = (byte: number) => base64url(new Uint8Array(32).fill(byte));

/** An application read from the inbox. */
function application(byte: number, name: string, message: string): ReceivedApplication {
  return {
    id: idOf(byte),
    seq: byte,
    received: START_MINUTE,
    name,
    message,
    reply: { seed: idOf(1), key: idOf(2) },
  };
}

const KIM = application(0xa1, 'Kim', 'I live at number 12.\nI fix bikes.');
const LEE = application(0xa2, '<i>Lee</i>', 'Hello.');

/** Ana, Ben and Cal's group with the door open; Cal votes but doesn't propose. */
function opened() {
  const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: VOTING } });
  const open = log.rules('Ana', 'frontDoor', DOOR);
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, open, 4);
  log.minute += 1;
  return log;
}

function setup(state: GroupState, applications: readonly ReceivedApplication[], me = 'cal') {
  const onInvite = vi.fn<(id: string) => Promise<InviteOutcome>>(() => Promise.resolve('sent'));
  const onDismiss = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
  document.title = 'Your group · Reconcile';
  render(
    <main>
      <Applications
        state={state}
        me={authorOf(me)}
        applications={applications}
        onInvite={onInvite}
        onDismiss={onDismiss}
      />
    </main>,
  );
  return { user: userEvent.setup(), onInvite, onDismiss };
}

/** The card of the application from `name`. */
function card(name: string): HTMLElement {
  const item = screen.getAllByRole('listitem').find((li) => li.textContent.includes(name));
  if (item === undefined) throw new Error(`Expected ${name}’s application.`);
  return item;
}

describe('Applications', () => {
  it('lists each application’s name, message and day as plain text, and passes axe', async () => {
    setup(opened().state(), [KIM, LEE]);
    expect(screen.getByText(door.applicationsLede)).toBeVisible();
    expect(within(card('Kim')).getByText('Kim').tagName).toBe('BDI');
    expect(within(card('Kim')).getByText(/I live at number 12\./).tagName).toBe('BDI');
    expect(within(card('<i>Lee</i>')).getByText('<i>Lee</i>')).toBeVisible();
    expect(document.querySelector('i')).toBeNull();
    const time = card('Kim').querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe(new Date(START_MINUTE * 60_000).toISOString());
    expect(time?.textContent).toMatch(/^Asked \w{3} \d{1,2} \w{3}$/);
    expect(await axeViolations()).toEqual([]);
  });

  it('sends an invite for one, says it went, and offers no second', async () => {
    const { user, onInvite } = setup(opened().state(), [KIM]);
    await user.click(screen.getByRole('button', { name: 'Send an invite to Kim' }));
    expect(onInvite).toHaveBeenCalledWith(KIM.id);
    expect(await within(card('Kim')).findByText(door.inviteSent)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send an invite to Kim' })).toBeNull();
  });

  it('says when the invite didn’t go, and offers it again', async () => {
    const { user, onInvite } = setup(opened().state(), [KIM]);
    onInvite.mockResolvedValueOnce('failed');
    await user.click(screen.getByRole('button', { name: 'Send an invite to Kim' }));
    expect(await within(card('Kim')).findByText(door.inviteFailed)).toBeVisible();
    onInvite.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Send an invite to Kim' }));
    expect(await within(card('Kim')).findByText(door.inviteFailed)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send an invite to Kim' })).toBeEnabled();
  });

  it('reads who invited them once the log records it, with no Send an invite', () => {
    const log = opened();
    log.doorInvited('Ben', KIM.id);
    setup(log.state(), [KIM, LEE]);
    const invited = card('Kim').querySelector('.application-invited');
    expect(invited?.textContent).toBe('Invited by Ben');
    expect(invited?.querySelector('bdi')?.textContent).toBe('Ben');
    expect(screen.queryByRole('button', { name: 'Send an invite to Kim' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send an invite to <i>Lee</i>' })).toBeVisible();
  });

  it('dismisses one on this device only, and hides those already dismissed', async () => {
    const { user, onDismiss } = setup(opened().state(), [KIM, { ...LEE, dismissed: true }]);
    expect(screen.queryByText('<i>Lee</i>')).toBeNull();
    const dismiss = screen.getByRole('button', { name: 'Dismiss Kim’s application' });
    expect(dismiss).toHaveAccessibleDescription(door.dismissHint);
    await user.click(dismiss);
    expect(onDismiss).toHaveBeenCalledWith(KIM.id);
  });

  it('shows each Document sent with one as a disclosure under the message, its text plain (#425)', async () => {
    const text =
      '# Rent\n\n**Fair** rents, see https://rent.test and [our list](https://list.test).\n  <i>Now</i>.';
    const documents = [
      { title: 'What I stand for', text },
      { title: '<b>Bikes</b>', text: 'I fix them.' },
    ];
    const { user } = setup(opened().state(), [{ ...KIM, documents }, LEE]);
    const kim = card('Kim');
    const group = within(kim).getByRole('group', { name: door.documentsSent });
    const [statement, bikes] = within(group).getAllByRole('button');
    expect(statement).toHaveAccessibleName('What I stand for');
    expect(bikes).toHaveAccessibleName('<b>Bikes</b>');
    expect(within(group).getByText('<b>Bikes</b>').tagName).toBe('BDI');
    expect(statement).toHaveAttribute('aria-expanded', 'false');
    expect(within(group).getByText(/Fair/)).not.toBeVisible();
    const message = within(kim).getByText(/I live at number 12\./);
    expect(message.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await axeViolations()).toEqual([]);

    await user.click(statement ?? kim);
    expect(statement).toHaveAttribute('aria-expanded', 'true');
    expect(within(group).getByText(/Fair/)).toBeVisible();
    const words = kim.querySelector('.application-document-text');
    expect(words?.textContent).toBe(text);
    expect(words?.querySelector('bdi')?.textContent).toBe(text);
    for (const tag of ['a', 'b', 'i', 'h1', 'strong']) expect(kim.querySelector(tag)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(await axeViolations()).toEqual([]);
    // Lee sent none, so Lee's card shows nothing new.
    expect(within(card('<i>Lee</i>')).queryByRole('group')).toBeNull();
  });

  it('says no one has asked yet', () => {
    setup(opened().state(), [{ ...KIM, dismissed: true }]);
    expect(screen.getByText(door.noApplications)).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
