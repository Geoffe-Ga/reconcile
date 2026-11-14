/**
 * Personal through the whole app (#93): Start opens `#/me`, the first
 * Document opens as My mission statement at a new `#/me/{id}`, it's kept on
 * this device as typed, Personal lists it, and Delete takes it back to
 * Personal. The device's relay hears nothing of any of it.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  keepSharing,
  readShare,
  SHARE_TTL_DAYS,
  startSharing,
  stopSharing,
} from '../share/shareLink';
import { exportGroups, importGroups } from '../store/snapshot';
import { testDevice, type TestDevice, TEST_NOW } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER } from '../test/members';
import { App } from './App';
import { messages } from './messages';

freshIndexedDBPerTest();

const devices: TestDevice[] = [];

afterEach(() => {
  for (const device of devices.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

async function device(name: string) {
  const fake = createFakeRelay();
  const opened = await testDevice(fake, name);
  devices.push(opened);
  return { ...opened, fake };
}

const CANARY = 'Canary statement: I show up for my neighbors.';

describe('Personal in the app', () => {
  it('goes from Start to a mission statement kept on this device, then lists it, telling the relay nothing', async () => {
    const user = userEvent.setup(APP_USER);
    const ana = await device('ana');
    render(<App services={ana.services} />);

    await user.click(await screen.findByRole('link', { name: /^Personal/ }));
    expect(window.location.hash).toBe('#/me');
    expect(await screen.findByRole('heading', { level: 1, name: 'Personal' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: /My mission statement/ }));

    expect(window.location.hash).toMatch(/^#\/me\/[A-Za-z0-9_-]{21}[AQgw]$/);
    const id = window.location.hash.slice('#/me/'.length);
    // Pasted, not typed key by key: each keystroke re-renders the whole app (#260).
    await user.click(await screen.findByRole('textbox', { name: 'Text' }));
    await user.paste(CANARY);
    expect(await screen.findByText('Saved on this device.', {}, { timeout: 2_000 })).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('link', { name: /Personal/ }));
    // The page's own list, not the tab bar's (#423).
    const list = await within(await screen.findByRole('main')).findByRole('list');
    const item = within(list).getByRole('link', { name: /My mission statement/ });
    expect(item).toHaveAttribute('href', `#/me/${id}`);
    expect(screen.getByRole('link', { name: 'New document' }).getAttribute('href')).not.toBe(
      `#/me/${id}`,
    );
    expect(await ana.services.store.listPersonal()).toEqual([
      { id, title: 'My mission statement', text: CANARY, createdAt: TEST_NOW, updatedAt: TEST_NOW },
    ]);
    expect(await ana.services.store.listGroups()).toEqual([]);
    expect(ana.fake.requests).toEqual([]);
  });

  it('opens a stored Document at its #/me/{id}, and Delete goes back to Personal in its place', async () => {
    const user = userEvent.setup();
    const ana = await device('ana');
    const id = 'Q2FuYXJ5IHN0YXRlbWVudA';
    await ana.services.store.savePersonal({
      id,
      title: 'Reading list',
      text: '- Braiding Sweetgrass\n',
      createdAt: 1,
      updatedAt: 1,
    });
    window.history.replaceState(null, '', '#/me');
    window.history.pushState(null, '', `#/me/${id}`);
    const depth = window.history.length;
    render(<App services={ana.services} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Reading list' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Personal' })).toBeVisible();
    expect(window.location.hash).toBe('#/me');
    expect(window.history.length).toBe(depth);
    expect(screen.getByRole('link', { name: /My mission statement/ })).toBeVisible();
    expect(await ana.services.store.listPersonal()).toEqual([]);
    expect(ana.fake.requests).toEqual([]);
  });

  it('opens a new Document beside another with a blank title, at the id Personal gave it', async () => {
    const user = userEvent.setup();
    const ana = await device('ana');
    await ana.services.store.savePersonal({
      id: 'Q2FuYXJ5IHN0YXRlbWVudA',
      title: 'My mission statement',
      text: '',
      createdAt: 1,
      updatedAt: 1,
    });
    window.history.replaceState(null, '', '#/me');
    render(<App services={ana.services} />);

    const add = await screen.findByRole('link', { name: 'New document' });
    const href = add.getAttribute('href');
    await user.click(add);

    expect(window.location.hash).toBe(href);
    expect(await screen.findByRole('heading', { level: 1, name: 'Untitled' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });

  it('shares a Document by link, copies it, marks it on Personal, and the link reads it back in the app (#105)', async () => {
    const user = userEvent.setup();
    const ana = await device('ana');
    const id = 'Q2FuYXJ5IHN0YXRlbWVudA';
    await ana.services.store.savePersonal({
      id,
      title: 'My mission statement',
      text: 'I show up.\n',
      createdAt: 1,
      updatedAt: 1,
    });
    window.history.replaceState(null, '', `#/me/${id}`);
    render(<App services={ana.services} />);
    const { share } = messages.personal;

    await user.click(await screen.findByRole('button', { name: share.start }));

    expect(await screen.findByText(share.copied)).toBeVisible();
    const link = screen.getByRole<HTMLInputElement>('textbox', { name: share.field }).value;
    expect(ana.copied).toEqual([`${share.message} ${link}`]);
    expect(link.startsWith(`${ana.services.origin}/#share/`)).toBe(true);
    await user.click(screen.getByRole('link', { name: /Personal/ }));
    expect(await screen.findByText(messages.personal.sharedLine)).toBeVisible();

    window.history.pushState(null, '', new URL(link).hash);
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(await screen.findByText('I show up.')).toBeVisible();
    expect(screen.getByText(messages.shared.note)).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'My mission statement' })).toBeVisible();
  });

  it('marks a share a restored backup brought back as paused, and Keep sharing still honours a Stop made since (#328)', async () => {
    const user = userEvent.setup();
    const phone = await device('ana-phone');
    const id = 'Q2FuYXJ5IHN0YXRlbWVudA';
    await phone.services.store.savePersonal({
      id,
      title: 'My mission statement',
      text: 'I show up.\n',
      createdAt: 1,
      updatedAt: 1,
    });
    const started = await startSharing(phone.services, id);
    if (started.kind !== 'shared') throw new Error(`Expected a share, not ${started.kind}.`);
    const { file } = await exportGroups(phone.services.store, 'a long walk to the river', 4);
    await stopSharing(phone.services, id);
    // The new device restores the file and reaches the same relay, after the phone stopped sharing.
    const laptop = await testDevice(phone.fake, 'ana-laptop');
    devices.push(laptop);
    await importGroups(laptop.services.store, file, 'a long walk to the river');
    const posts = phone.fake.requests.filter(({ method }) => method === 'PUT').length;
    window.history.replaceState(null, '', '#/me');
    render(<App services={laptop.services} />);
    const { share } = messages.personal;

    const item = await screen.findByRole('link', { name: /My mission statement/ });
    expect(item).toHaveTextContent(messages.personal.pausedLine);
    expect(await axeViolations()).toEqual([]);
    await user.click(item);
    expect(await screen.findByText(share.paused)).toBeVisible();
    expect(phone.fake.requests.filter(({ method }) => method === 'PUT')).toHaveLength(posts);

    await user.click(screen.getByRole('button', { name: share.keep }));

    // Within the tombstone's lifetime, Keep sharing finds it, so the link stays off.
    expect(await screen.findByText(share.keepStopped)).toBeVisible();
    expect(phone.fake.requests.filter(({ method }) => method === 'PUT')).toHaveLength(posts);
    expect(await readShare(laptop.services, started.link)).toEqual({ kind: 'gone' });
    await user.click(screen.getByRole('link', { name: /Personal/ }));
    const listed = await screen.findByRole('link', { name: /My mission statement/ });
    expect(listed).not.toHaveTextContent(messages.personal.pausedLine);
    expect(listed).not.toHaveTextContent(messages.personal.sharedLine);
  });
});

describe('a share another device stopped, in the app (#339)', () => {
  it('pauses the share on a device not opened until the tombstone lapsed, says why, and posts once the person keeps it', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    let clock = TEST_NOW;
    const phone = await testDevice(fake, 'ana-phone', () => clock);
    devices.push(phone);
    const id = 'Q2FuYXJ5IHN0YXRlbWVudA';
    await phone.services.store.savePersonal({
      id,
      title: 'My mission statement',
      text: 'I show up.\n',
      createdAt: 1,
      updatedAt: 1,
    });
    const started = await startSharing(phone.services, id);
    if (started.kind !== 'shared') throw new Error(`Expected a share, not ${started.kind}.`);
    // The laptop restores the phone's backup and keeps sharing, then stops sharing there.
    const { file } = await exportGroups(phone.services.store, 'a long walk to the river', 4);
    const laptop = await testDevice(fake, 'ana-laptop', () => clock);
    devices.push(laptop);
    await importGroups(laptop.services.store, file, 'a long walk to the river');
    expect(await keepSharing(laptop.services, id)).toBe('posted');
    expect(await stopSharing(laptop.services, id)).toBe('stopped');
    // The phone isn't opened again until the tombstone has lapsed at the relay.
    const lapsed = SHARE_TTL_DAYS + 2;
    fake.minute += lapsed * 24 * 60;
    clock += lapsed * 24 * 60 * 60 * 1000;
    const posts = fake.requests.filter(({ method }) => method === 'PUT').length;
    window.history.replaceState(null, '', '#/me');
    render(<App services={phone.services} />);
    const { share } = messages.personal;

    const item = await screen.findByRole('link', { name: /My mission statement/ });
    expect(item).toHaveTextContent(messages.personal.idleLine);
    await user.click(item);
    expect(await screen.findByText(share.pausedIdle)).toBeVisible();
    expect(fake.requests.filter(({ method }) => method === 'PUT')).toHaveLength(posts);
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: share.keep }));

    expect(await screen.findByText(share.kept)).toBeVisible();
    expect(fake.requests.filter(({ method }) => method === 'PUT')).toHaveLength(posts + 1);
    expect((await readShare(phone.services, started.link)).kind).toBe('shown');
    await user.click(screen.getByRole('link', { name: /Personal/ }));
    const listed = await screen.findByRole('link', { name: /My mission statement/ });
    expect(listed).toHaveTextContent(messages.personal.sharedLine);
  });
});

describe('Personal’s line on where Documents go, in the app (#248)', () => {
  it('says the sealed relay backup has them once the device keeps a key, and follows the key as it comes', async () => {
    const ana = await device('ana');
    const id = 'Q2FuYXJ5IHN0YXRlbWVudA';
    await ana.services.store.savePersonal({
      id,
      title: 'My mission statement',
      text: 'I show up.\n',
      createdAt: 1,
      updatedAt: 1,
    });
    const { privacy, privacyRelayBackup, documentPrivacy, documentPrivacyRelayBackup } =
      messages.personal;
    window.history.replaceState(null, '', '#/me');
    render(<App services={ana.services} />);

    expect(await screen.findByText(privacy)).toBeVisible();

    // #109 keeps a key once someone chooses recovery contacts: the line follows at once.
    await ana.services.store.setRelayBackupKey(new Uint8Array(32).fill(7));
    expect(await screen.findByText(privacyRelayBackup)).toBeVisible();
    expect(screen.queryByText(privacy)).not.toBeInTheDocument();

    window.history.pushState(null, '', `#/me/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByText(documentPrivacyRelayBackup)).toBeVisible();
    expect(screen.queryByText(documentPrivacy)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
