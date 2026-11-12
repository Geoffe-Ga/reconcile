import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CreateGroupValues } from '../app/actions';
import { axeViolations } from '../test/axe';
import { CreateGroup, type CreateOutcome } from './CreateGroup';

interface Entry {
  readonly groupName?: string;
  readonly yourName?: string;
  readonly chat?: string;
  readonly title?: string;
  readonly text?: string;
}

const FULL: Required<Entry> = {
  groupName: '  Riverside Tenants ',
  yourName: ' Ana',
  chat: ' https://chat.example.org/riverside ',
  title: 'House rules ',
  text: 'Quiet hours start at ten.\n\nBins go out on Tuesday.\n',
};

function setup(outcome: CreateOutcome = 'created') {
  const user = userEvent.setup();
  const onCreate = vi.fn<(values: CreateGroupValues) => Promise<CreateOutcome>>(() =>
    Promise.resolve(outcome),
  );
  render(<CreateGroup onCreate={onCreate} />);
  return { user, onCreate };
}

const box = (name: string) => screen.getByRole('textbox', { name });

const HINT =
  '**bold**, *italic*, # heading, - list, [link](https://…). End a line with \\ for a line break.';
const TEXT_HINT =
  'Leave a blank line between sections. Your group proposes changes one section at a time.';

async function fill(user: UserEvent, entry: Entry): Promise<void> {
  const fields: [string, string | undefined][] = [
    ['Group name', entry.groupName],
    ['Your name', entry.yourName],
    ['Chat link (optional)', entry.chat],
    ['Document title', entry.title],
    ['Document text', entry.text],
  ];
  // The first Document's title starts as Mission statement (#92), so a test's title replaces it.
  if (entry.title !== undefined) await user.clear(box('Document title'));
  for (const [label, value] of fields) {
    if (value === undefined || value === '') continue;
    await user.click(box(label));
    await user.paste(value);
  }
  await user.click(screen.getByRole('button', { name: 'Create group' }));
}

/** The block of Document `number` (#92): a group named "Document N". */
const block = (number: number) => screen.getByRole('group', { name: `Document ${String(number)}` });

/** Fills the title and text of Document `number`'s block. */
async function fillBlock(user: UserEvent, number: number, title: string, text: string) {
  const inBlock = within(block(number));
  await user.clear(inBlock.getByRole('textbox', { name: 'Document title' }));
  if (title !== '') {
    await user.click(inBlock.getByRole('textbox', { name: 'Document title' }));
    await user.paste(title);
  }
  if (text === '') return;
  await user.click(inBlock.getByRole('textbox', { name: 'Document text' }));
  await user.paste(text);
}

describe('CreateGroup', () => {
  it('asks for a group name, your name, a chat link, a Document title and its text', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Create a group' })).toBeInTheDocument();
    for (const label of ['Group name', 'Your name', 'Document title', 'Document text']) {
      expect(box(label)).toBeRequired();
    }
    expect(box('Chat link (optional)')).not.toBeRequired();
    expect(box('Document text').tagName).toBe('TEXTAREA');
    expect(box('Your name')).toHaveAccessibleDescription(
      'This name is only shown in this group. It doesn’t have to be your real name.',
    );
    expect(
      screen.getByText(
        'Everyone you invite sees the group name, your name, the chat link and this Document.',
      ),
    ).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('hands over the entries, trimmed', async () => {
    const { user, onCreate } = setup();
    await fill(user, FULL);
    expect(onCreate).toHaveBeenCalledWith({
      groupName: 'Riverside Tenants',
      yourName: 'Ana',
      chat: 'https://chat.example.org/riverside',
      documents: [{ title: 'House rules', text: FULL.text }],
    });
  });

  it('leaves the chat link out when it’s blank', async () => {
    const { user, onCreate } = setup();
    await fill(user, { ...FULL, chat: '' });
    expect(onCreate.mock.calls[0]?.[0].chat).toBeNull();
  });

  it('refuses a javascript: chat link, with the reason tied to the field', async () => {
    const { user, onCreate } = setup();
    await fill(user, { ...FULL, chat: 'javascript:alert(document.cookie)' });

    expect(onCreate).not.toHaveBeenCalled();
    const chat = box('Chat link (optional)');
    expect(chat).toHaveAttribute('aria-invalid', 'true');
    expect(chat).toHaveFocus();
    const error = screen.getByText('Use a web link that starts with https:// or http://.');
    expect(error).toBeVisible();
    expect(chat.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(await axeViolations()).toEqual([]);
  });

  it('names every missing entry, and sends nothing', async () => {
    const { user, onCreate } = setup();
    await fill(user, { title: '', text: '   \n\n  ' });

    expect(onCreate).not.toHaveBeenCalled();
    expect(box('Group name')).toHaveAccessibleDescription('Give your group a name.');
    expect(box('Your name')).toHaveAccessibleDescription(
      'This name is only shown in this group. It doesn’t have to be your real name. Add the name your group will see.',
    );
    expect(box('Document title')).toHaveAccessibleDescription(
      'For example, House rules or Our mission. Give the Document a title.',
    );
    expect(box('Document text')).toHaveAccessibleDescription(
      `${TEXT_HINT} Write at least one section. ${HINT}`,
    );
    expect(box('Group name')).toHaveFocus();
  });

  it('refuses names that are only spaces', async () => {
    const { user, onCreate } = setup();
    await fill(user, { ...FULL, groupName: '   ', yourName: '\t' });
    expect(onCreate).not.toHaveBeenCalled();
    expect(box('Group name')).toHaveAttribute('aria-invalid', 'true');
    expect(box('Your name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('ties a too-long Document to its text field', async () => {
    const { user } = setup('too-large');
    await fill(user, FULL);
    const text = box('Document text');
    expect(text).toHaveAttribute('aria-invalid', 'true');
    expect(text).toHaveAccessibleDescription(
      `${TEXT_HINT} This Document is too long to send. Shorten it, then try again. ${HINT}`,
    );
  });

  it('drops the too-long refusal when a shortened Document then fails to save', async () => {
    const { user, onCreate } = setup('too-large');
    await fill(user, FULL);
    const text = box('Document text');
    expect(text).toHaveAttribute('aria-invalid', 'true');

    onCreate.mockRejectedValueOnce(new Error('store unavailable'));
    await user.clear(text);
    await user.paste('Quiet hours start at ten.');
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your group couldn’t be saved on this device. Try again.',
    );
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]?.[0].documents[0]?.text).toBe('Quiet hours start at ten.');
    expect(text).not.toHaveAttribute('aria-invalid');
    expect(text).toHaveAccessibleDescription(`${TEXT_HINT} ${HINT}`);
  });

  it('says so when the group couldn’t be saved', async () => {
    const { user } = setup('failed');
    await fill(user, FULL);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your group couldn’t be saved on this device. Try again.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('creates once, however often the button is pressed while it works', async () => {
    const user = userEvent.setup();
    let finish: (outcome: CreateOutcome) => void = () => undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<CreateOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    render(<CreateGroup onCreate={onCreate} />);
    await fill(user, FULL);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    finish('failed');
    await screen.findByRole('alert');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('writes the Document in Write and Preview tabs, with the Markdown hint line', () => {
    setup();
    expect(screen.getByRole('tab', { name: 'Write' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeVisible();
    expect(box('Document text')).toHaveAccessibleDescription(`${TEXT_HINT} ${HINT}`);
  });

  it('previews each section as it will read, split where the group will see it split', async () => {
    const { user } = setup();
    await user.click(box('Document text'));
    await user.paste(
      '# House rules\n\nBe *kind*.  \r\nAsk first.\n\n\n- Quiet after ten\n- Bins out',
    );
    await user.click(screen.getByRole('tab', { name: 'Preview' }));

    const preview = screen.getByRole('tabpanel', { name: 'Preview' });
    expect(
      within(preview)
        .getAllByText(/^Section \d$/)
        .map((label) => label.textContent),
    ).toEqual(['Section 1', 'Section 2', 'Section 3']);
    expect(
      within(preview)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['House rules']);
    expect(within(preview).getByRole('heading', { level: 2, name: 'House rules' })).toBeVisible();
    expect(within(preview).getByText('kind', { selector: 'em' })).toBeVisible();
    expect(within(preview).getAllByRole('listitem')).toHaveLength(2);
    expect(await axeViolations()).toEqual([]);
  });

  it('says there is nothing to preview for blank text', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('tabpanel', { name: 'Preview' })).toHaveTextContent(
      'Nothing to preview yet.',
    );
  });

  it('starts with one Document block, titled Mission statement, which has no Remove (#92)', async () => {
    setup();
    expect(block(1)).toBeVisible();
    expect(screen.getAllByRole('group', { name: /^Document \d$/ })).toHaveLength(1);
    expect(within(block(1)).getByRole('textbox', { name: 'Document title' })).toHaveValue(
      'Mission statement',
    );
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add another Document' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('adds a Document block with Remove, and hands over every Document in order (#92)', async () => {
    const { user, onCreate } = setup();
    await user.click(screen.getByRole('button', { name: 'Add another Document' }));
    const second = within(block(2));
    await waitFor(() => {
      expect(second.getByRole('textbox', { name: 'Document title' })).toHaveFocus();
    });
    expect(second.getByRole('textbox', { name: 'Document title' })).toHaveValue('');
    expect(second.getByRole('button', { name: 'Remove Document 2' })).toHaveTextContent('Remove');
    expect(
      screen.getByText(
        'Everyone you invite sees the group name, your name, the chat link and these Documents.',
      ),
    ).toBeVisible();
    await fillBlock(user, 1, 'Mission statement', 'We share.\n\nWe meet weekly.');
    await fillBlock(user, 2, ' Budget ', 'We share costs.');
    await fill(user, { groupName: 'Riverside Tenants', yourName: 'Ana' });
    expect(onCreate).toHaveBeenCalledWith({
      groupName: 'Riverside Tenants',
      yourName: 'Ana',
      chat: null,
      documents: [
        { title: 'Mission statement', text: 'We share.\n\nWe meet weekly.' },
        { title: 'Budget', text: 'We share costs.' },
      ],
    });
    expect(await axeViolations()).toEqual([]);
  });

  it('removes one block and keeps the others’ words, numbered afresh (#92)', async () => {
    const { user, onCreate } = setup();
    const add = screen.getByRole('button', { name: 'Add another Document' });
    await user.click(add);
    await user.click(add);
    await fillBlock(user, 1, 'Mission statement', 'We share.');
    await fillBlock(user, 2, 'Chores', 'Ana cooks.');
    await fillBlock(user, 3, 'Budget', 'We share costs.');
    await user.click(within(block(2)).getByRole('button', { name: 'Remove Document 2' }));
    expect(screen.getAllByRole('group', { name: /^Document \d$/ })).toHaveLength(2);
    expect(within(block(2)).getByRole('textbox', { name: 'Document title' })).toHaveValue('Budget');
    expect(screen.getByRole('button', { name: 'Add another Document' })).toHaveFocus();
    await fill(user, { groupName: 'Riverside Tenants', yourName: 'Ana' });
    expect(onCreate.mock.calls[0]?.[0].documents).toEqual([
      { title: 'Mission statement', text: 'We share.' },
      { title: 'Budget', text: 'We share costs.' },
    ]);
  });

  it('names a missing title or text in any block, in that block, and sends nothing (#92)', async () => {
    const { user, onCreate } = setup();
    await user.click(screen.getByRole('button', { name: 'Add another Document' }));
    await fillBlock(user, 1, 'Mission statement', 'We share.');
    await fill(user, { groupName: 'Riverside Tenants', yourName: 'Ana' });
    expect(onCreate).not.toHaveBeenCalled();
    const second = within(block(2));
    expect(second.getByRole('textbox', { name: 'Document title' })).toHaveAccessibleDescription(
      'For example, House rules or Our mission. Give the Document a title.',
    );
    expect(second.getByRole('textbox', { name: 'Document text' })).toHaveAccessibleDescription(
      `${TEXT_HINT} Write at least one section. ${HINT}`,
    );
  });

  it('ties Documents too long to send together to the longest one’s text (#92)', async () => {
    const { user } = setup('too-large');
    await user.click(screen.getByRole('button', { name: 'Add another Document' }));
    await fillBlock(user, 1, 'Mission statement', 'We share.');
    await fillBlock(user, 2, 'Budget', 'We share costs, and we keep every receipt we get.');
    await fill(user, { groupName: 'Riverside Tenants', yourName: 'Ana' });
    const first = within(block(1)).getByRole('textbox', { name: 'Document text' });
    const longest = within(block(2)).getByRole('textbox', { name: 'Document text' });
    expect(first).not.toHaveAttribute('aria-invalid');
    expect(longest).toHaveAttribute('aria-invalid', 'true');
    expect(longest).toHaveAccessibleDescription(
      `${TEXT_HINT} Together, your Documents are too long to send. Shorten one, then try again. ${HINT}`,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('links back to your groups', () => {
    setup();
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
  });
});
