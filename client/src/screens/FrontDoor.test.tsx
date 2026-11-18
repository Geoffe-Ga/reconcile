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
import { type ApplyValues, DOCUMENTS_MAX, DOCUMENTS_MAX_BYTES } from '../door/apply';
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

/** Personal Documents as the device lists them (#425): the statement first, as it was written first. */
const STATEMENT = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  title: 'What I stand for',
  text: 'Fair rents.',
  createdAt: 1,
  updatedAt: 1,
};
const BIKES = { ...STATEMENT, id: 'BBBBBBBBBBBBBBBBBBBBBB', title: 'Bikes', text: 'I fix them.' };
const GARDEN = { ...STATEMENT, id: 'CCCCCCCCCCCCCCCCCCCCCC', title: 'Garden', text: 'Beans.' };
const NOTES = { ...STATEMENT, id: 'DDDDDDDDDDDDDDDDDDDDDD', title: '<b>Notes</b>', text: 'n' };

interface Options {
  readonly documents?: readonly (typeof STATEMENT)[];
  readonly page?: OpenPage | typeof CLOSED | null;
  readonly payload?: string;
  readonly asked?: boolean;
  readonly outcome?: 'sent' | 'failed' | Promise<'sent' | 'failed'>;
  readonly offline?: boolean;
  /** What the shelf says of the door (#432): it takes Documents, it's newly listed, or it can't be read. */
  readonly takes?: boolean | 'unreadable';
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
  const takes = options.takes ?? true;
  const takesDocuments = vi.fn<(address: string) => Promise<boolean>>(() =>
    takes === 'unreadable' ? Promise.reject(new Error('offline')) : Promise.resolve(takes),
  );
  render(
    <FrontDoor
      payload={options.payload ?? PAYLOAD}
      reader={reader}
      asked={asked}
      onApply={onApply}
      documents={options.documents ?? []}
      takesDocuments={takesDocuments}
      cardGroups={[]}
      onMakeCard={() => Promise.reject(new Error('Not on this device.'))}
    />,
  );
  return { user: userEvent.setup(), onApply, asked, fake, takesDocuments };
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

describe('FrontDoor: sending personal Documents with it (#425)', () => {
  /** The picker's group, once the page shows. */
  async function picker() {
    return screen.findByRole('group', { name: door.documentsLabel });
  }

  /** Kim fills both fields, ready to Send. */
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    await type(user, door.nameLabel, 'Kim');
    await type(user, door.messageLabel, 'Hello.');
  }

  it('offers each personal Document under the message, none checked, says who reads them, and passes axe', async () => {
    await setup({ documents: [STATEMENT, NOTES] });
    const group = await picker();
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'What I stand for',
      '<b>Notes</b>',
    ]);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(within(group).getByText('<b>Notes</b>').tagName).toBe('BDI');
    expect(document.querySelector('b')).toBeNull();
    expect(group).toHaveAccessibleDescription(door.documentsHint);
    expect(door.documentsHint).toBe(
      'This group’s members will read the ones you check. Another group you send them to could recognize the same words.',
    );
    const message = screen.getByRole('textbox', { name: door.messageLabel });
    const careful = screen.getByText(door.careful);
    // Under the message, above the caution and Send.
    expect(message.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(careful) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends the checked ones’ titles and text alone, in the order Personal lists them', async () => {
    const { user, onApply } = await setup({ documents: [STATEMENT, BIKES, GARDEN] });
    await fill(user);
    const group = await picker();
    await user.click(within(group).getByRole('checkbox', { name: 'Garden' }));
    await user.click(within(group).getByRole('checkbox', { name: 'What I stand for' }));
    expect(await axeViolations()).toEqual([]);
    await user.click(screen.getByRole('button', { name: door.send }));
    const [[, , values]] = onApply.mock.calls as [[Uint8Array, OpenPage, ApplyValues]];
    expect(values).toEqual({
      name: 'Kim',
      message: 'Hello.',
      documents: [
        { title: 'What I stand for', text: 'Fair rents.' },
        { title: 'Garden', text: 'Beans.' },
      ],
    });
  });

  it('sends none when none is checked, as an application without documents', async () => {
    const { user, onApply } = await setup({ documents: [STATEMENT] });
    await fill(user);
    await user.click(screen.getByRole('button', { name: door.send }));
    const [[, , values]] = onApply.mock.calls as [[Uint8Array, OpenPage, ApplyValues]];
    expect(values).toEqual({ name: 'Kim', message: 'Hello.' });
  });

  it('shows someone with no personal Documents nothing new', async () => {
    await setup({ documents: [] });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(screen.queryByRole('group', { name: door.documentsLabel })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(door.documentsHint)).toBeNull();
  });

  it('refuses Documents over the cap at the form with one form-error line, and sends nothing', async () => {
    const long = { ...BIKES, text: 'x'.repeat(DOCUMENTS_MAX_BYTES) };
    const { user, onApply } = await setup({ documents: [STATEMENT, long] });
    await fill(user);
    const group = await picker();
    await user.click(within(group).getByRole('checkbox', { name: 'Bikes' }));
    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(door.documentsTooLong);
    expect(line).toHaveClass('form-error');
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.form-error')).toHaveLength(1);
    expect(await axeViolations()).toEqual([]);
    await user.click(within(group).getByRole('checkbox', { name: 'Bikes' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(within(group).getByRole('checkbox', { name: 'What I stand for' }));
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('measures the copy Send seals: each title and text in NFC, which can grow past the cap', async () => {
    // U+0958 takes 3 bytes, and NFC makes it two code points of 3 bytes each.
    const grows = { ...BIKES, text: '\u0958'.repeat(10_000) };
    expect(new TextEncoder().encode(grows.text).length).toBeLessThan(DOCUMENTS_MAX_BYTES);
    const cafe = { ...GARDEN, title: 'Cafe\u0301', text: 'Cafe\u0301 beans.' };
    const { user, onApply } = await setup({ documents: [grows, cafe] });
    await fill(user);
    const group = await picker();
    await user.click(within(group).getByRole('checkbox', { name: 'Bikes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(door.documentsTooLong);
    await user.click(within(group).getByRole('checkbox', { name: 'Bikes' }));
    await user.click(within(group).getByRole('checkbox', { name: 'Cafe\u0301' }));
    await user.click(screen.getByRole('button', { name: door.send }));
    const [[, , values]] = onApply.mock.calls as [[Uint8Array, OpenPage, ApplyValues]];
    expect(values.documents).toEqual([{ title: 'Café', text: 'Café beans.' }]);
  });

  it('refuses a fourth Document at the form with one form-error line', async () => {
    const { user, onApply } = await setup({ documents: [STATEMENT, BIKES, GARDEN, NOTES] });
    await fill(user);
    const group = await picker();
    for (const box of within(group).getAllByRole('checkbox')) await user.click(box);
    const tooMany = door.documentsTooMany(DOCUMENTS_MAX);
    expect(await screen.findByRole('alert')).toHaveTextContent(tooMany);
    expect(tooMany).toBe('Send up to 3 Documents with one request.');
    await user.click(screen.getByRole('button', { name: door.send }));
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.form-error')).toHaveLength(1);
  });
});

describe('FrontDoor: a newly listed or held door takes no Documents (#432, listed-doors.md §5.3)', () => {
  it('offers no Documents and says why, asks the shelf about this door, and passes axe', async () => {
    const { takesDocuments } = await setup({ documents: [STATEMENT, BIKES], takes: false });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(screen.queryByRole('group', { name: door.documentsLabel })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(door.newlyListed)).toBeVisible();
    expect(door.newlyListed).toBe('This group is newly listed, so you can’t attach Documents yet.');
    expect(takesDocuments).toHaveBeenCalledWith(PAYLOAD);
    // Under the message, above the caution, where the picker would be.
    const message = screen.getByRole('textbox', { name: door.messageLabel });
    const line = screen.getByText(door.newlyListed);
    expect(message.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends the name and why alone', async () => {
    const { user, onApply } = await setup({ documents: [STATEMENT], takes: false });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    await type(user, door.nameLabel, 'Kim');
    await type(user, door.messageLabel, 'Hello.');
    await user.click(screen.getByRole('button', { name: door.send }));
    const [[, , values]] = onApply.mock.calls as [[Uint8Array, OpenPage, ApplyValues]];
    expect(values).toEqual({ name: 'Kim', message: 'Hello.' });
  });

  it('treats a shelf it can’t read as a newly listed door', async () => {
    await setup({ documents: [STATEMENT], takes: 'unreadable' });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(door.newlyListed)).toBeVisible();
  });

  it('says nothing of it to someone with no personal Documents', async () => {
    await setup({ documents: [], takes: false });
    await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(screen.queryByText(door.newlyListed)).toBeNull();
  });

  it('offers them, with no such line, at a door that takes them, and passes axe', async () => {
    await setup({ documents: [STATEMENT], takes: true });
    expect(await screen.findByRole('group', { name: door.documentsLabel })).toBeVisible();
    expect(screen.queryByText(door.newlyListed)).toBeNull();
    expect(await axeViolations()).toEqual([]);
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
