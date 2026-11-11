import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newInviteSeed } from '../crypto/invite';
import { base64url } from '../engine/event';
import type { PlatformEnv } from '../platform/installGate';
import type { NoticeRecord } from '../platform/notice';
import type { Persistence } from '../platform/persist';
import type { PasskeyOfferRecord } from '../platform/passkeyOffer';
import type { InviteLookup } from './actions';
import { FirstRunGate, type OpenedApp } from './FirstRunGate';
import { messages } from './messages';
import type { DeviceLock, Passkey, Protection } from './passkey';

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
  /** Whether the device's keys are locked with a passkey at launch (#95). */
  readonly locked?: boolean;
  /** What unlocking resolves to, each time. */
  readonly unlocks?: boolean;
  /** Whether this browser can offer a passkey (#95). */
  readonly passkeyAvailable?: boolean;
  /** Whether this device answered the passkey offer. */
  readonly offerAnswered?: boolean;
  /** What Restore on the unlock screen does. */
  readonly restore?: DeviceLock['restore'];
}

/** An offer record in memory, recording each answer in `events`. */
function memoryOffer(answered: boolean, events: string[]): PasskeyOfferRecord {
  let current = answered;
  return {
    answered: () => current,
    answer: () => {
      events.push('answer');
      current = true;
    },
  };
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
  const unlock = vi.fn(() => Promise.resolve(options.unlocks ?? true));
  const lock: DeviceLock = {
    lockedAtLaunch: options.locked ?? false,
    unlock,
    restore: options.restore ?? vi.fn(() => Promise.resolve({ groups: 2, older: false })),
  };
  const passkey: Passkey = {
    available: options.passkeyAvailable ?? false,
    isProtected: () => Promise.resolve(false),
    create: () => Promise.resolve(Uint8Array.of(1)),
    protect: () => Promise.resolve<Protection>('protected'),
  };
  const onErase = vi.fn(() => Promise.resolve());
  const passkeyOffer = memoryOffer(options.offerAnswered ?? false, events);
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
      readDoor={() => Promise.resolve({ kind: 'closed' })}
      lock={lock}
      passkey={passkey}
      passkeyOffer={passkeyOffer}
      onErase={onErase}
    >
      {app}
    </FirstRunGate>,
  );
  return {
    user: userEvent.setup(),
    events,
    requestPersistence,
    lookup,
    app,
    opened,
    unlock,
    onErase,
  };
}

const appHeading = () => screen.queryByRole('heading', { level: 1, name: 'The app' });
const guideHeading = () =>
  screen.queryByRole('heading', { level: 1, name: 'Add Reconcile to your Home Screen' });
const noticeHeading = () => screen.queryByRole('heading', { level: 1, name: 'Before you start' });

describe('FirstRunGate on an iPhone or iPad outside the installed app', () => {
  it('shows only the install guide: no notice, no app, nothing recorded', () => {
    const { events, requestPersistence, app } = setup({ platform: IPHONE_TAB });
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
    const { lookup } = setup({ platform: IPHONE_TAB });
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
    ['a desktop browser', DESKTOP],
  ])('shows %s the pilot notice first, and nothing else', (_name, platform) => {
    const { app, requestPersistence } = setup({ platform });
    expect(noticeHeading()).toBeVisible();
    expect(guideHeading()).not.toBeInTheDocument();
    expect(app).not.toHaveBeenCalled();
    expect(requestPersistence).not.toHaveBeenCalled();
  });

  it('records the acceptance, then asks to keep the data, then opens the app', async () => {
    const { user, events, opened } = setup({ persistence: 'denied' });
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
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(appHeading()).toBeVisible();
  });
});

describe('FirstRunGate with a front door’s link (#121)', () => {
  const door = `#door/${'A'.repeat(42)}E`;

  it('keeps the link in the address bar under the notice, so the app opens at the door', async () => {
    const { user, opened } = setup({ hash: door });
    expect(screen.getByRole('button', { name: 'I understand' })).toBeVisible();
    expect(window.location.hash).toBe(door);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(appHeading()).toBeVisible();
    expect(window.location.hash).toBe(door);
    expect(opened.at(-1)?.heldSeed).toBeNull();
  });

  it('shows an iPhone outside the installed app the door in the guide, leaving its link in place', async () => {
    setup({ platform: IPHONE_TAB, hash: door });
    expect(await screen.findByText('This front door is closed.')).toBeVisible();
    expect(window.location.hash).toBe(door);
    expect(appHeading()).toBeNull();
  });
});

const offerHeading = () =>
  screen.queryByRole('heading', { level: 1, name: messages.passkey.title });
const unlockHeading = () =>
  screen.queryByRole('heading', { level: 1, name: messages.unlock.title });

describe('FirstRunGate and the passkey offer (#95)', () => {
  it('offers a passkey once, right after the notice, where one can lock the keys', async () => {
    const { user, events, app } = setup({ passkeyAvailable: true });

    await user.click(screen.getByRole('button', { name: 'I understand' }));

    expect(offerHeading()).toBeVisible();
    expect(app).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: messages.passkey.notNow }));
    expect(appHeading()).toBeVisible();
    expect(events.filter((event) => event !== 'persist')).toEqual(['accept', 'answer']);
  });

  it('offers it at the next launch to a device that accepted the notice before passkeys came', () => {
    setup({ accepted: true, passkeyAvailable: true });

    expect(offerHeading()).toBeVisible();
    expect(appHeading()).not.toBeInTheDocument();
  });

  it('doesn’t offer it again once answered', () => {
    setup({ accepted: true, passkeyAvailable: true, offerAnswered: true });

    expect(offerHeading()).not.toBeInTheDocument();
    expect(appHeading()).toBeVisible();
  });

  it('doesn’t offer it where a passkey can’t lock the keys', async () => {
    const { user, events } = setup({ passkeyAvailable: false });

    await user.click(screen.getByRole('button', { name: 'I understand' }));

    expect(offerHeading()).not.toBeInTheDocument();
    expect(appHeading()).toBeVisible();
    expect(events).not.toContain('answer');
  });

  it('holds an invite through the notice and the offer, and hands it to the app', async () => {
    const invite = newInvite();
    const { user, opened } = setup({
      passkeyAvailable: true,
      hash: `#join/${invitePayload(invite)}`,
    });

    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(window.location.hash).toBe('#/join');
    await user.click(screen.getByRole('button', { name: messages.passkey.notNow }));

    expect(opened.at(-1)?.heldSeed).toEqual(invite);
  });
});

describe('FirstRunGate on a device whose keys are locked (#95)', () => {
  it('shows the unlock screen before the app, and opens the app once the passkey unlocks', async () => {
    const { user, app, unlock } = setup({ accepted: true, locked: true, passkeyAvailable: true });

    expect(unlockHeading()).toBeVisible();
    expect(offerHeading()).not.toBeInTheDocument();
    expect(app).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: messages.unlock.unlock }));

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('heading', { level: 1, name: 'The app' })).toBeVisible();
    expect(offerHeading()).not.toBeInTheDocument();
  });

  it('stays on the unlock screen while the passkey doesn’t unlock', async () => {
    const { user, app } = setup({ accepted: true, locked: true, unlocks: false });

    await user.click(screen.getByRole('button', { name: messages.unlock.unlock }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.unlock.failed);
    expect(unlockHeading()).toBeVisible();
    expect(app).not.toHaveBeenCalled();
  });

  it('opens the app once a backup file is restored in place of the locked keys', async () => {
    const restore = vi.fn(() => Promise.resolve({ groups: 2, older: false }));
    const { user, app } = setup({ accepted: true, locked: true, unlocks: false, restore });
    await user.click(screen.getByRole('button', { name: messages.unlock.unlock }));
    const section = await screen.findByRole('region', { name: messages.unlock.restoreHeading });
    const file = new File([Uint8Array.of(1, 2, 3)], 'reconcile-backup.bin');
    const chooser = section.querySelector('input[type="file"]');
    if (!(chooser instanceof HTMLInputElement)) throw new Error('Expected a file input.');

    await user.upload(chooser, file);
    await user.type(screen.getByLabelText('Its passphrase'), 'a long walk to the river');
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'The app' })).toBeVisible();
    expect(restore).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3), 'a long walk to the river');
    expect(app).toHaveBeenCalled();
  });

  it('shows the notice first when the device hasn’t accepted it, then the unlock screen', async () => {
    const { user } = setup({ locked: true });

    expect(noticeHeading()).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(unlockHeading()).toBeVisible();
  });

  it('holds an invite opened while locked, and hands it to the app after unlocking', async () => {
    const invite = newInvite();
    const { user, opened } = setup({
      accepted: true,
      locked: true,
      hash: `#join/${invitePayload(invite)}`,
    });

    expect(window.location.hash).toBe('#/join');
    await user.click(screen.getByRole('button', { name: messages.unlock.unlock }));
    await screen.findByRole('heading', { level: 1, name: 'The app' });

    expect(opened.at(-1)?.heldSeed).toEqual(invite);
  });
});
