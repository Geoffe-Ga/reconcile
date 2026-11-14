/**
 * Loading what search reads (#445): a device's groups and personal
 * Documents become records, and loading them writes nothing and sends
 * nothing. A front-door application's copy of someone's Documents (#425)
 * never becomes one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAll, found, open } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { withApplications } from '../store/applications';
import { search } from './search';
import { loadSearchRecords } from './searchLoad';

freshIndexedDBPerTest();

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

describe('loadSearchRecords', () => {
  it('reads this device’s groups and personal Documents, and writes and sends nothing', async () => {
    const fake = createFakeRelay();
    const ben = await open(fake, 'ben');
    const groupId = await found(ben, 'Riverside Tenants', 'Ben');
    await ben.services.store.savePersonal({
      id: 'U2hhcmVkIHN0YXRlbWVudA',
      title: 'Résumé',
      text: 'What I have done.',
      createdAt: 1,
      updatedAt: 1,
    });
    const requests = fake.requests.length;
    const proto = IDBObjectStore.prototype;
    const writes = [vi.spyOn(proto, 'put'), vi.spyOn(proto, 'add'), vi.spyOn(proto, 'delete')];

    const records = await loadSearchRecords(ben.services.store);

    expect(search(records, 'riverside').map((result) => result.record.route)).toContainEqual({
      name: 'group',
      groupId,
    });
    expect(search(records, 'resume').map((result) => result.record.title)).toEqual(['Résumé']);
    expect(fake.requests).toHaveLength(requests);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it('never reads an application’s copy of someone’s Documents, on a member’s device (#425)', async () => {
    const fake = createFakeRelay();
    const ben = await open(fake, 'ben');
    const groupId = await found(ben, 'Riverside Tenants', 'Ben');
    const canary = 'canary-425-search';
    const application = {
      id: 'A'.repeat(43),
      seq: 1,
      received: fake.minute,
      name: 'Kim',
      message: 'Hello.',
      reply: { seed: 'B'.repeat(43), key: 'C'.repeat(43) },
      documents: [{ title: `Statement ${canary}`, text: `Fair rents, ${canary}.` }],
    };
    const inbox = { inbox: 'D'.repeat(43), cursor: 1, instance: null, applications: [] };
    await ben.services.store.updateInbox(groupId, () => withApplications(inbox, [application]));
    // The control: the store holds the copy, and search still reads the group.
    const held = await ben.services.store.getGroup(groupId);
    expect(JSON.stringify(held?.door)).toContain(canary);

    const records = await loadSearchRecords(ben.services.store);

    expect(search(records, 'riverside').length).toBeGreaterThan(0);
    expect(search(records, canary)).toEqual([]);
    expect(search(records, 'statement')).toEqual([]);
    expect(JSON.stringify(records)).not.toContain(canary);
  });
});
