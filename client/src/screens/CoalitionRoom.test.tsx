import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messages } from '../app/messages';
import type { RoomView } from '../app/room';
import { minuteIso } from '../app/time';
import type { RoomMessage } from '../engine/room';
import { axeViolations } from '../test/axe';
import { held, pastPressFallback } from '../test/press';
import { CoalitionRoom, type CoalitionRoomProps } from './CoalitionRoom';

const { room } = messages;
const NOW = 29_400_000;

/** A message `name` wrote, received `ago` minutes before now. */
function said(id: string, name: string, text: string, ago = 5): RoomMessage {
  return { id, seq: NOW - ago, received: NOW - ago, author: `key-${name}`, name, text };
}

const VIEW: RoomView = {
  coalitionId: 'coalition-1',
  roomId: 'room-1',
  name: 'Eastside Housing',
  messages: [
    said('m1', 'Mara', 'Can we meet Thursday?', 20),
    said('m2', 'Jo', 'Thursday works for Oak St.\nAfter six.', 17),
  ],
  pending: [],
  me: 'key-Mara',
  myName: 'Mara',
  standing: { kind: 'writes' },
};

function props(overrides: Partial<CoalitionRoomProps> = {}): CoalitionRoomProps {
  return {
    view: VIEW,
    now: NOW,
    reachable: true,
    onSend: vi.fn(() => Promise.resolve()),
    onTakePart: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const list = () => screen.getByRole('list', { name: room.listLabel });

afterEach(() => {
  Reflect.deleteProperty(document.documentElement, 'scrollHeight');
  document.documentElement.scrollTop = 0;
});

describe('CoalitionRoom', () => {
  it('lists messages oldest at the top, each with its author’s coalition name and relay time, then Send', async () => {
    render(<CoalitionRoom {...props()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Eastside Housing' })).toBeVisible();
    expect(document.title).toBe('Room · Reconcile');
    expect(screen.getByRole('link', { name: /Eastside Housing/ })).toHaveAttribute(
      'href',
      '#/c/coalition-1',
    );
    expect(screen.getByText(room.note)).toBeVisible();
    const items = within(list()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Mara.*Can we meet Thursday\?$/),
      expect.stringMatching(/^Jo.*Thursday works for Oak St\.\nAfter six\.$/),
    ]);
    const [first] = items;
    const time = first?.querySelector('time');
    expect(time).toHaveAttribute('dateTime', minuteIso(NOW - 20));
    expect(within(first ?? document.body).getByText('Mara').tagName).toBe('BDI');
    expect(within(first ?? document.body).getByText('Can we meet Thursday?').tagName).toBe('BDI');
    expect(screen.getByRole('textbox', { name: room.messageLabel })).toBeVisible();
    expect(screen.getByRole('button', { name: room.send })).toHaveClass('button-primary');
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a message holding markup as the text it is, never as markup', () => {
    const script = '<script>alert(1)</script> **bold** https://example.com';
    render(
      <CoalitionRoom {...props({ view: { ...VIEW, messages: [said('m1', 'Jo', script)] } })} />,
    );
    const text = screen.getByText(script);
    expect(text.tagName).toBe('BDI');
    expect(text.childElementCount).toBe(0);
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('link', { name: /example/ })).toBeNull();
  });

  it('says so when no one has written yet', () => {
    render(<CoalitionRoom {...props({ view: { ...VIEW, messages: [] } })} />);
    expect(screen.getByText(room.empty)).toBeVisible();
    expect(screen.queryByRole('list', { name: room.listLabel })).toBeNull();
  });

  it('shows what waits to send under the writer’s name, with where it has got to', () => {
    const view = { ...VIEW, pending: [{ id: 'p1', text: 'On my way.' }] };
    const { rerender } = render(<CoalitionRoom {...props({ view })} />);
    const pending = within(list()).getAllByRole('listitem').at(-1);
    expect(pending).toHaveTextContent('MaraOn my way.');
    expect(within(pending ?? document.body).getByRole('status')).toHaveTextContent(
      messages.send.sending,
    );
    rerender(<CoalitionRoom {...props({ view, reachable: false })} />);
    expect(within(pending ?? document.body).getByRole('status')).toHaveTextContent(
      messages.send.saved,
    );
  });

  it('sends the text as typed and clears the box, keeping the person in it', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve());
    render(<CoalitionRoom {...props({ onSend })} />);
    const box = screen.getByRole('textbox', { name: room.messageLabel });

    await user.type(box, 'See you{Enter}there');
    await user.click(screen.getByRole('button', { name: room.send }));

    expect(onSend).toHaveBeenCalledWith('See you\nthere');
    expect(box).toHaveValue('');
    expect(screen.queryByText(room.emptyMessage)).toBeNull();
    await user.tab();
    expect(screen.queryByText(room.emptyMessage)).toBeNull();
  });

  it('refuses an empty or overlong message at the field, sending nothing', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.resolve());
    render(<CoalitionRoom {...props({ onSend })} />);
    const box = screen.getByRole('textbox', { name: room.messageLabel });

    await user.click(screen.getByRole('button', { name: room.send }));
    expect(await screen.findByText(room.emptyMessage)).toBeVisible();
    await user.click(box);
    await user.paste('a'.repeat(2001));
    await user.click(screen.getByRole('button', { name: room.send }));
    expect(await screen.findByText(room.longMessage)).toBeVisible();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says a send that couldn’t be saved didn’t, and keeps the text', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(() => Promise.reject(new Error('IndexedDB')));
    render(<CoalitionRoom {...props({ onSend })} />);
    const box = screen.getByRole('textbox', { name: room.messageLabel });

    await user.type(box, 'Hello');
    await user.click(screen.getByRole('button', { name: room.send }));

    expect(await screen.findByRole('alert')).toHaveTextContent(room.failed);
    expect(box).toHaveValue('Hello');
    expect(await axeViolations()).toEqual([]);
  });

  it('sends once when Send is tapped again while it sends and the save fails (#193)', async () => {
    const user = userEvent.setup();
    const sending = held<undefined>();
    const onSend = vi.fn(() => sending.promise);
    render(<CoalitionRoom {...props({ onSend })} />);
    const send = () => screen.getByRole('button', { name: room.send });

    await user.type(screen.getByRole('textbox', { name: room.messageLabel }), 'Hello');
    await user.click(send());
    expect(send()).toBeDisabled();
    await user.click(send());
    sending.reject();
    expect(await screen.findByRole('alert')).toHaveTextContent(room.failed);
    await pastPressFallback();

    expect(send()).toBeEnabled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('offers Take part in place of the box to someone who hasn’t joined, and only reads otherwise', async () => {
    const user = userEvent.setup();
    const onTakePart = vi.fn(() => Promise.resolve());
    const { unmount } = render(
      <CoalitionRoom
        {...props({ view: { ...VIEW, standing: { kind: 'take-part', groupId: 'g' } }, onTakePart })}
      />,
    );
    expect(screen.getByText(room.takePartFirst)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: room.messageLabel })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: messages.coalitions.nameLabel }), 'Kim');
    await user.click(screen.getByRole('button', { name: messages.coalitions.takePart }));
    expect(onTakePart).toHaveBeenCalledWith('Kim');
    expect(await axeViolations()).toEqual([]);
    unmount();

    for (const [kind, line] of [
      ['joining', room.joining],
      ['reads', room.reads],
    ] as const) {
      const { unmount: done } = render(
        <CoalitionRoom {...props({ view: { ...VIEW, standing: { kind } } })} />,
      );
      expect(screen.getByText(line)).toBeVisible();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: room.send })).toBeNull();
      done();
    }
  });

  it('announces a new message politely only while the person is at the bottom', () => {
    const { rerender } = render(<CoalitionRoom {...props()} />);
    const live = document.querySelector('.room-announcer');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveClass('visually-hidden');
    expect(live).toHaveTextContent('');

    const one = { ...VIEW, messages: [...VIEW.messages, said('m3', 'Jo', 'Bring chairs.', 1)] };
    rerender(<CoalitionRoom {...props({ view: one })} />);
    expect(live).toHaveTextContent(room.newFrom('Jo', 'Bring chairs.'));

    // Scrolled up: what arrives is not announced.
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 5000,
    });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    const two = { ...one, messages: [...one.messages, said('m4', 'Jo', 'And tea.', 0)] };
    rerender(<CoalitionRoom {...props({ view: two })} />);
    expect(live).toHaveTextContent(room.newFrom('Jo', 'Bring chairs.'));

    // Back at the bottom: several at once are counted, and the person's own never announced.
    document.documentElement.scrollTop = 5000;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    const three = {
      ...two,
      messages: [
        ...two.messages,
        said('m5', 'Jo', 'Five.', 0),
        said('m6', 'Ana', 'Six.', 0),
        said('m7', 'Mara', 'Mine.', 0),
      ],
    };
    rerender(<CoalitionRoom {...props({ view: three })} />);
    expect(live).toHaveTextContent(room.newMessages(2));
    const mine = { ...three, messages: [...three.messages, said('m8', 'Mara', 'Mine too.', 0)] };
    rerender(<CoalitionRoom {...props({ view: mine })} />);
    expect(live).toHaveTextContent(room.newMessages(2));
  });

  it('opens at the newest message, at the bottom', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 3000,
    });
    render(<CoalitionRoom {...props()} />);
    expect(document.documentElement.scrollTop).toBe(3000);
  });

  it('scrolls the app’s page region, where the page scrolls under the link bar (#444)', () => {
    const region = document.createElement('div');
    region.className = 'app-page';
    document.body.append(region);
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 600 });
    const { rerender } = render(<CoalitionRoom {...props()} />, { container: region });
    expect(region.scrollTop).toBe(4000);
    expect(document.documentElement.scrollTop).toBe(0);
    const live = document.querySelector('.room-announcer');

    // Scrolled up in the region: what arrives is not announced.
    region.scrollTop = 1000;
    act(() => {
      region.dispatchEvent(new Event('scroll'));
    });
    const one = { ...VIEW, messages: [...VIEW.messages, said('m3', 'Jo', 'Bring chairs.', 1)] };
    rerender(<CoalitionRoom {...props({ view: one })} />);
    expect(live).toHaveTextContent('');
    expect(region.scrollTop).toBe(1000);
    region.remove();
  });
});
