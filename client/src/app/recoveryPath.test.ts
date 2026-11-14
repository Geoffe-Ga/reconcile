/**
 * What counts as a way back before keys are sealed under a passkey (#389;
 * ADR-0030's 2026-11-14 amendment): recovery contacts in force, or a backup
 * file saved since every group a backup keeps came to this device. Real
 * groups on one fake relay; each case changes only what it names.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Group, RecoveryPlan } from '../store/db';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { foundAnother, members } from '../test/members';
import { recoveryWorld } from '../test/recovery';
import { hasRecoveryPath, readRecoveryPath, recoveryPathOf } from './recoveryPath';

freshIndexedDBPerTest();

const DEVICES = { timeout: 60_000 };

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
});

/** Ana's device with her one group, as the store keeps it. */
async function anaWithAGroup(): Promise<{ ana: TestDevice; group: Group }> {
  const made = await members(createFakeRelay(), ['Ana']);
  opened.push(...made.devices);
  const [ana] = made.devices;
  const group = await ana?.services.store.getGroup(made.groupId);
  if (ana === undefined || group === undefined) throw new Error('Expected Ana’s group.');
  return { ana, group };
}

/** Ana's device with a second group she founds, as the store keeps it, with no backup mark. */
async function secondGroup(ana: TestDevice): Promise<Group> {
  const group = await ana.services.store.getGroup(await foundAnother(ana, 'Ana'));
  if (group === undefined) throw new Error('Expected Ana’s second group.');
  return group;
}

describe('recoveryPathOf (#389)', DEVICES, () => {
  it('finds nothing to lose on a device with no group', () => {
    expect(recoveryPathOf({ groups: [], plan: undefined, relayBackup: undefined })).toBe('empty');
  });

  it('asks for a way back while a group has no saved backup file', async () => {
    const { group } = await anaWithAGroup();
    const facts = { plan: undefined, relayBackup: undefined };
    expect(recoveryPathOf({ ...facts, groups: [group] })).toBe('none');
    expect(recoveryPathOf({ ...facts, groups: [{ ...group, backup: 'not-now' }] })).toBe('none');
  });

  it('takes a saved backup file only once every group a backup keeps is in one', async () => {
    const { ana, group } = await anaWithAGroup();
    const saved: Group = { ...group, backup: 'saved' };
    const facts = { plan: undefined, relayBackup: undefined };
    expect(recoveryPathOf({ ...facts, groups: [saved] })).toBe('backup');
    // A group joined after the file isn't in it.
    const later = await secondGroup(ana);
    expect(recoveryPathOf({ ...facts, groups: [saved, later] })).toBe('none');
    expect(recoveryPathOf({ ...facts, groups: [saved, { ...later, backup: 'saved' }] })).toBe(
      'backup',
    );
  });

  it('leaves out groups a backup doesn’t keep: leaving, read-only, or never founded here', async () => {
    const { ana, group } = await anaWithAGroup();
    const saved: Group = { ...group, backup: 'saved' };
    const facts = { plan: undefined, relayBackup: undefined };
    const later = await secondGroup(ana);
    const leaving: Group = { ...later, leaving: Uint8Array.from([1]) };
    const archived: Group = { ...later, archived: { reason: 'dissolved' } };
    const unfounded: Group = { ...later, log: [] };
    expect(recoveryPathOf({ ...facts, groups: [saved, leaving, archived, unfounded] })).toBe(
      'backup',
    );
    // With only those, nothing on the device would go in a backup.
    expect(recoveryPathOf({ ...facts, groups: [archived, unfounded] })).toBe('empty');
  });

  it('takes recovery contacts in force, and not once it’s time to choose again', async () => {
    const fake = createFakeRelay();
    const world = await recoveryWorld(fake);
    opened.push(...world.devices);
    const { store } = world.ana.services;
    const groups = await store.listGroups();
    const plan = await store.getRecoveryPlan();
    if (plan === undefined) throw new Error('Expected Ana’s plan.');
    const relayBackup = await store.getRelayBackup();
    expect(recoveryPathOf({ groups, plan, relayBackup })).toBe('contacts');

    const superseded: RecoveryPlan = { ...plan, supersededAt: 1 };
    expect(recoveryPathOf({ groups, plan: superseded, relayBackup })).toBe('none');
    // Too few contacts left in a shared group: Settings asks to choose again.
    const gone = groups.filter(({ groupId }) => groupId !== world.groupId);
    expect(recoveryPathOf({ groups: gone, plan, relayBackup })).toBe('none');
    const saved = gone.map((group) => ({ ...group, backup: 'saved' as const }));
    expect(recoveryPathOf({ groups: saved, plan, relayBackup })).toBe('backup');
  });

  it('takes contacts chosen on another of the person’s devices, by the split its key came with (#272)', async () => {
    const { group } = await anaWithAGroup();
    const older = {
      key: new Uint8Array(32),
      digest: null,
      checkedDay: null,
      uploadedAt: null,
      tooLarge: false,
    };
    const relayBackup = { ...older, split: 'split-from-elsewhere' };
    expect(recoveryPathOf({ groups: [group], plan: undefined, relayBackup })).toBe('contacts');
    // A key from before #272 names no split, so it says nothing about contacts.
    expect(recoveryPathOf({ groups: [group], plan: undefined, relayBackup: older })).toBe('none');
  });

  it('reads the store, and says which paths are a way back', async () => {
    const { ana, group } = await anaWithAGroup();
    expect(await readRecoveryPath(ana.services.store)).toBe('none');
    await ana.services.store.markBackup([group.groupId], 'saved');
    expect(await readRecoveryPath(ana.services.store)).toBe('backup');
    expect((['contacts', 'backup', 'none', 'empty'] as const).map(hasRecoveryPath)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
