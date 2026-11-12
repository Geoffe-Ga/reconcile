import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FollowLookup, FoundFollow } from '../app/follow';
import { messages } from '../app/messages';
import { base64url } from '../crypto/base64url';
import { axeViolations } from '../test/axe';
import { Follow, type FollowProps } from './Follow';

const SEED = new Uint8Array(32).fill(7);
const PAYLOAD = base64url(SEED);

const FOUND: FoundFollow = {
  coalitionId: 'coalition-1',
  entryId: 'entry-1',
  secret: new Uint8Array(32).fill(1),
  preview: {
    name: '<b>Eastside</b> Housing',
    groups: ['Riverside Tenants', '<img src=x onerror=alert(1)>'],
    excerpt: 'We keep rents **fair** and homes safe <script>alert(1)</script>.',
  },
  page: { records: [], cursor: 0, relayNow: 29_000_000, instance: 'i' },
};

function props(overrides: Partial<FollowProps> = {}): FollowProps {
  return {
    payload: PAYLOAD,
    heldSeed: null,
    lookup: vi.fn(() => Promise.resolve<FollowLookup>({ kind: 'found', found: FOUND })),
    onFollow: vi.fn(() => Promise.resolve(true)),
    onNotNow: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

describe('Follow (#124)', () => {
  it('shows the preview as plain text, markup and all, and follows on Follow', async () => {
    const user = userEvent.setup();
    const onFollow = vi.fn(() => Promise.resolve(true));
    const lookup = vi.fn(() => Promise.resolve<FollowLookup>({ kind: 'found', found: FOUND }));
    window.history.replaceState(null, '', `#follow/${PAYLOAD}`);
    render(<Follow {...props({ onFollow, lookup })} />);

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: '<b>Eastside</b> Housing',
    });
    expect(heading.querySelector('b')).toBeNull();
    expect(heading.querySelector('bdi')).toHaveTextContent('<b>Eastside</b> Housing');
    expect(window.location.hash).toBe('#/follow');
    expect(lookup).toHaveBeenCalledWith(SEED);
    const groups = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(groups).toEqual(['Riverside Tenants', '·<img src=x onerror=alert(1)>']);
    expect(document.querySelector('main img, main script')).toBeNull();
    expect(screen.getByText(/We keep rents/)).toHaveTextContent(FOUND.preview.excerpt);
    const button = screen.getByRole('button', { name: 'Follow' });
    expect(button).toHaveAccessibleDescription(messages.follow.hint);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.click(button);
    expect(onFollow).toHaveBeenCalledWith(FOUND);
  });

  it('leaves out the statement line when the preview has no excerpt', async () => {
    const found = { ...FOUND, preview: { ...FOUND.preview, excerpt: '' } };
    render(<Follow {...props({ lookup: () => Promise.resolve({ kind: 'found', found }) })} />);
    await screen.findByRole('button', { name: 'Follow' });
    expect(screen.queryByText(messages.follow.statementLabel)).not.toBeInTheDocument();
  });

  it('says following didn’t finish, and lets the person try again', async () => {
    const user = userEvent.setup();
    const onFollow = vi
      .fn<FollowProps['onFollow']>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('closed'))
      .mockResolvedValue(true);
    render(<Follow {...props({ onFollow })} />);

    const button = await screen.findByRole('button', { name: 'Follow' });
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.follow.failed);
    await user.click(button);
    expect(screen.getByRole('alert')).toHaveTextContent(messages.follow.failed);
    await user.click(button);
    expect(onFollow).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('drops the link on Not now, writing nothing', async () => {
    const user = userEvent.setup();
    const onNotNow = vi.fn();
    const onFollow = vi.fn(() => Promise.resolve(true));
    render(<Follow {...props({ onNotNow, onFollow })} />);
    const notNow = await screen.findByRole('button', { name: 'Not now' });
    expect(notNow).toHaveAccessibleDescription(messages.follow.notNowHint);
    await user.click(notNow);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onFollow).not.toHaveBeenCalled();
  });

  it('waits out a Follow under way before Not now does anything', async () => {
    const user = userEvent.setup();
    let finish: (done: boolean) => void = () => undefined;
    const onFollow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const onNotNow = vi.fn();
    render(<Follow {...props({ onFollow, onNotNow })} />);
    await user.click(await screen.findByRole('button', { name: 'Follow' }));
    await user.click(screen.getByRole('button', { name: 'Follow' }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onNotNow).not.toHaveBeenCalled();
    expect(onFollow).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it.each([
    ['a seed that doesn’t parse', 'not-a-seed'],
    ['a seed one character short', PAYLOAD.slice(1)],
  ])('reads %s as a damaged link and fetches nothing', async (_label, payload) => {
    const lookup = vi.fn(() => Promise.resolve<FollowLookup>({ kind: 'missing' }));
    render(<Follow {...props({ payload, lookup })} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: messages.follow.badLinkTitle }),
    ).toBeVisible();
    expect(screen.getByText(messages.follow.badLink)).toBeVisible();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reads an expired or damaged envelope as a damaged link', async () => {
    render(<Follow {...props({ lookup: () => Promise.resolve({ kind: 'missing' }) })} />);
    expect(await screen.findByText(messages.follow.badLink)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
  });

  it('opens a seed pasted on Start, held in memory', async () => {
    const lookup = vi.fn(() => Promise.resolve<FollowLookup>({ kind: 'found', found: FOUND }));
    render(<Follow {...props({ payload: null, heldSeed: SEED, lookup })} />);
    await screen.findByRole('button', { name: 'Follow' });
    expect(lookup).toHaveBeenCalledWith(SEED);
  });

  it('says when the relay can’t be reached, and tries again', async () => {
    const user = userEvent.setup();
    const lookup = vi
      .fn<FollowProps['lookup']>()
      .mockResolvedValueOnce({ kind: 'offline' })
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ kind: 'found', found: FOUND });
    render(<Follow {...props({ lookup })} />);

    expect(await screen.findByText(messages.follow.offline)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(messages.follow.offline)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Follow' })).toBeVisible();
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('opens a coalition this device already reads', async () => {
    const lookup = () => Promise.resolve<FollowLookup>({ kind: 'held', coalitionId: 'c-9' });
    render(<Follow {...props({ lookup })} />);
    const open = await screen.findByRole('link', { name: messages.follow.open });
    expect(open).toHaveAttribute('href', '#/c/c-9');
    expect(screen.getByText(messages.follow.held)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('reads a new link that arrives while it shows', async () => {
    const other = new Uint8Array(32).fill(9);
    const lookup = vi.fn(() => Promise.resolve<FollowLookup>({ kind: 'found', found: FOUND }));
    const view = render(<Follow {...props({ lookup })} />);
    await screen.findByRole('button', { name: 'Follow' });
    view.rerender(<Follow {...props({ lookup, payload: base64url(other) })} />);
    await screen.findByRole('button', { name: 'Follow' });
    expect(lookup).toHaveBeenLastCalledWith(other);
    expect(within(document.body).getAllByRole('main')).toHaveLength(1);
  });
});
