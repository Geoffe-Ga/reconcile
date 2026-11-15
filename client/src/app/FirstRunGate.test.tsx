import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newInviteSeed } from '../crypto/invite';
import { base64url } from '../engine/event';
import type { PlatformEnv } from '../platform/installGate';
import type { NoticeRecord } from '../platform/notice';
import type { Persistence } from '../platform/persist';
import type { InviteLookup } from './actions';
import { FirstRunGate, type OpenedApp } from './FirstRunGate';

const ORIGIN = 'https://reconcile.example';

const IPHONE_TAB: PlatformEnv = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
  displayModeStandalone: false,
  navigatorStandalone: undefined,
};
const IPHONE_INSTALLED: PlatformEnv = { ...IPHONE_TAB, displayModeStandalone: true };
const DESKTOP: PlatformEnv = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  maxTouchPoints: 0,
  displayModeStandalone: false,
  navigatorStandalone: undefined,
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

/** A new invite's seed, as Copy invite link makes one. */
function newInvite(): Uint8Array {
  return newInviteSeed();
}

/** The seed as a link carries it. */
function invitePayload(seed: Uint8Array): string {
  return base64url(seed);
}

/** A notice record in memory, recording each call in `events`. */
function memoryNotice(accepted: boolean, events: string[]): NoticeRecord {
  let current = accepted;
  return {
    accepted: () => current,
    accept: () => {
      events.push('accept');
      current = true;
    },
  };
}

interface Options {
  readonly platform?: PlatformEnv;
  readonly accepted?: boolean;
  readonly hash?: string;
  readonly persistence?: Persistence;
  readonly notice?: NoticeRecord;
}

function setup(options: Options = {}) {
  if (options.hash !== undefined) window.history.replaceState(null, '', `/${options.hash}`);
  const events: string[] = [];
  const notice = options.notice ?? memoryNotice(options.accepted ?? false, events);
  const requestPersistence = vi.fn(() => {
    events.push('persist');
    return Promise.resolve(options.persistence ?? 'granted');
  });
  const lookup = vi.fn<(seed: Uint8Array) => Promise<InviteLookup>>(() =>
    Promise.resolve({ kind: 'missing' }),
  );
  const opened: OpenedApp[] = [];
  const app = vi.fn((open: OpenedApp) => {
    opened.push(open);
    return (
      <main>
        <h1>The app</h1>
      </main>
    );
  });
  render(
    <FirstRunGate
      platform={options.platform ?? DESKTOP}
      notice={notice}
      requestPersistence={requestPersistence}
      origin={ORIGIN}
      copyText={() => Promise.resolve()}
      lookup={lookup}
    >
      {app}
    </FirstRunGate>,
  );
  return { user: userEvent.setup(), events, requestPersistence, lookup, app, opened };
}

const appHeading = () => screen.queryByRole('heading', { level: 1, name: 'The app' });
const guideHeading = () =>
  screen.queryByRole('heading', { level: 1, name: 'Add Reconcile to your Home Screen' });
const noticeHeading = () => screen.queryByRole('heading', { level: 1, name: 'Before you start' });
const landingHeading = () => screen.queryByRole('heading', { level: 1, name: 'Reconcile' });

/** Presses the landing page's Start a Group, as a new visitor does to move on. */
async function startFromLanding(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const [start] = screen.getAllByRole('button', { name: 'Start a Group' });
  if (start === undefined) throw new Error('The landing page has no Start a Group button.');
  await user.click(start);
}

describe('FirstRunGate on a plain visit in a browser tab', () => {
  it.each([
    ['an iPhone in Safari', IPHONE_TAB],
    ['a desktop browser', DESKTOP],
  ])('shows %s the landing page first, and records nothing', (_name, platform) => {
    const { events, requestPersistence, app } = setup({ platform });
    expect(landingHeading()).toBeVisible();
    expect(guideHeading()).not.toBeInTheDocument();
    expect(noticeHeading()).not.toBeInTheDocument();
    expect(app).not.toHaveBeenCalled();
    expect(requestPersistence).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it('moves on from Start a Group to the install guide on an iPhone, at the top of the page', async () => {
    const { user } = setup({ platform: IPHONE_TAB });
    document.documentElement.scrollTop = 900;
    await startFromLanding(user);
    expect(guideHeading()).toBeVisible();
    expect(landingHeading()).not.toBeInTheDocument();
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('moves on from Start a Group to the pilot notice where keys may be made', async () => {
    const { user } = setup();
    await startFromLanding(user);
    expect(noticeHeading()).toBeVisible();
    expect(landingHeading()).not.toBeInTheDocument();
  });

  it('gives way to an invite link that opens in this window', async () => {
    const invite = newInvite();
    setup();
    act(() => {
      window.location.hash = `#join/${invitePayload(invite)}`;
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Before you start' }),
    ).toBeVisible();
    expect(landingHeading()).not.toBeInTheDocument();
  });

  it.each([
    ['an invite link', { hash: `#join/${invitePayload(newInvite())}` }],
    ['the installed app', { platform: IPHONE_INSTALLED }],
    ['a device that accepted the notice', { accepted: true }],
  ])('is skipped for %s', (_name, options) => {
    setup(options);
    expect(landingHeading()).not.toBeInTheDocument();
  });
});

describe('FirstRunGate on an iPhone or iPad outside the installed app', () => {
  it('shows only the install guide: no notice, no app, nothing recorded', async () => {
    const { user, events, requestPersistence, app } = setup({ platform: IPHONE_TAB });
    await startFromLanding(user);
    expect(guideHeading()).toBeVisible();
    expect(noticeHeading()).not.toBeInTheDocument();
    expect(app).not.toHaveBeenCalled();
    expect(requestPersistence).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('holds an invite in memory, takes it out of the address bar, and shows its preview', async () => {
    const invite = newInvite();
    const { lookup, app } = setup({
      platform: IPHONE_TAB,
      hash: `#join/${invitePayload(invite)}`,
    });
    expect(guideHeading()).toBeVisible();
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('');
    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(lookup.mock.calls[0]?.[0]).toEqual(invite);
    expect(app).not.toHaveBeenCalled();
  });

  it('reads an invite link that opens in this window while the guide shows', async () => {
    const invite = newInvite();
    const { user, lookup } = setup({ platform: IPHONE_TAB });
    await startFromLanding(user);
    expect(screen.getByRole('textbox', { name: 'Reconcile’s address' })).toBeVisible();
    act(() => {
      window.location.hash = `#join/${invitePayload(invite)}`;
    });
    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(lookup.mock.calls[0]?.[0]).toEqual(invite);
    expect(window.location.hash).toBe('');
    // This lookup finds the mailbox empty, so the guide says the link has expired.
    expect(await screen.findByText(/This invite link has expired or is damaged/)).toBeVisible();
  });

  it('takes a damaged invite out of the address bar too, and fetches nothing', () => {
    const { lookup } = setup({ platform: IPHONE_TAB, hash: '#join/damaged.payload' });
    expect(window.location.hash).toBe('');
    expect(
      screen.getByText(
        'This invite link has expired or is damaged. Ask someone in your group for a new one.',
      ),
    ).toBeVisible();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('FirstRunGate where keys may be made', () => {
  it.each([
    ['an installed iPhone', IPHONE_INSTALLED],
    ['a desktop browser, past the landing page', DESKTOP],
  ])('shows %s the pilot notice first, and nothing else', async (_name, platform) => {
    const { user, app, requestPersistence } = setup({ platform });
    if (platform === DESKTOP) await startFromLanding(user);
    expect(noticeHeading()).toBeVisible();
    expect(guideHeading()).not.toBeInTheDocument();
    expect(app).not.toHaveBeenCalled();
    expect(requestPersistence).not.toHaveBeenCalled();
  });

  it('records the acceptance, then asks to keep the data, then opens the app', async () => {
    const { user, events, opened } = setup({ persistence: 'denied' });
    await startFromLanding(user);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(appHeading()).toBeVisible();
    await waitFor(() => {
      expect(opened.at(-1)?.persistence).toBe('denied');
    });
    expect(events).toEqual(['accept', 'persist']);
    expect(opened[0]).toEqual({ heldSeed: null, persistence: null });
  });

  it('holds an invite through the notice, out of the address bar, and hands it to the app', async () => {
    const invite = newInvite();
    const { user, opened, lookup } = setup({ hash: `#join/${invitePayload(invite)}` });
    expect(noticeHeading()).toBeVisible();
    expect(window.location.hash).toBe('#/join');
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    const held: Uint8Array | null | undefined = opened.at(-1)?.heldSeed;
    expect(held).toEqual(invite);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('holds an invite link that opens in this window while the notice shows', async () => {
    const invite = newInvite();
    const { user, opened } = setup();
    await startFromLanding(user);
    act(() => {
      window.location.hash = `#join/${invitePayload(invite)}`;
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/join');
    });
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(opened.at(-1)?.heldSeed).toEqual(invite);
  });

  it('opens at once once accepted, asking to keep the data at each launch', async () => {
    const invite = newInvite();
    const hash = `#join/${invitePayload(invite)}`;
    const { opened, requestPersistence } = setup({ accepted: true, hash });
    expect(appHeading()).toBeVisible();
    expect(noticeHeading()).not.toBeInTheDocument();
    // Join reads the link itself, as it always has.
    expect(window.location.hash).toBe(hash);
    expect(opened[0]?.heldSeed).toBeNull();
    await waitFor(() => {
      expect(opened.at(-1)?.persistence).toBe('granted');
    });
    expect(requestPersistence).toHaveBeenCalledTimes(1);
  });

  it('opens for this session when the browser won’t keep the acceptance', async () => {
    const blocked: NoticeRecord = { accepted: () => false, accept: () => undefined };
    const { user } = setup({ notice: blocked });
    await startFromLanding(user);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(appHeading()).toBeVisible();
  });
});
