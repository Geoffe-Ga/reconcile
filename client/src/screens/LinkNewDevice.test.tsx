/**
 * Link a new device on the existing device (#96): the code as a QR code and
 * text, the number with Match and Don't match, and every way a round ends,
 * against a fake link the test steps through.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINK_POLL_MS } from '../app/useLink';
import { linkCode, newLinkKeys, newLinkSeed } from '../crypto/link';
import type { LinkOffer, OfferStep } from '../link/session';
import { axeViolations } from '../test/axe';
import { LinkNewDevice } from './LinkNewDevice';

/** A fake link: a real-looking code, and a step the test sets. */
function fakeOffer() {
  let step: OfferStep = { kind: 'waiting' };
  const offer = {
    code: linkCode(newLinkSeed(), newLinkKeys().publicKey),
    expiresAt: 0,
    poll: vi.fn(() => Promise.resolve(step)),
    confirm: vi.fn((): Promise<'sent' | 'expired'> => Promise.resolve('sent')),
    drop: vi.fn(),
  } satisfies LinkOffer;
  return {
    offer,
    show: (next: OfferStep) => {
      step = next;
    },
  };
}

/** Lets the fake clock run `ms`, so polls and their answers land. */
async function wait(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Renders the screen on a fresh fake link for each round; returns every link it made. */
function setup(copyText = vi.fn(() => Promise.resolve())) {
  const made: ReturnType<typeof fakeOffer>[] = [];
  const start = vi.fn(() => {
    const next = fakeOffer();
    made.push(next);
    return next.offer;
  });
  const view = render(<LinkNewDevice start={start} copyText={copyText} />);
  return { made, start, copyText, view };
}

/** The one link made so far. */
function only(made: readonly ReturnType<typeof fakeOffer>[]) {
  const [first, ...rest] = made;
  if (first === undefined || rest.length > 0) throw new Error('Expected exactly one link.');
  return first;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LinkNewDevice', () => {
  it('shows the code as a QR code and as text, with Copy the code and how long it lasts', async () => {
    const { made, copyText } = setup();
    await wait();
    const { offer } = only(made);

    expect(screen.getByRole('heading', { level: 1, name: 'Link a new device' })).toBeVisible();
    expect(document.title).toBe('Link a new device · Reconcile');
    expect(
      screen.getByText(
        'On your new device, open Reconcile and tap Link to my other device. Then scan this code, or paste it there.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('img', { name: 'Linking code' })).toBeVisible();
    expect(screen.getByText(offer.code)).toBeVisible();
    expect(
      screen.getByText(
        'This code works for 10 minutes. Nothing is sent until you check a number on both devices.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Waiting for your new device…')).toBeVisible();
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '#/settings');
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Copy the code' }));
    await wait();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(offer.code);
    expect(screen.getByText('Copied. Paste it on your new device.')).toBeVisible();
  });

  it('says to select the code when the browser blocks the clipboard', async () => {
    setup(vi.fn(() => Promise.reject(new Error('blocked'))));
    await wait();

    fireEvent.click(screen.getByRole('button', { name: 'Copy the code' }));
    await wait();

    expect(
      screen.getByText('The code couldn’t be copied. Select it and copy it instead.'),
    ).toBeVisible();
  });

  it('looks every 2 seconds, then shows the number and asks, with Match and Don’t match', async () => {
    const { made } = setup();
    await wait();
    const link = only(made);
    expect(link.offer.poll).toHaveBeenCalledTimes(1);
    await wait(LINK_POLL_MS - 1);
    expect(link.offer.poll).toHaveBeenCalledTimes(1);

    link.show({ kind: 'compare', number: '042719' });
    await wait(1);

    expect(link.offer.poll).toHaveBeenCalledTimes(2);
    const card = screen.getByRole('status', { name: '' });
    expect(card).toHaveTextContent('Does your new device show the same number?');
    expect(card).toHaveTextContent('042 719');
    expect(screen.queryByRole('img', { name: 'Linking code' })).not.toBeInTheDocument();
    const match = screen.getByRole('button', { name: 'Match' });
    expect(match).toHaveClass('button-primary');
    expect(screen.getByRole('button', { name: 'Don’t match' })).toHaveClass('button-secondary');
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
  });

  it('sends only on Match, then says so, with the way back to Your groups', async () => {
    const { made } = setup();
    await wait();
    const link = only(made);
    link.show({ kind: 'compare', number: '518879' });
    await wait(LINK_POLL_MS);
    expect(link.offer.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Match' }));
    expect(screen.getByText('Sending your groups…')).toBeVisible();
    await wait();

    expect(link.offer.confirm).toHaveBeenCalledOnce();
    expect(screen.getByText('Sent. Your new device is adding your groups.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Your groups' })).toHaveAttribute('href', '#/');
    const polls = link.offer.poll.mock.calls.length;
    await wait(LINK_POLL_MS * 3);
    expect(link.offer.poll).toHaveBeenCalledTimes(polls);
  });

  it('drops the link on Don’t match, sends nothing, and makes a new code on request', async () => {
    const { made, start } = setup();
    await wait();
    const first = only(made);
    first.show({ kind: 'compare', number: '518879' });
    await wait(LINK_POLL_MS);

    fireEvent.click(screen.getByRole('button', { name: 'Don’t match' }));

    expect(first.offer.drop).toHaveBeenCalled();
    expect(first.offer.confirm).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing was sent. Make a new code to try again.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Make a new code' }));
    await wait();

    expect(start).toHaveBeenCalledTimes(2);
    const second = made[1];
    expect(second && screen.getByText(second.offer.code)).toBeVisible();
    expect(second?.offer.drop).not.toHaveBeenCalled();
  });

  it.each<[string, (link: ReturnType<typeof fakeOffer>) => void, string]>([
    [
      'the code expires while it waits',
      (link) => {
        link.show({ kind: 'expired' });
      },
      'This code has expired. Nothing was sent.',
    ],
    [
      'the code expires as Match is pressed',
      (link) => {
        link.show({ kind: 'compare', number: '000001' });
        link.offer.confirm.mockResolvedValue('expired');
      },
      'This code has expired. Nothing was sent.',
    ],
    [
      'sending fails',
      (link) => {
        link.show({ kind: 'compare', number: '000001' });
        link.offer.confirm.mockRejectedValue(new TypeError('Failed to fetch'));
      },
      'Your groups couldn’t be sent. Make a new code to try again.',
    ],
  ])('says so, with Make a new code, when %s', async (_when, arrange, says) => {
    const { made } = setup();
    await wait();
    const link = only(made);
    arrange(link);
    await wait(LINK_POLL_MS);
    const match = screen.queryByRole('button', { name: 'Match' });
    if (match !== null) {
      fireEvent.click(match);
      await wait();
    }

    expect(screen.getByText(says)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Make a new code' })).toHaveClass('button-primary');
  });

  it('keeps showing the code while the relay is out of reach', async () => {
    const { made } = setup();
    await wait();
    const link = only(made);
    link.offer.poll.mockRejectedValue(new TypeError('Failed to fetch'));

    await wait(LINK_POLL_MS * 2);

    expect(screen.getByText(link.offer.code)).toBeVisible();
    expect(link.offer.poll).toHaveBeenCalledTimes(3);
  });

  it('drops the link when the screen closes', async () => {
    const { made, view } = setup();
    await wait();

    view.unmount();

    expect(only(made).offer.drop).toHaveBeenCalled();
  });

  it('under StrictMode, drops the link its first mount made and shows the second’s code', async () => {
    const made: ReturnType<typeof fakeOffer>[] = [];
    const start = vi.fn(() => {
      const next = fakeOffer();
      made.push(next);
      return next.offer;
    });
    render(
      <StrictMode>
        <LinkNewDevice start={start} copyText={vi.fn(() => Promise.resolve())} />
      </StrictMode>,
    );
    await wait();

    const live = made.filter((link) => link.offer.drop.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    const shown = within(screen.getByRole('figure')).getByText(/^RL1\./).textContent;
    expect(shown).toBe(live[0]?.offer.code);
  });
});
