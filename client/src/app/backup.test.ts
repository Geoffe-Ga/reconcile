import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackupUnreadable } from '../crypto/backup';
import { testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import { VaultLocked } from '../store/db';
import { makeBackup, passphraseProblem, restoreBackup, saveBackup } from './backup';
import type { FileTargets } from './share';

freshIndexedDBPerTest();

// A cheap scrypt cost, so these tests don't spend a second on each key.
vi.mock('../crypto/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/backup')>();
  return {
    ...actual,
    sealBackup: (plaintext: Uint8Array, passphrase: string) =>
      actual.sealBackup(plaintext, passphrase, 4),
  };
});

const PASSPHRASE = 'a long walk to the river';
const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

async function group() {
  const fake = createFakeRelay();
  const made = await members(fake, ['Ana', 'Ben']);
  opened.push(...made.devices);
  const [ana] = made.devices;
  if (ana === undefined) throw new Error('Expected Ana.');
  return { fake, ana, groupId: made.groupId };
}

describe('passphraseProblem', () => {
  it.each([
    ['', 'Use at least 8 characters.'],
    ['seven77', 'Use at least 8 characters.'],
    // Eight code points, but seven characters once e + U+0301 composes to é.
    ['cafe\u0301 ab', 'Use at least 8 characters.'],
    ['caf\u00e9 abc', null],
    ['eight888', null],
    ['        ', null],
  ])('reads %j as %s', (passphrase, problem) => {
    expect(passphraseProblem(passphrase)).toBe(problem);
  });
});

describe('makeBackup and saveBackup', () => {
  it('make a generically named file of every group, save it, and mark the groups as saved', async () => {
    const { ana, groupId } = await group();
    const download = vi.fn<(file: File) => void>();
    const files: FileTargets = { canShare: undefined, share: undefined, download };
    const services = { ...ana.services, files, now: () => new Date(2026, 10, 8, 9).getTime() };

    const backup = await makeBackup(services, PASSPHRASE);
    expect(backup.groupIds).toEqual([groupId]);
    expect(backup.file.name).toBe('reconcile-backup-2026-11-08.bin');
    expect((await ana.services.store.getGroup(groupId))?.backup).toBeUndefined();

    expect(await saveBackup(services, backup)).toBe('downloaded');
    expect(download).toHaveBeenCalledWith(backup.file);
    expect((await ana.services.store.getGroup(groupId))?.backup).toBe('saved');
  });

  it('mark nothing when the person closes the share sheet', async () => {
    const { ana, groupId } = await group();
    const files: FileTargets = {
      canShare: () => true,
      share: () => Promise.reject(new DOMException('Cancelled', 'AbortError')),
      download: vi.fn(),
    };
    const services = { ...ana.services, files };

    const backup = await makeBackup(services, PASSPHRASE);

    expect(await saveBackup(services, backup)).toBe('cancelled');
    expect((await ana.services.store.getGroup(groupId))?.backup).toBeUndefined();
  });
});

describe('makeBackup on a locked device (#95)', () => {
  it('checks the session holds the unlocked keys before it reads any group', async () => {
    const { ana } = await group();
    const listGroups = vi.spyOn(ana.services.store, 'listGroups');
    const store = {
      ...ana.services.store,
      listGroups,
      requireUnlocked: () => Promise.reject(new VaultLocked()),
    };

    await expect(makeBackup({ ...ana.services, store }, PASSPHRASE)).rejects.toThrow(VaultLocked);

    expect(listGroups).not.toHaveBeenCalled();
  });
});

describe('restoreBackup', () => {
  it('brings the groups back on another device, which then syncs at once', async () => {
    const { fake, ana, groupId } = await group();
    const backup = await makeBackup(ana.services, PASSPHRASE);
    const bytes = new Uint8Array(await backup.file.arrayBuffer());
    const second = await testDevice(fake, 'ana-phone');
    opened.push(second);
    const syncOnce = vi.spyOn(second.services.sync, 'syncOnce');

    expect(await restoreBackup(second.services, bytes, PASSPHRASE)).toBe(1);

    expect((await second.services.store.getGroup(groupId))?.me).toEqual(
      (await ana.services.store.getGroup(groupId))?.me,
    );
    expect(syncOnce).toHaveBeenCalledOnce();
  });

  it('rejects with the plain error for a wrong passphrase, writing nothing and syncing nothing', async () => {
    const { fake, ana } = await group();
    const backup = await makeBackup(ana.services, PASSPHRASE);
    const bytes = new Uint8Array(await backup.file.arrayBuffer());
    const second = await testDevice(fake, 'ana-phone');
    opened.push(second);
    const syncOnce = vi.spyOn(second.services.sync, 'syncOnce');

    await expect(restoreBackup(second.services, bytes, 'not the passphrase')).rejects.toThrow(
      BackupUnreadable,
    );
    expect(await second.services.store.listGroups()).toEqual([]);
    expect(syncOnce).not.toHaveBeenCalled();
  });
});
