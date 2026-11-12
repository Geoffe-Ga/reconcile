/**
 * A backup made before a dissolve, restored through the whole app (#231;
 * ADR-0051's 2026-11-11 amendment), on devices that share one fake relay
 * whose clock the test moves: Ana saves a backup of Riverside Tenants, then
 * the group votes to dissolve and every device archives it. A phone that
 * never had the group restores the file from Start:
 *
 * - once the relay has let the `dissolve` go, the group comes back read-only
 *   for now, never live, and the phone sends nothing for it;
 * - while the relay still has the `dissolve`, it comes back dissolved, as
 *   before.
 *
 * And from an old file of a group that goes on, the phone's copy opens once
 * someone in the group posts anything, or once the person opens a new
 * invite link from someone in it.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEVELS } from '../engine/capabilities';
import { DAY_MINUTES } from '../engine/rules';
import type { TestDevice } from '../test/appServices';
import { testDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER, go, members, type MountedApp, mountApp } from '../test/members';
import { lookupInvite, makeInvite } from './actions';
import { parseInviteLink } from './invite';
import { messages } from './messages';
import { castBallot, chooseLevel, propose, proposeDissolve } from './proposals';

freshIndexedDBPerTest();

// A cheap scrypt cost: the default's second per key is pinned in crypto/backup.test.ts.
vi.mock('../crypto/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/backup')>();
  return {
    ...actual,
    sealBackup: (plaintext: Uint8Array, passphrase: string) =>
      actual.sealBackup(plaintext, passphrase, 4),
  };
});

const PASSPHRASE = 'a long walk to the river';
const [FOLLOWING] = LEVELS;
/** Minutes past a record by which the relay has let it go: 30 days, rounded up a day, and one more. */
const EXPIRED = 32 * DAY_MINUTES;
const NOTE = /^This copy came from a backup, and nothing new from your group has reached/;
const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

function mount(device: TestDevice, prefix: string) {
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return within(app.container);
}

function unmountAll(): void {
  for (const done of mounted.splice(0)) done.unmount();
}

/** Puts `text` in `field` in one paste: no keystroke of a passphrase is under test here (#260). */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) await act(() => device.services.sync.syncOnce());
}

/**
 * Riverside Tenants with Ana and the others `names` gives, Ben's Proposal to
 * change its first section open, all synced, and Ana's backup of it, saved
 * from Settings.
 */
async function riverside(names: readonly string[] = ['Ben', 'Cal']) {
  const fake = createFakeRelay();
  const { groupId, devices } = await members(fake, ['Ana', ...names]);
  opened.push(...devices);
  const [ana, ben] = devices;
  if (ana === undefined || ben === undefined) throw new Error('Expected Ana and Ben.');
  const edit = await propose(ben.services, groupId, {
    atom: `${groupId}.0`,
    title: 'Later quiet hours',
    why: 'Weekends run late.',
    text: 'Quiet hours start at eleven.',
    link: null,
  });
  if (edit.outcome !== 'proposed') throw new Error('Expected a Proposal.');
  await syncAll(devices);
  const file = await saveFrom(ana);
  return { fake, devices, ben, groupId, file, edit: edit.proposalId };
}

/** Saves a backup of `device` from Settings, through the download path, and returns the file. */
async function saveFrom(device: TestDevice): Promise<File> {
  const user = userEvent.setup(APP_USER);
  go('#/settings');
  const app = mount(device, 'save');
  await fill(user, await app.findByLabelText('Passphrase'), PASSPHRASE);
  await fill(user, app.getByLabelText('Passphrase again'), PASSPHRASE);
  await user.click(app.getByRole('button', { name: 'Make a backup file' }));
  await user.click(await app.findByRole('button', { name: 'Save the file' }));
  await app.findByText('Saved. Keep the file and the passphrase in different places.');
  unmountAll();
  const [file] = device.downloaded;
  if (file === undefined) throw new Error('Expected the downloaded file.');
  return file;
}

/** The group votes to dissolve, every 4, and every device archives it; returns the Proposal's id. */
async function dissolve(groupId: string, devices: readonly TestDevice[]): Promise<string> {
  const [ana] = devices;
  if (ana === undefined) throw new Error('Ana');
  const values = { title: 'Dissolve Riverside', why: 'We have all moved out.', window: 14 };
  const made = await proposeDissolve(ana.services, groupId, { ...values, wipe: false });
  if (made.outcome !== 'proposed') throw new Error('Expected the dissolve Proposal.');
  await syncAll(devices);
  for (const device of devices) {
    const ballot = {
      proposal: made.proposalId,
      scores: { [made.proposalId]: 4 },
      note: '',
    } as const;
    await castBallot(device.services, groupId, ballot);
  }
  for (let pass = 0; pass < 3; pass += 1) await syncAll(devices);
  for (const device of devices) {
    expect((await device.services.store.getGroup(groupId))?.archived).toEqual({
      reason: 'dissolved',
    });
  }
  return made.proposalId;
}

/** A phone that never had the group restores `file` from Start, and its first sync finishes. */
async function restoreOnPhone(fake: FakeRelay, file: File): Promise<TestDevice> {
  const phone = await testDevice(fake, 'ana-phone');
  opened.push(phone);
  const user = userEvent.setup(APP_USER);
  go('#/');
  const app = mount(phone, 'restore');
  const section = await app.findByRole('region', { name: 'Have a backup file?' });
  const input = section.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('Expected the file input.');
  await user.upload(input, file);
  await fill(user, within(section).getByLabelText('Its passphrase'), PASSPHRASE);
  await user.click(within(section).getByRole('button', { name: 'Restore' }));
  await within(section).findByText('1 group is back on this device.');
  // Restore syncs at once; this joins that pass.
  await act(() => phone.services.sync.syncOnce());
  unmountAll();
  return phone;
}

/** Group home on `device`. */
function home(device: TestDevice, groupId: string) {
  go(`#/g/${groupId}`);
  return mount(device, 'home');
}

describe('a backup made before the dissolve, restored through the app (#231)', () => {
  it('brings the group back read-only for now, never live, once the relay has let the dissolve go', async () => {
    const { fake, devices, groupId, file, edit } = await riverside();
    await dissolve(groupId, devices);
    fake.minute += EXPIRED;

    const phone = await restoreOnPhone(fake, file);
    const before = fake.requests.length;
    fake.minute += 60;
    await act(() => phone.services.sync.syncOnce());

    expect(fake.requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
    const app = home(phone, groupId);
    expect(await app.findByText('Read-only for now')).toBeVisible();
    expect(app.getByText(NOTE)).toBeVisible();
    expect(app.queryByText(/^This group dissolved on/)).toBeNull();
    expect(app.queryByRole('link', { name: 'Propose dissolving the group' })).toBeNull();
    expect(app.queryByRole('button', { name: 'Copy invite link' })).toBeNull();
    expect(app.queryByRole('link', { name: /Reconcile with another group/ })).toBeNull();
    unmountAll();
    go(`#/g/${groupId}/propose/${groupId}.0`);
    const composer = mount(phone, 'compose');
    expect(
      await composer.findByRole('heading', { level: 1, name: 'This group is read-only for now' }),
    ).toBeVisible();
    expect(composer.queryByRole('textbox')).toBeNull();
    unmountAll();
    // Ben's Proposal lapsed in the copy, which offers neither Propose again nor a chat message.
    go(`#/g/${groupId}/p/${edit}`);
    const proposal = mount(phone, 'proposal');
    expect(await proposal.findByText(messages.result.lapsed)).toBeVisible();
    expect(proposal.queryByRole('button', { name: 'Propose again' })).toBeNull();
    expect(proposal.queryByRole('button', { name: 'Tell your group' })).toBeNull();
  });

  it('brings the group back as a dissolved copy while the relay still has the dissolve', async () => {
    const { fake, devices, groupId, file } = await riverside();
    await dissolve(groupId, devices);
    fake.minute += 10 * DAY_MINUTES;

    const phone = await restoreOnPhone(fake, file);

    expect((await phone.services.store.getGroup(groupId))?.archived).toEqual({
      reason: 'dissolved',
    });
    const app = home(phone, groupId);
    expect(
      await app.findByText(/^This group dissolved on .+\. This is a read-only copy\.$/),
    ).toBeVisible();
    expect(app.queryByText('Read-only for now')).toBeNull();
  });

  it('opens a group that goes on once someone in it posts anything', async () => {
    const { fake, ben, groupId, file } = await riverside(['Ben']);
    fake.minute += 40 * DAY_MINUTES;
    const phone = await restoreOnPhone(fake, file);
    const app = home(phone, groupId);
    expect(await app.findByText('Read-only for now')).toBeVisible();

    // Ben, who still syncs, moves to following: anything new from the group will do.
    await chooseLevel(ben.services, groupId, FOLLOWING);
    await act(() => ben.services.sync.syncOnce());
    fake.minute += 1;
    await act(() => phone.services.sync.syncOnce());

    await waitFor(() => {
      expect(app.queryByText('Read-only for now')).toBeNull();
    });
    expect(app.getByRole('button', { name: 'Leave this group' })).toBeVisible();
    expect(app.getByRole('link', { name: 'Propose dissolving the group' })).toBeVisible();
    expect(app.getByRole('link', { name: /Reconcile with another group/ })).toBeVisible();
  });

  it('opens a quiet group that goes on once the person opens a new invite link from someone in it', async () => {
    const { fake, ben, groupId, file } = await riverside(['Ben']);
    fake.minute += 40 * DAY_MINUTES;
    const phone = await restoreOnPhone(fake, file);
    const app = home(phone, groupId);
    expect(await app.findByText('Read-only for now')).toBeVisible();

    const seed = parseInviteLink(await makeInvite(ben.services, groupId, ben.services.origin));
    if (seed === null) throw new Error('Expected an invite link.');
    expect(await act(() => lookupInvite(phone.services, seed))).toEqual({
      kind: 'joined',
      groupId,
    });

    await waitFor(() => {
      expect(app.queryByText('Read-only for now')).toBeNull();
    });
    expect(app.getByRole('button', { name: 'Leave this group' })).toBeVisible();
  });
});
