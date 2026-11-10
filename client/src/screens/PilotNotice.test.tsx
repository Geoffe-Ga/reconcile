import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import { axeViolations } from '../test/axe';
import { PilotNotice } from './PilotNotice';

describe('PilotNotice', () => {
  it('covers ADR-0056’s four topics on one screen, every word from the messages module', async () => {
    render(<PilotNotice onAccept={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: messages.notice.title })).toBeVisible();
    expect(document.title).toBe(`${messages.notice.pageTitle} · Reconcile`);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'What’s stored',
      'What the relay can see',
      'Data can be lost',
      'This is a test',
    ]);
    for (const topic of messages.notice.topics) {
      const section = screen.getByRole('region', { name: topic.heading });
      for (const line of topic.lines) expect(within(section).getByText(line)).toBeVisible();
      for (const item of topic.list) expect(within(section).getByText(item)).toBeVisible();
    }
    expect(await axeViolations()).toEqual([]);
  });

  it('says plainly what the relay can see, never just timing and sizes', () => {
    render(<PilotNotice onAccept={vi.fn()} />);
    const relay = screen.getByRole('region', { name: 'What the relay can see' });
    expect(
      within(relay)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'your device’s IP address while it’s connected, though the relay doesn’t log it',
      'when messages arrive',
      'each message’s size class, one of four sizes',
      'which mailboxes your device checks',
    ]);
    expect(document.body).not.toHaveTextContent(/only timing and sizes/i);
  });

  it('accepts with I understand', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    render(<PilotNotice onAccept={onAccept} />);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
