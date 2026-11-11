/**
 * Back up, restore and erase (#78) through the whole app, on devices that
 * share one fake relay: group home suggests a backup until one holds the
 * group, Settings saves the file, a second and third device restore it from
 * Start and vote as the same person, so the tally counts one voter with the
 * later ballot, a file from before #98 says plainly what that device will
 * miss (#225), and Erase runs from Settings behind its hold.
 */
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openBackup, sealBackup } from '../crypto/backup';
import { backupIdFor } from '../crypto/relayBackup';
import { fold } from '../engine/fold';
import { keyChangeOf } from '../store/epochs';
import { startRelayBackup } from '../store/relayBackup';
import type { TestDevice } from '../test/appServices';
import { testDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { leaveGroup } from './actions';
import { messages } from './messages';
import { castBallot, propose } from './proposals';

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

async function anaAndBen() {
  const fake = createFakeRelay();
  const made = await members(fake, ['Ana', 'Ben']);
  opened.push(...made.devices);
  const [ana, ben] = made.devices;
  if (ana === undefined || ben === undefined) throw new Error('Expected Ana and Ben.');
  return { fake, ana, ben, groupId: made.groupId };
}

/** Saves a backup of `device` from Settings, through the download path, and returns the file. */
async function saveFrom(device: TestDevice, prefix: string): Promise<File> {
  const user = userEvent.setup();
  go('#/settings');
  const app = mount(device, prefix);
  await user.type(await app.findByLabelText('Passphrase'), PASSPHRASE);
  await user.type(app.getByLabelText('Passphrase again'), PASSPHRASE);
  await user.click(app.getByRole('button', { name: 'Make a backup file' }));
  await user.click(await app.findByRole('button', { name: 'Save the file' }));
  await app.findByText('Saved. Keep the file and the passphrase in different places.');
  const [file] = device.downloaded;
  if (file === undefined) throw new Error('Expected the downloaded file.');
  return file;
}

/** Restores `file` on `device` from Start, through the file input. */
async function restoreOn(device: TestDevice, prefix: string, file: File) {
  const user = userEvent.setup();
  go('#/');
  const app = mount(device, prefix);
  const section = await app.findByRole('region', { name: 'Have a backup file?' });
  const input = section.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('Expected the file input.');
  await user.upload(input, file);
  await user.type(within(section).getByLabelText('Its passphrase'), PASSPHRASE);
  await user.click(within(section).getByRole('button', { name: 'Restore' }));
  await within(section).findByText('1 group is back on this device.');
  return app;
}

describe('the backup card', () => {
  it('suggests a backup on group home until one holds the group', async () => {
    const user = userEvent.setup();
    const { ana, groupId } = await anaAndBen();
    go(`#/g/${groupId}`);
    let app = mount(ana, 'a');
    expect(
      await app.findByText('Save a backup so you can get this group back if you lose your phone.'),
    ).toBeVisible();

    await user.click(app.getByRole('link', { name: 'Save a backup' }));
    expect(window.location.hash).toBe('#/settings');
    for (const done of mounted.splice(0)) done.unmount();
    await saveFrom(ana, 'b');

    go(`#/g/${groupId}`);
    app = mount(ana, 'c');
    await app.findByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(app.queryByText(/Save a backup so you can/)).not.toBeInTheDocument();
  });

  it('goes for good on Not now', async () => {
    const user = userEvent.setup();
    const { ben, groupId } = await anaAndBen();
    go(`#/g/${groupId}`);
    const app = mount(ben, 'b');

    await user.click(await app.findByRole('button', { name: 'Not now' }));

    await waitFor(() => {
      expect(app.queryByText(/Save a backup so you can/)).not.toBeInTheDocument();
    });
    expect((await ben.services.store.getGroup(groupId))?.backup).toBe('not-now');
  });
});

/** Who `device` is in `groupId`, and the state its log folds to. */
async function heldBy(device: TestDevice, groupId: string) {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on the device.');
  return { me: group.me, state: fold(group.log, group.relayNow) };
}

describe('a restored device', () => {
  it('folds what the first device folds, and votes as the same person: one voter, the later ballot', async () => {
    const { fake, ana, ben, groupId } = await anaAndBen();
    const proposed = await propose(ana.services, groupId, {
      atom: `${groupId}.0`,
      title: 'Later quiet hours',
      why: 'Weekends run late.',
      text: 'Quiet hours start at eleven.',
      link: null,
    });
    if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    await ana.services.sync.syncOnce();
    const file = await saveFrom(ana, 'a');
    for (const done of mounted.splice(0)) done.unmount();

    const phone = await testDevice(fake, 'ana-phone');
    const laptop = await testDevice(fake, 'ana-laptop');
    opened.push(phone, laptop);
    const start = await restoreOn(phone, 'p', file);
    expect(await start.findByRole('link', { name: /Riverside Tenants/ })).toBeVisible();
    await restoreOn(laptop, 'l', file);

    const original = await heldBy(ana, groupId);
    for (const device of [phone, laptop]) {
      const restored = await heldBy(device, groupId);
      expect(restored.me).toEqual(original.me);
      expect(restored.state).toEqual(original.state);
    }

    const versionId = proposed.proposalId;
    await castBallot(phone.services, groupId, {
      proposal: versionId,
      scores: { [versionId]: 1 },
      note: 'Not yet.',
    });
    await phone.services.sync.syncOnce();
    fake.minute += 5;
    await castBallot(laptop.services, groupId, {
      proposal: versionId,
      scores: { [versionId]: 4 },
      note: '',
    });
    await laptop.services.sync.syncOnce();
    await ben.services.sync.syncOnce();

    const [proposal] = (await heldBy(ben, groupId)).state.proposals;
    expect(proposal?.ballots.map((ballot) => [ballot.voter, ballot.scores])).toEqual([
      [original.me.author, { [versionId]: 4 }],
    ]);
  });
});

/** `file` as #78 saved it, before #98: format 1, with no encryption key or epoch, under the same passphrase. */
async function asFormat1(file: File): Promise<File> {
  const plaintext = await openBackup(new Uint8Array(await file.arrayBuffer()), PASSPHRASE);
  const json = JSON.parse(new TextDecoder().decode(plaintext)) as {
    groups: Record<string, unknown>[];
  };
  const groups = json.groups.map((group) =>
    Object.fromEntries(Object.entries(group).filter(([key]) => !['kxKey', 'epoch'].includes(key))),
  );
  const older = new TextEncoder().encode(JSON.stringify({ ...json, format: 1, groups }));
  return new File([await sealBackup(older, PASSPHRASE)], 'reconcile-backup-2026-10-01.bin');
}

describe('a device restored from a file saved before #98 (#225)', () => {
  it('says plainly that it won’t get a group’s new key once another device has one, how to get back in, and then misses the next', async () => {
    const { fake, ana, ben, groupId } = await anaAndBen();
    const file = await asFormat1(await saveFrom(ana, 'a'));
    for (const done of mounted.splice(0)) done.unmount();
    const phone = await testDevice(fake, 'ana-phone');
    opened.push(phone);

    const start = await restoreOn(phone, 'p', file);

    const section = await start.findByRole('region', { name: 'Have a backup file?' });
    expect(within(section).getByRole('status')).toHaveTextContent(messages.restore.older);
    // Ana's first device gave the group her key, so the phone, which holds none, posts none.
    await phone.services.sync.syncOnce();
    const restored = await phone.services.store.getGroup(groupId);
    expect(restored?.kxKey).toBeUndefined();
    await leaveGroup(ben.services, groupId);
    await ben.services.sync.syncOnce();
    await ana.services.sync.syncOnce();
    await phone.services.sync.syncOnce();
    const held = await phone.services.store.getGroup(groupId);
    if (held === undefined) throw new Error('Expected the group on the phone.');
    expect(keyChangeOf(held, fold(held.log, held.relayNow))).toBe('missed');
  });
});

describe('Erase from Settings', () => {
  it('runs only after the 3-second hold', async () => {
    const { ana } = await anaAndBen();
    go('#/settings');
    const app = mount(ana, 'a');
    const user = userEvent.setup();
    await user.click(await app.findByRole('button', { name: 'Erase Reconcile from this device' }));
    const hold = app.getByRole('button', { name: 'Hold to erase' });
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(hold, { key: 'Enter' });
      for (let elapsed = 0; elapsed < 3_000; elapsed += 100) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }
    } finally {
      vi.useRealTimers();
    }

    expect(ana.services.erase).toHaveBeenCalledOnce();
    expect(app.getByText('Erasing…')).toBeVisible();
  });
});

describe('the relay backup key in the file (#97, ADR-0075 §4)', () => {
  it('lets a device restored from the file keep the relay backup fresh, and Settings says so', async () => {
    const { fake, ana } = await anaAndBen();
    await startRelayBackup(ana.services);
    const key = (await ana.services.store.getRelayBackup())?.key ?? new Uint8Array();
    const id = backupIdFor(key);
    const first = fake.backup(id);
    const file = await saveFrom(ana, 'a');
    for (const done of mounted.splice(0)) done.unmount();
    const phone = await testDevice(fake, 'phone');
    opened.push(phone);

    await restoreOn(phone, 'p', file);
    // Restore syncs at once: the first complete pass of the relay day uploads the restored
    // groups under the same id, sealed afresh.
    await waitFor(async () => {
      expect((await phone.services.store.getRelayBackup())?.uploadedAt).not.toBeNull();
    });

    expect(fake.backup(id)).toBeDefined();
    expect(fake.backup(id)).not.toEqual(first);
    for (const done of mounted.splice(0)) done.unmount();
    go('#/settings');
    const settings = mount(phone, 's');
    const section = await settings.findByRole('region', { name: 'Back up your groups' });
    expect(await within(section).findByText(/^Backed up to the relay /)).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('shows no relay backup line on a device that keeps no key', async () => {
    const { ben } = await anaAndBen();
    go('#/settings');
    const app = mount(ben, 'b');

    const section = await app.findByRole('region', { name: 'Back up your groups' });

    // Scoped to the backup: Notifications' disclosure speaks of the relay too (#99).
    expect(within(section).queryByText(/relay/)).not.toBeInTheDocument();
  });
});
