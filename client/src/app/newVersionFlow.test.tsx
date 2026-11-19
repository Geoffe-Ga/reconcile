/**
 * The build's version and a new version waiting, through the whole app
 * (#513): Settings ends with the version; once the service worker reports a
 * new version installed and waiting, Start and Settings say to close and
 * reopen Reconcile. Neither sends the relay anything.
 */
import { act, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { testDevice, type TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, type MountedApp, mountApp } from '../test/members';
import { createNewVersion } from './pwa/newVersion';

freshIndexedDBPerTest();

const READY = 'A new version is ready. Close and reopen Reconcile.';
const VERSION = '0123456789abcdef';

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

/** Ana's device, with this build's version and the worker's signal, at `hash`. */
async function open(hash: string) {
  const fake = createFakeRelay();
  const ana = await testDevice(fake, 'ana');
  opened.push(ana);
  const newVersion = createNewVersion();
  go(hash);
  const app = mountApp({ ...ana.services, version: VERSION, newVersion }, 'ana');
  mounted.push(app);
  return { fake, newVersion, view: within(app.container) };
}

describe('the build and a new version (#513)', () => {
  it('ends Settings with the build’s version, and adds the line once a new version waits', async () => {
    const { fake, newVersion, view } = await open('#/settings');
    expect(await view.findByText(`Version ${VERSION}`)).toBeVisible();
    expect(view.queryByText(READY)).toBeNull();

    act(() => {
      newVersion.markWaiting();
    });

    expect(view.getByText(READY)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
    expect(JSON.stringify(fake.requests)).not.toContain(VERSION);
  });

  it('says so on Start too, and keeps saying so after moving between them', async () => {
    const { newVersion, view } = await open('#/');
    await view.findByRole('heading', { level: 1, name: 'Your groups' });
    expect(view.queryByText(READY)).toBeNull();

    act(() => {
      newVersion.markWaiting();
    });
    expect(view.getByText(READY)).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    go('#/settings');
    expect(await view.findByText(READY)).toBeVisible();
    go('#/');
    expect(await view.findByText(READY)).toBeVisible();
  });
});
