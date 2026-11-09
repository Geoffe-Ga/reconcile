/**
 * The tracer's first loop (#65): A creates a group and copies an invite link;
 * B opens it on another device, picks a name, joins, and reads the same
 * Document with both names listed. Two stores share one fake relay.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../engine/event';
import type { FakeRequest } from '../test/fakeRelay';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { TEST_ORIGIN, type TestDevice, testDevice } from '../test/appServices';
import { App } from './App';
import { parseInviteLink } from './invite';

freshIndexedDBPerTest();

const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

async function open(device: Promise<TestDevice>): Promise<TestDevice> {
  const opened = await device;
  devices.push(opened);
  return opened;
}

async function createRiverside(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('link', { name: 'Create group' }));
  const entries: [string, string][] = [
    ['Group name', 'Riverside Tenants'],
    ['Your name', 'Ana'],
    ['Chat link (optional)', 'https://chat.example.org/riverside'],
    ['Document title', 'House rules'],
    ['Document text', 'Quiet hours start at ten.\n\nBins go out on Tuesday.'],
  ];
  for (const [label, value] of entries) {
    await user.click(await screen.findByRole('textbox', { name: label }));
    await user.paste(value);
  }
  await user.click(screen.getByRole('button', { name: 'Create group' }));
}

/** The secret's spellings a leak could take: base64url, standard base64 and hex. */
function spellings(secret: Uint8Array): string[] {
  const b64url = base64url(secret);
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const hex = Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [b64url, b64, hex, hex.toUpperCase()];
}

/** Everything a request carried, as text: its URL and its body. */
function sent(request: FakeRequest): string[] {
  const body = request.body === null ? '' : new TextDecoder().decode(request.body);
  const bodyB64 = request.body === null ? '' : btoa(String.fromCharCode(...request.body));
  return [request.url, body, bodyB64];
}

describe('create, invite by link, join, and read the Document', () => {
  it('lets B join A’s group from the link and read the same Document, with both names', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const ana = await open(testDevice(fake, 'ana'));
    const ben = await open(testDevice(fake, 'ben'));

    // A creates the group and copies the invite link.
    const a = render(<App services={ana.services} />);
    await createRiverside(user);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Copy invite link' }));
    const [link = ''] = ana.copied;
    expect(screen.getByRole('textbox', { name: 'Invite link' })).toHaveValue(link);
    a.unmount();

    // The link puts the mailbox and secret after #, and nowhere else.
    const invite = parseInviteLink(link);
    expect(link).toMatch(
      /^https:\/\/reconcile\.test\/#\/join\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(link.startsWith(`${TEST_ORIGIN}/#/join/`)).toBe(true);

    // B opens the link: the secret leaves the address bar before anything else.
    window.history.replaceState(null, '', new URL(link).hash);
    render(<App services={ben.services} />);
    expect(window.location.hash).toBe('#/join');
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ben');
    expect(screen.getByRole('heading', { level: 1, name: 'Riverside Tenants' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Join group' }));

    // B lands on Group home, with both names once the join is back from the relay.
    const people = await screen.findByRole('region', { name: 'People' });
    await waitFor(() => {
      expect(
        within(people)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Ana', 'Ben']);
    });
    expect(screen.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      'https://chat.example.org/riverside',
    );

    // B reads A's Document.
    await user.click(screen.getByRole('link', { name: /House rules/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'House rules' })).toBeVisible();
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
    expect(screen.getByText('Bins go out on Tuesday.')).toBeVisible();

    // A sees both names after its next sync.
    await ana.services.sync.syncOnce();
    const groupId = (await ana.services.store.listGroups())[0]?.groupId ?? '';
    const anaGroup = await ana.services.store.getGroup(groupId);
    expect(anaGroup?.log).toHaveLength(2);

    // No request ever carried the secret, in any spelling, in its URL or body.
    expect(invite).not.toBeNull();
    const leaks = spellings(invite?.secret ?? new Uint8Array());
    expect(fake.requests.length).toBeGreaterThan(3);
    for (const request of fake.requests) {
      for (const text of sent(request)) {
        for (const leak of leaks) expect(text).not.toContain(leak);
      }
    }
  });
});
