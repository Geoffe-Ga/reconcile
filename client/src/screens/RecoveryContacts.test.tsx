import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { held, pastPressFallback } from '../test/press';
import { RecoveryContacts, type RecoveryContactsProps } from './RecoveryContacts';

const RIVERSIDE = {
  groupId: 'riverside',
  name: 'Riverside Tenants',
  members: [
    { member: 'ben-key', name: 'Ben' },
    { member: 'cal-key', name: 'Cal' },
    { member: 'dee-key', name: 'Dee' },
  ],
};
const ALLOTMENT = {
  groupId: 'allotment',
  name: 'Allotment',
  members: [
    { member: 'eve-key', name: 'Eve' },
    { member: 'fay-key', name: 'Fay' },
    { member: 'gus-key', name: 'Gus' },
  ],
};

function setup(props: Partial<RecoveryContactsProps> = {}) {
  const all: RecoveryContactsProps = {
    groups: [RIVERSIDE, ALLOTMENT],
    current: null,
    onSave: vi.fn(() => Promise.resolve()),
    ...props,
  };
  render(<RecoveryContacts {...all} />);
  return { user: userEvent.setup(), ...all };
}

/** The number field labelled `name`'s input. */
function numberField(name: string): HTMLElement {
  return screen.getByRole('textbox', { name });
}

describe('RecoveryContacts', () => {
  it('starts at 3 of 5, says what a contact is and what picking means, and passes axe', async () => {
    setup();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Choose recovery contacts' }),
    ).toBeVisible();
    expect(document.title).toBe('Recovery contacts · Reconcile');
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '#/settings');
    expect(
      screen.getByText(/people you trust can help you get back into your groups/),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Pick people who know you and would answer a call from you. Pick people you’d trust with all your groups at once. If you pick the same person in two groups, they can tell both names are you.',
      ),
    ).toBeVisible();
    expect(numberField('People to pick')).toHaveValue('5');
    expect(numberField('Needed to help you back in')).toHaveValue('3');
    expect(
      screen.getByText('Any 3 of the 5 people you pick can help you back in together.'),
    ).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('0 of 5 picked.');
    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeDisabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('lists each group’s people under its name, each name in <bdi>', () => {
    setup();

    const riverside = screen.getByRole('group', { name: 'People in Riverside Tenants' });
    expect(
      within(riverside)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['Ben', 'Cal', 'Dee']);
    expect(within(riverside).getByText('Ben').tagName).toBe('BDI');
    const allotment = screen.getByRole('group', { name: 'People in Allotment' });
    expect(within(allotment).getAllByRole('checkbox')).toHaveLength(3);
  });

  it('saves once exactly n are picked, in the order the screen lists them', async () => {
    const { user, onSave } = setup();

    for (const name of ['Fay', 'Ben', 'Dee', 'Eve']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(screen.getByRole('status')).toHaveTextContent('4 of 5 picked.');
    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Cal' }));
    expect(screen.getByRole('status')).toHaveTextContent('5 of 5 picked.');
    await user.click(screen.getByRole('button', { name: 'Save recovery contacts' }));

    expect(onSave).toHaveBeenCalledWith({
      t: 3,
      contacts: [
        { groupId: 'riverside', member: 'ben-key' },
        { groupId: 'riverside', member: 'cal-key' },
        { groupId: 'riverside', member: 'dee-key' },
        { groupId: 'allotment', member: 'eve-key' },
        { groupId: 'allotment', member: 'fay-key' },
      ],
    });
  });

  it('says when too many are picked, and saves at the new count once it matches', async () => {
    const { user, onSave } = setup();
    for (const name of ['Ben', 'Cal', 'Dee', 'Eve']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }

    const people = numberField('People to pick');
    await user.clear(people);
    await user.type(people, '3');
    await user.tab();
    expect(screen.getByRole('status')).toHaveTextContent(
      '4 picked. Pick 3, or change how many people to pick.',
    );
    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Eve' }));
    await user.click(screen.getByRole('button', { name: 'Save recovery contacts' }));

    expect(onSave).toHaveBeenCalledWith({
      t: 3,
      contacts: [
        { groupId: 'riverside', member: 'ben-key' },
        { groupId: 'riverside', member: 'cal-key' },
        { groupId: 'riverside', member: 'dee-key' },
      ],
    });
  });

  it('keeps the threshold between 2 and 5 and never above the number of people', async () => {
    const { user } = setup();
    const people = numberField('People to pick');
    const needed = numberField('Needed to help you back in');

    // Needed comes down with the people to pick, never above them.
    await user.click(screen.getByRole('button', { name: 'Increase Needed to help you back in' }));
    expect(needed).toHaveValue('4');
    await user.clear(people);
    await user.type(people, '3');
    await user.tab();
    expect(needed).toHaveValue('3');
    expect(
      screen.getByText('Any 3 of the 3 people you pick can help you back in together.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Increase Needed to help you back in' }));
    expect(needed).toHaveValue('3');
    await user.click(screen.getByRole('button', { name: 'Decrease Needed to help you back in' }));
    await user.click(screen.getByRole('button', { name: 'Decrease Needed to help you back in' }));
    expect(needed).toHaveValue('2');
    expect(
      screen.getByText('Any 2 of the 3 people you pick can help you back in together.'),
    ).toBeVisible();

    await user.clear(people);
    await user.type(people, '9');
    await user.tab();
    expect(people).toHaveValue('7');
    await user.clear(needed);
    await user.type(needed, '6');
    await user.tab();
    expect(needed).toHaveValue('5');
  });

  it('chooses again from the contacts who still share a group, at the same threshold', async () => {
    const { user, onSave } = setup({
      current: {
        t: 2,
        n: 3,
        chooseAgain: false,
        contacts: [
          {
            groupId: 'riverside',
            member: 'ben-key',
            name: 'Ben',
            groupName: 'Riverside Tenants',
            shared: true,
          },
          {
            groupId: 'riverside',
            member: 'old-key',
            name: 'Old',
            groupName: 'Riverside Tenants',
            shared: false,
          },
          {
            groupId: 'allotment',
            member: 'fay-key',
            name: 'Fay',
            groupName: 'Allotment',
            shared: true,
          },
        ],
      },
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Choose again' })).toBeVisible();
    expect(
      screen.getByText(
        'Choosing again gives everyone you pick a new share. Every share you gave before stops working, even for people you pick again.',
      ),
    ).toBeVisible();
    expect(numberField('People to pick')).toHaveValue('3');
    expect(numberField('Needed to help you back in')).toHaveValue('2');
    expect(screen.getByRole('checkbox', { name: 'Ben' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Fay' })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 picked.');
    await user.click(screen.getByRole('checkbox', { name: 'Gus' }));
    await user.click(screen.getByRole('button', { name: 'Save recovery contacts' }));

    expect(onSave).toHaveBeenCalledWith({
      t: 2,
      contacts: [
        { groupId: 'riverside', member: 'ben-key' },
        { groupId: 'allotment', member: 'fay-key' },
        { groupId: 'allotment', member: 'gus-key' },
      ],
    });
  });

  it('says so while it saves, and again if saving failed, keeping the picks', async () => {
    let fail: (error: Error) => void = () => undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { user } = setup({ groups: [RIVERSIDE], onSave });
    await user.clear(numberField('People to pick'));
    await user.type(numberField('People to pick'), '3');
    await user.tab();
    for (const name of ['Ben', 'Cal', 'Dee']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    await user.click(screen.getByRole('button', { name: 'Save recovery contacts' }));

    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Backing up your groups and sending each share…',
    );
    fail(new Error('offline'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Your recovery contacts couldn’t be saved. Try again.',
      );
    });
    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Cal' })).toBeChecked();
  });

  /** Picks all three people in Riverside at 3 of 3, with saving held until the test settles it. */
  async function heldSave() {
    const saving = held<undefined>();
    const onSave = vi.fn(() => saving.promise);
    const { user } = setup({ groups: [RIVERSIDE], onSave });
    await user.clear(numberField('People to pick'));
    await user.type(numberField('People to pick'), '3');
    await user.tab();
    for (const name of ['Ben', 'Cal', 'Dee']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    await user.click(screen.getByRole('button', { name: 'Save recovery contacts' }));
    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeDisabled();
    return { user, onSave, saving };
  }

  it('saves once when Save is tapped again while it saves and the save fails (#193)', async () => {
    const { user, onSave, saving } = await heldSave();

    await user.click(screen.getByRole('button', { name: 'Save recovery contacts' }));
    saving.reject();
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();

    expect(screen.getByRole('button', { name: 'Save recovery contacts' })).toBeEnabled();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps a pick that is tapped while it saves and the save fails (#193)', async () => {
    const { user, saving } = await heldSave();

    expect(screen.getByRole('checkbox', { name: 'Cal' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Cal' }));
    saving.reject();
    expect(await screen.findByRole('alert')).toBeVisible();
    await pastPressFallback();

    expect(screen.getByRole('checkbox', { name: 'Cal' })).toBeEnabled();
    for (const name of ['Ben', 'Cal', 'Dee']) {
      expect(screen.getByRole('checkbox', { name })).toBeChecked();
    }
    expect(screen.getByRole('status')).toHaveTextContent('3 of 3 picked.');
  });

  it('says plainly when no one can hold a share yet, with nothing to save', async () => {
    setup({ groups: [] });

    expect(
      screen.getByText(
        'No one in your groups can hold a share yet. Once someone joins a group with you, you can pick them here.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save recovery contacts' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
