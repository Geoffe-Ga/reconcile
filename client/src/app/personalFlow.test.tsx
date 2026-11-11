/**
 * Personal through the whole app (#93): Start opens `#/me`, the first
 * Document opens as My mission statement at a new `#/me/{id}`, it's kept on
 * this device as typed, Personal lists it, and Delete takes it back to
 * Personal. The device's relay hears nothing of any of it.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { testDevice, type TestDevice, TEST_NOW } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
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
    const user = userEvent.setup();
    const ana = await device('ana');
    render(<App services={ana.services} />);

    await user.click(await screen.findByRole('link', { name: /^Personal/ }));
    expect(window.location.hash).toBe('#/me');
    expect(await screen.findByRole('heading', { level: 1, name: 'Personal' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: /My mission statement/ }));

    expect(window.location.hash).toMatch(/^#\/me\/[A-Za-z0-9_-]{21}[AQgw]$/);
    const id = window.location.hash.slice('#/me/'.length);
    const text = await screen.findByRole('textbox', { name: 'Text' });
    await user.type(text, CANARY);
    expect(await screen.findByText('Saved on this device.', {}, { timeout: 2_000 })).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole('link', { name: /Personal/ }));
    const list = await screen.findByRole('list');
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
});
