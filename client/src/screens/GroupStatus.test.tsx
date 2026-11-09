import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../test/axe';
import { GroupMissing, GroupSettingUp } from './GroupStatus';

describe('GroupMissing', () => {
  it('says the group isn’t on this device, and leads back to your groups', async () => {
    render(<GroupMissing />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'This group isn’t on this device' }),
    ).toBeVisible();
    expect(
      screen.getByText('Open an invite link to join it, or go back to your groups.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    expect(await axeViolations()).toEqual([]);
  });
});

describe('GroupSettingUp', () => {
  it('says the group is saved here and waiting for the relay', async () => {
    render(<GroupSettingUp />);
    expect(screen.getByRole('heading', { level: 1, name: 'Setting up your group' })).toBeVisible();
    expect(
      screen.getByText(
        'Your group is saved on this device. It appears here once it reaches the relay.',
      ),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });
});
