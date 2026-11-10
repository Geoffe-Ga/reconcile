/**
 * First run in front of the whole app (#76): nobody gets keys before the
 * pilot notice, an iPhone browser tab gets none at all, and an invite link,
 * opened or pasted, reaches the same preview.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as SignModule from '../crypto/sign';
import { newSigningKeys } from '../crypto/sign';
import type { PlatformEnv } from '../platform/installGate';
import type { NoticeRecord } from '../platform/notice';
import { testDevice, type TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { createGroup, makeInvite } from './actions';
import { messages } from './messages';
import { Root } from './Root';

vi.mock('../crypto/sign', async (importOriginal) => {
  const actual = await importOriginal<typeof SignModule>();
  return { ...actual, newSigningKeys: vi.fn(actual.newSigningKeys) };
});

freshIndexedDBPerTest();

const keysMade = vi.mocked(newSigningKeys);
const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '/');
  keysMade.mockClear();
});

const DESKTOP: PlatformEnv = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  maxTouchPoints: 0,
  displayModeStandalone: false,
  navigatorStandalone: undefined,
};
const IPHONE_TAB: PlatformEnv = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
  displayModeStandalone: false,
  navigatorStandalone: undefined,
};

async function device(fake: FakeRelay, name: string): Promise<TestDevice> {
  const opened = await testDevice(fake, name);
  devices.push(opened);
  return opened;
}

/** A group Ana created and sent to the relay, and its invite link. */
async function anasGroup(fake: FakeRelay): Promise<string> {
  const ana = await device(fake, 'ana');
  const values = {
    groupName: 'Riverside Tenants',
    yourName: 'Ana',
    chat: null,
    title: 'House rules',
    text: 'Quiet hours start at ten.',
  };
  const result = await createGroup(ana.services, values);
  if (result.outcome !== 'created') throw new Error('Expected a group.');
  await ana.services.sync.syncOnce();
  const link = await makeInvite(ana.services, result.groupId, ana.services.origin);
  keysMade.mockClear();
  return link;
}

function memoryNotice(): NoticeRecord {
  let accepted = false;
  return {
    accepted: () => accepted,
    accept: () => {
      accepted = true;
    },
  };
}

function renderRoot(ben: TestDevice, platform: PlatformEnv = DESKTOP) {
  const firstRun = {
    platform,
    notice: memoryNotice(),
    requestPersistence: () => Promise.resolve('denied' as const),
  };
  const { unmount } = render(<Root services={ben.services} firstRun={firstRun} />);
  return { user: userEvent.setup(), unmount };
}

/** Join's preview: the group’s name as the heading, and its Document’s title. */
async function joinPreview(): Promise<string[]> {
  const heading = await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
  const main = screen.getByRole('main');
  return [heading.textContent, within(main).getByText('House rules').textContent];
}

describe('Root', () => {
  it('makes no key before I understand, whose words all come from the messages module', async () => {
    const fake = createFakeRelay();
    const link = await anasGroup(fake);
    const ben = await device(fake, 'ben');
    window.history.replaceState(null, '', new URL(link).hash);
    const { user } = renderRoot(ben);

    expect(screen.getByRole('heading', { level: 1, name: messages.notice.title })).toBeVisible();
    for (const topic of messages.notice.topics) {
      expect(screen.getByRole('heading', { level: 2, name: topic.heading })).toBeVisible();
    }
    expect(screen.queryByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument();
    expect(keysMade).not.toHaveBeenCalled();
    expect(await ben.services.store.listGroups()).toEqual([]);
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: messages.notice.accept }));
    expect(await joinPreview()).toEqual(['Riverside Tenants', 'House rules']);
    expect(keysMade).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ben');
    await user.click(screen.getByRole('button', { name: 'Join group' }));
    await screen.findByRole('region', { name: 'People' });
    expect(keysMade).toHaveBeenCalledTimes(1);
  });

  it('brings a pasted invite link to the same preview as an opened one', async () => {
    const fake = createFakeRelay();
    const link = await anasGroup(fake);

    const opener = await device(fake, 'opener');
    window.history.replaceState(null, '', new URL(link).hash);
    const first = renderRoot(opener);
    await first.user.click(screen.getByRole('button', { name: 'I understand' }));
    const opened = await joinPreview();
    first.unmount();
    window.history.replaceState(null, '', '/');

    const paster = await device(fake, 'paster');
    const { user } = renderRoot(paster);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    await user.click(await screen.findByRole('textbox', { name: 'Invite link' }));
    await user.paste(`  ${link}  `);
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));

    expect(await joinPreview()).toEqual(opened);
    expect(window.location.hash).toBe('#/join');
  });

  it('shows the damaged-link line for a malformed paste, with none of the input', async () => {
    const ben = await device(createFakeRelay(), 'ben');
    const { user } = renderRoot(ben);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    const field = await screen.findByRole('textbox', { name: 'Invite link' });
    await user.type(field, 'https://example.org/#/join/canary-payload');
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));
    expect(field).toHaveAccessibleDescription(
      `${messages.start.inviteHint} ${messages.join.badLink}`,
    );
    expect(document.body).not.toHaveTextContent('canary');
  });

  it('shows an iPhone browser tab the guide and the invite’s preview, and makes nothing', async () => {
    const fake = createFakeRelay();
    const link = await anasGroup(fake);
    const ben = await device(fake, 'ben');
    window.history.replaceState(null, '', new URL(link).hash);
    renderRoot(ben, IPHONE_TAB);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Add Reconcile to your Home Screen' }),
    ).toBeVisible();
    const preview = await screen.findByRole('region', { name: 'Riverside Tenants' });
    expect(within(preview).getByText('House rules')).toBeVisible();
    expect(within(preview).getByRole('textbox', { name: 'Your invite link' })).toHaveValue(link);
    expect(within(preview).getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    expect(window.location.hash).toBe('');
    expect(screen.queryByRole('button', { name: 'I understand' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create group' })).not.toBeInTheDocument();
    expect(keysMade).not.toHaveBeenCalled();
    expect(await ben.services.store.listGroups()).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it('says on Start when the browser may clear the app’s data', async () => {
    const ben = await device(createFakeRelay(), 'ben');
    const { user } = renderRoot(ben);
    await user.click(screen.getByRole('button', { name: 'I understand' }));
    expect(await screen.findByText(messages.start.mayClear)).toBeVisible();
  });
});
