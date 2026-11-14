/**
 * Loading what search reads (#445): a device's groups and personal
 * Documents become records, and loading them writes nothing and sends
 * nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAll, found, open } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
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
});
