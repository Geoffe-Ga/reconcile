/**
 * The front door's screen (#121): the page as plain text, the form, Send,
 * and every state with no form: closed, damaged, offline and already asked.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { base64url } from '../crypto/base64url';
import { xchachaSeal } from '../crypto/seal';
import type { ApplyValues } from '../door/apply';
import { CLOSED } from '../door/keeper';
import { addressOf, type OpenPage, publishPage } from '../door/page';
import { createRelay } from '../net/relay';
import { axeViolations } from '../test/axe';
import { DOOR } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { held, pastPressFallback } from '../test/press';
import { FrontDoor } from './FrontDoor';

const { door } = messages;
const ADDRESS = addressOf(DOOR);
const PAYLOAD = base64url(ADDRESS);
const PAGE: OpenPage = {
  v: 1,
  open: true,
  name: 'Riverside Tenants',
  excerpt: 'We keep rents fair and homes safe on Riverside Ave…',
  box: base64url(new Uint8Array(32).fill(9)),
};

interface Options {
  readonly page?: OpenPage | typeof CLOSED | null;
  readonly payload?: string;
  readonly asked?: boolean;
  readonly outcome?: 'sent' | 'failed' | Promise<'sent' | 'failed'>;
  readonly offline?: boolean;
}

/** The screen over a fake relay holding `page` as the door's only copy. */
async function setup(options: Options = {}) {
  const fake = createFakeRelay();
  const reader = { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
  const page = options.page === undefined ? PAGE : options.page;
  // A closed page goes over an open one, as a narrowing's does: over no copy, none is posted.
  if (page === CLOSED) await publishPage(reader, DOOR, PAGE, fake.minute);
  if (page !== null) await publishPage(reader, DOOR, page, fake.minute);
  fake.offline = options.offline ?? false;
  const onApply = vi.fn<(a: Uint8Array, p: OpenPage, v: ApplyValues) => Promise<'sent' | 'failed'>>(
    () => Promise.resolve(options.outcome ?? 'sent'),
  );
  const asked = vi.fn(() => options.asked ?? false);
  render(
    <FrontDoor
      payload={options.payload ?? PAYLOAD}
      reader={reader}
      asked={asked}
      onApply={onApply}
    />,
  );
  return { user: userEvent.setup(), onApply, asked, fake };
}

/** Types `text` into the field labelled `label`. */
async function type(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  await user.click(screen.getByRole('textbox', { name: label }));
  await user.paste(text);
}

describe('FrontDoor: an open door', () => {
  it('shows the group’s name and excerpt as plain text, then the form, and passes axe', async () => {
    await setup({ page: { ...PAGE, name: '<b>Riverside</b> Tenants' } });
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: '<b>Riverside</b> Tenants',
    });
    expect(heading.querySelector('bdi')).not.toBeNull();
    expect(heading.querySelector('b')).toBeNull();
    expect(screen.getByText(PAGE.excerpt).tagName).toBe('BDI');
    expect(screen.queryByText(/people are in this group/)).toBeNull();
    expect(screen.getByRole('textbox', { name: door.nameLabel })).toBeVisible();
    expect(screen.getByRole('textbox', { name: door.messageLabel })).toBeVisible();
    expect(screen.getByText(door.careful)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /mail|phone|contact/i })).toBeNull();
    expect(document.title).not.toContain('Riverside');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows how many are in the group only when the page carries a count', async () => {
    await setup({ page: { ...PAGE, count: 12 } });
    expect(await screen.findByText('12 people are in this group.')).toBeVisible();
  });

  it('sends the name and why as typed, then says what comes next', async () => {
    const { user, onApply } = await setup();
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    await type(user, door.nameLabel, 'Kim');
    await type(user, door.messageLabel, 'I live at number 12.');
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [[address, page, values]] = onApply.mock.calls as [[Uint8Array, OpenPage, ApplyValues]];
    expect(base64url(address)).toBe(PAYLOAD);
    expect(page).toEqual(PAGE);
    expect(values).toEqual({ name: 'Kim', message: 'I live at number 12.' });
    const sent = await screen.findByRole('status');
    expect(sent).toHaveTextContent(
      'Sent. If someone in Riverside Tenants invites you, it shows on Your groups.',
    );
    expect(within(sent).getByText('Riverside Tenants').tagName).toBe('BDI');
    expect(screen.queryByRole('button', { name: door.send })).toBeNull();
    expect(screen.getByRole('link', { name: door.yourGroups })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('asks for both fields, and refuses a name over 120 and a why over 2,000 code points', async () => {
    const { user, onApply } = await setup();
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(screen.getByText(door.nameMissing)).toBeVisible();
    expect(screen.getByText(door.messageMissing)).toBeVisible();
    await type(user, door.nameLabel, '😀'.repeat(121));
    await type(user, door.messageLabel, 'm'.repeat(2001));
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(screen.getAllByText('Use 120 characters or fewer.')).toHaveLength(1);
    expect(screen.getByText('Use 2,000 characters or fewer.')).toBeVisible();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps the form and says so when Send fails, and sends once however often it’s pressed', async () => {
    const { user, onApply } = await setup({ outcome: 'failed' });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    await type(user, door.nameLabel, 'Kim');
    await type(user, door.messageLabel, 'Hello.');
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(await screen.findByRole('alert')).toHaveTextContent(door.failed);
    expect(screen.getByRole('button', { name: door.send })).toBeEnabled();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('sends once when Send is tapped again while it sends and sending fails (#193)', async () => {
    const sending = held<'sent' | 'failed'>();
    const { user, onApply } = await setup({ outcome: sending.promise });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    await type(user, door.nameLabel, 'Kim');
    await type(user, door.messageLabel, 'Hello.');
    const send = screen.getByRole('button', { name: door.send });
    await user.click(send);
    expect(send).toBeDisabled();
    await user.click(send);
    sending.resolve('failed');
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();
    expect(send).toBeEnabled();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('shows a device that already asked here what it sent, with no second form', async () => {
    const { asked } = await setup({ asked: true });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'You asked to join Riverside Tenants from this device. Any invite shows on Your groups.',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(asked).toHaveBeenCalledWith(PAYLOAD);
  });
});

describe('FrontDoor: no form', () => {
  it('reads a closed door, as a steward’s narrowing leaves it, as closed with no form', async () => {
    await setup({ page: CLOSED });
    expect(await screen.findByText('This front door is closed.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(door.pageTitle);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('reads a door with no page at all as closed', async () => {
    await setup({ page: null });
    expect(await screen.findByText('This front door is closed.')).toBeVisible();
  });

  it('reads a damaged link without a request', async () => {
    const { fake } = await setup({ page: null, payload: 'not-a-door' });
    expect(screen.getByText(door.damaged)).toBeVisible();
    expect(fake.requests).toEqual([]);
  });

  it('offers Try again while the relay can’t be reached, and reads the page once it can', async () => {
    const { user, fake } = await setup({ offline: true });
    expect(await screen.findByText(door.offline)).toBeVisible();
    fake.offline = false;
    await user.click(screen.getByRole('button', { name: door.retry }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
  });
});
