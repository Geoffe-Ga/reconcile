import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { testGroup, type TestGroupOptions } from '../test/groups';
import { GroupHome } from './GroupHome';

const LINK = 'https://reconcile.example/#/join/mailbox.secret';

function setup(options: TestGroupOptions = {}, me?: string) {
  const group = testGroup({ joiners: ['Ben'], ...options });
  const copyText = vi.fn(() => Promise.resolve());
  render(
    <GroupHome
      state={group.state}
      me={me ?? group.founder}
      inviteLink={LINK}
      copyText={copyText}
    />,
  );
  return { user: userEvent.setup(), copyText, state: group.state };
}

const section = (name: string) => screen.getByRole('region', { name });

describe('GroupHome', () => {
  it('shows the group, its Document, open Proposals, people, the invite and the chat', async () => {
    const { state } = setup({ chat: 'https://chat.example.org/riverside' });

    expect(screen.getByRole('heading', { level: 1, name: 'Riverside Tenants' })).toBeVisible();
    expect(screen.getByText('Your group', { selector: 'p' })).toBeVisible();
    const documentLink = screen.getByRole('link', { name: /House rules/ });
    expect(documentLink).toHaveAttribute('href', `#/g/${state.group ?? ''}/doc`);
    expect(within(section('Open Proposals')).getByText('Nothing to vote on yet.')).toBeVisible();
    const people = within(section('People')).getAllByRole('listitem');
    expect(people.map((item) => item.textContent)).toEqual(['Ana', 'Ben']);
    const field = within(section('Invite people')).getByRole('textbox', { name: 'Invite link' });
    expect(field).toHaveValue(LINK);
    expect(field).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/riverside',
    );
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });

  it('copies the invite link, and says so', async () => {
    const { user, copyText } = setup();
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(copyText).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copied. Send it to the people you’re inviting.',
    );
  });

  it('points to the field when the browser blocks copying', async () => {
    const user = userEvent.setup();
    const group = testGroup();
    const copyText = vi.fn(() => Promise.reject(new Error('blocked')));
    render(
      <GroupHome state={group.state} me={group.founder} inviteLink={LINK} copyText={copyText} />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copying is blocked here. Select the link above and copy it yourself.',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('selects the whole link when the field takes focus', async () => {
    const { user } = setup();
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Invite link' });
    await user.click(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(LINK.length);
  });

  it('lists the open Proposals by title', () => {
    setup({ proposals: ['Later quiet hours on Fridays'] });
    const open = section('Open Proposals');
    expect(within(open).getByRole('listitem')).toHaveTextContent('Later quiet hours on Fridays');
    expect(within(open).queryByText('Nothing to vote on yet.')).not.toBeInTheDocument();
  });

  it('shows people and the invite only to someone who may see them', () => {
    setup({}, 'stranger');
    expect(screen.queryByRole('region', { name: 'People' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Invite people' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
  });

  it.each([
    ['no chat link', undefined],
    ['a javascript: chat link', 'javascript:alert(1)'],
  ])('offers no Join discussion for %s', (_label, chat) => {
    setup(chat === undefined ? {} : { chat });
    expect(screen.queryByRole('link', { name: /Join discussion/ })).not.toBeInTheDocument();
  });
});
