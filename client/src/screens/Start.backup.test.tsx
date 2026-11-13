/** Start's Restore a backup and its link to Settings (#78). */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { Start } from './Start';

describe('Start', () => {
  it('offers Restore a backup under “Have a backup file?”, for a new device, and passes axe', async () => {
    render(
      <Start
        groups={[]}
        onOpenInvite={vi.fn()}
        onRestore={vi.fn(() =>
          Promise.resolve({ groups: 1, skipped: 0, skippedDocuments: 0, older: false }),
        )}
      />,
    );

    const section = screen.getByRole('region', { name: 'Have a backup file?' });
    expect(within(section).getByRole('button', { name: 'Choose backup file' })).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers no Restore when it isn’t given one', () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} />);

    expect(screen.queryByRole('region', { name: 'Have a backup file?' })).not.toBeInTheDocument();
  });

  it('links to Settings, quietly, last', () => {
    render(<Start groups={[]} onOpenInvite={vi.fn()} persistence="denied" />);

    const links = screen.getAllByRole('link');
    expect(links.at(-1)).toHaveAccessibleName('Settings');
    expect(links.at(-1)).toHaveAttribute('href', '#/settings');
  });
});
