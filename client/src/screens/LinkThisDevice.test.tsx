/**
 * Link to your other device, on the new device (#96): scan or paste the
 * code, then the number with only Cancel (there is no way to confirm here),
 * then how it ended, against a fake link the test steps through.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { qrModules } from '../app/qr';
import { FRAME_MS } from '../app/QrScanner';
import { LINK_POLL_MS } from '../app/useLink';
import { type LinkCode, linkCode, newLinkKeys, newLinkSeed } from '../crypto/link';
import type { JoinStep, LinkJoin } from '../link/session';
import { axeViolations } from '../test/axe';
import { LinkThisDevice } from './LinkThisDevice';

/** A fake joined link whose step the test sets. */
function fakeJoin() {
  let step: JoinStep = { kind: 'waiting' };
  const join = {
    poll: vi.fn(() => Promise.resolve(step)),
    drop: vi.fn(),
  } satisfies LinkJoin;
  return {
    join,
    show: (next: JoinStep) => {
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

/** A fresh code as the other device shows it, and its seed. */
function freshCode() {
  const seed = newLinkSeed();
  return { text: linkCode(seed, newLinkKeys().publicKey), seed };
}

function setup(join: (code: LinkCode) => Promise<LinkJoin>, onLinked = vi.fn()) {
  const view = render(
    <LinkThisDevice
      join={join}
      onLinked={onLinked}
      camera={{ openCamera: () => Promise.reject(new Error('No camera here.')) }}
    />,
  );
  return { view, onLinked };
}

/** Pastes `text` and presses Link this device. */
async function paste(text: string): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: 'Code from your other device' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Link this device' }));
  await wait();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LinkThisDevice', () => {
  it('offers Scan the code and a field to paste it into, and makes no key before either', async () => {
    const join = vi.fn();
    setup(join);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Link to your other device' }),
    ).toBeVisible();
    expect(document.title).toBe('Link to your other device · Reconcile');
    expect(
      screen.getByText(
        'On your other device, open Settings and tap Link a new device. Then scan the code it shows, or paste it here.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Scan the code' })).toBeVisible();
    const field = screen.getByRole('textbox', { name: 'Code from your other device' });
    expect(field).toHaveAccessibleDescription('It starts with RL1.');
    expect(screen.getByRole('button', { name: 'Link this device' })).toHaveClass('button-primary');
    expect(screen.getByRole('link', { name: /Your groups/ })).toHaveAttribute('href', '#/');
    expect(join).not.toHaveBeenCalled();
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
  });

  it('says a pasted text isn’t a linking code, without repeating it, and makes no key', async () => {
    const join = vi.fn();
    setup(join);

    await paste('https://reconcile.test/#join/AAAA');

    expect(
      screen.getByText('That isn’t a linking code. Copy it again from your other device.'),
    ).toBeVisible();
    expect(screen.queryByText(/reconcile\.test/)).not.toBeInTheDocument();
    expect(join).not.toHaveBeenCalled();
  });

  it('joins with a pasted code, trimmed, then waits for the other device, with Cancel', async () => {
    const link = fakeJoin();
    const join = vi.fn<(code: LinkCode) => Promise<LinkJoin>>(() => Promise.resolve(link.join));
    setup(join);
    const code = freshCode();

    await paste(`  ${code.text}\n`);

    expect(join).toHaveBeenCalledOnce();
    expect(Array.from(join.mock.calls[0]?.[0].seed ?? [])).toEqual(Array.from(code.seed));
    expect(screen.getByText('Waiting for your other device…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the number and says to confirm on the other device, offering only Cancel', async () => {
    const link = fakeJoin();
    setup(() => Promise.resolve(link.join));
    await paste(freshCode().text);

    link.show({ kind: 'compare', number: '042719' });
    await wait(LINK_POLL_MS);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Check that your other device shows the same number, then confirm there.042 719',
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel']);
    expect(screen.queryByRole('button', { name: /match|confirm|send/i })).not.toBeInTheDocument();
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
  });

  it('says how many groups the device now has once they’re in, and syncs once', async () => {
    const link = fakeJoin();
    const { onLinked } = setup(() => Promise.resolve(link.join));
    await paste(freshCode().text);

    link.show({ kind: 'linked', groups: 2, skipped: 0 });
    await wait(LINK_POLL_MS);

    expect(screen.getByText('Linked. This device now has 2 groups.')).toBeVisible();
    const links = screen.getAllByRole('link', { name: 'Your groups' });
    expect(links.filter((link) => link.classList.contains('button-primary'))).toHaveLength(1);
    expect(onLinked).toHaveBeenCalledOnce();
    const polls = link.join.poll.mock.calls.length;
    await wait(LINK_POLL_MS * 3);
    expect(link.join.poll).toHaveBeenCalledTimes(polls);
    expect(onLinked).toHaveBeenCalledOnce();
  });

  it('says how many of the other device’s groups it left out, after how many it has (#336)', async () => {
    const link = fakeJoin();
    setup(() => Promise.resolve(link.join));
    await paste(freshCode().text);

    link.show({ kind: 'linked', groups: 1, skipped: 1 });
    await wait(LINK_POLL_MS);

    expect(screen.getByRole('status')).toHaveTextContent(
      /^Linked\. This device now has 1 group\. One group from your other device couldn’t be read and was left out\.$/,
    );
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
  });

  it.each<[JoinStep['kind'], string]>([
    ['mismatch', 'That code didn’t match. Start again on your other device.'],
    ['damaged', 'Your groups didn’t arrive in one piece. Start again on your other device.'],
    ['expired', 'That code has expired. Start again on your other device.'],
  ])('says so when the link ends as %s, and Start again drops it', async (kind, says) => {
    const link = fakeJoin();
    setup(() => Promise.resolve(link.join));
    await paste(freshCode().text);

    link.show({ kind } as JoinStep);
    await wait(LINK_POLL_MS);

    expect(screen.getByRole('alert')).toHaveTextContent(says);
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await wait();
    expect(link.join.drop).toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Code from your other device' })).toBeVisible();
  });

  it('says so, and goes back to the code, when the relay can’t be reached', async () => {
    setup(() => Promise.reject(new TypeError('Failed to fetch')));

    await paste(freshCode().text);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Can’t reach the relay right now. Check your connection and try again.',
    );
    expect(screen.getByRole('textbox', { name: 'Code from your other device' })).toBeVisible();
  });

  it('says it’s still trying while a look at the relay fails', async () => {
    const link = fakeJoin();
    setup(() => Promise.resolve(link.join));
    await paste(freshCode().text);

    link.join.poll.mockRejectedValue(new TypeError('Failed to fetch'));
    await wait(LINK_POLL_MS);

    expect(screen.getByText('Can’t reach the relay right now. Still trying.')).toBeVisible();
  });

  it('drops the link on Cancel, and when the screen closes', async () => {
    const first = fakeJoin();
    const second = fakeJoin();
    const joins = [first.join, second.join];
    const { view } = setup(() => Promise.resolve(joins.shift() ?? second.join));
    await paste(freshCode().text);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await wait();
    expect(first.join.drop).toHaveBeenCalled();

    await paste(freshCode().text);
    view.unmount();
    expect(second.join.drop).toHaveBeenCalled();
  });

  it('drops a link that the relay took only after the screen closed', async () => {
    const link = fakeJoin();
    let resolve: (join: LinkJoin) => void = () => undefined;
    const { view } = setup(() => new Promise((done) => (resolve = done)));
    await paste(freshCode().text);
    expect(screen.getByText('Connecting to your other device…')).toBeVisible();

    view.unmount();
    resolve(link.join);
    await wait();

    expect(link.join.drop).toHaveBeenCalled();
  });

  it('joins with a code the camera reads', async () => {
    const link = fakeJoin();
    const join = vi.fn<(code: LinkCode) => Promise<LinkJoin>>(() => Promise.resolve(link.join));
    const code = freshCode();
    const modules = qrModules(code.text);
    const scale = 4;
    const size = modules.length * scale;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy += 1) {
          const start = ((y * scale + dy) * size + x * scale) * 4;
          for (let i = 0; i < scale * 4; i += 4) data.fill(0, start + i, start + i + 3);
        }
      });
    });
    const tracks = [{ stop: vi.fn() }];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(
      <LinkThisDevice
        join={join}
        onLinked={vi.fn()}
        camera={{
          openCamera: () => Promise.resolve({ getTracks: () => tracks } as unknown as MediaStream),
          readFrame: () => ({ width: size, height: size, data }),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Scan the code' }));
    for (let i = 0; i < 3; i += 1) await wait(FRAME_MS);

    expect(join).toHaveBeenCalledOnce();
    expect(Array.from(join.mock.calls[0]?.[0].seed ?? [])).toEqual(Array.from(code.seed));
    expect(tracks[0]?.stop).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
