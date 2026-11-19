/**
 * What a device keeps to tell its reader a door it sent to was removed from
 * the shelf (#491; listed-doors.md §6.5): the doors it left reconcile cards
 * at and the lines its reader dismissed, in one device-wide record, beside
 * the doors of the applications it sent. Kept across a reload, read with no
 * vault open, and carried by no backup file or link.
 */
import { describe, expect, it } from 'vitest';

import { vaultKeyFromPrf } from '../crypto/keyVault';
import { freshIndexedDBPerTest } from '../test/idb';
import type { SentApplication } from './applications';
import { openStore, REMOVALS_CHANGED } from './db';
import { deviceSnapshot } from './snapshot';
import type { VaultLock } from './vault';

freshIndexedDBPerTest();

const DOOR = 'D'.repeat(43);
const CARD_DOOR = 'C'.repeat(43);
const DAY_MS = 86_400_000;
const NOW = 1_762_650_000_000;

const application = (id: string, door: string, sentAt: number): SentApplication => ({
  id,
  door,
  groupName: 'Riverside Tenants',
  seed: new Uint8Array(32).fill(1),
  replyKey: new Uint8Array(32).fill(2),
  sentAt,
});

describe('the removals record in the store (#491)', () => {
  it('lists nothing on a new device, nor reads another device record as its own', async () => {
    const store = await openStore();
    expect(await store.removalsAt(NOW)).toEqual({ sent: [], dismissed: [] });
    await store.keepShelfCopy({ instance: 'r', now: 1, records: [], readAt: 1, since: {} });
    expect(await store.removalsAt(NOW)).toEqual({ sent: [], dismissed: [] });
    store.close();
  });

  it('lists applications and cards sent by door, oldest first, and keeps dismissals across a reload', async () => {
    const store = await openStore();
    const heard: string[] = [];
    store.subscribe((changed) => heard.push(changed));
    await store.addSent(application('a', DOOR, NOW - 2 * DAY_MS));
    await store.noteSentCard({ door: CARD_DOOR, sentAt: NOW - DAY_MS });
    await store.noteSentCard({ door: DOOR, sentAt: NOW - 3 * DAY_MS });
    await store.dismissRemoval({ key: DOOR, door: DOOR, at: NOW });
    await store.dismissRemoval({ key: DOOR, door: DOOR, at: NOW + 1 });
    store.close();

    const reopened = await openStore();
    expect(await reopened.removalsAt(NOW)).toEqual({
      sent: [
        { door: DOOR, sentAt: NOW - 3 * DAY_MS, kind: 'card' },
        { door: DOOR, sentAt: NOW - 2 * DAY_MS, kind: 'application' },
        { door: CARD_DOOR, sentAt: NOW - DAY_MS, kind: 'card' },
      ],
      dismissed: [DOOR],
    });
    expect(heard.filter((changed) => changed === REMOVALS_CHANGED)).toHaveLength(4);
    expect(REMOVALS_CHANGED).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    reopened.close();
  });

  it('forgets a card 30 days on, and then its door’s dismissal once that is 60 days old', async () => {
    const store = await openStore();
    await store.noteSentCard({ door: CARD_DOOR, sentAt: NOW });
    await store.dismissRemoval({ key: CARD_DOOR, door: CARD_DOOR, at: NOW });

    expect((await store.removalsAt(NOW + 30 * DAY_MS - 1)).sent).toHaveLength(1);
    expect(await store.removalsAt(NOW + 30 * DAY_MS)).toEqual({
      sent: [],
      dismissed: [CARD_DOOR],
    });
    expect(await store.removalsAt(NOW + 60 * DAY_MS)).toEqual({ sent: [], dismissed: [] });
    // Forgotten for good: an earlier clock brings neither back.
    expect(await store.removalsAt(NOW)).toEqual({ sent: [], dismissed: [] });
    store.close();
  });

  it('reads the doors of applications sent on a locked device, with no vault open', async () => {
    const store = await openStore();
    await store.addSent(application('a', DOOR, NOW));
    const salt = new Uint8Array(32).fill(0x33);
    const lock: VaultLock = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: salt };
    await store.sealKeys(lock, vaultKeyFromPrf(new Uint8Array(32).fill(0x11), salt));
    store.close();

    const locked = await openStore();
    expect((await locked.removalsAt(NOW)).sent).toEqual([
      { door: DOOR, sentAt: NOW, kind: 'application' },
    ]);
    locked.close();
  });

  it('never goes in a backup file or a link', async () => {
    const store = await openStore();
    await store.noteSentCard({ door: CARD_DOOR, sentAt: NOW });
    await store.dismissRemoval({ key: DOOR, door: DOOR, at: NOW });
    const snapshot = JSON.stringify(await deviceSnapshot(store));
    expect(snapshot).not.toContain(CARD_DOOR);
    expect(snapshot).not.toContain(DOOR);
    store.close();
  });
});
