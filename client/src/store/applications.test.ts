import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import { utf8 } from '../test/bytes';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  dismissed,
  type DoorInbox,
  heldWithoutCopies,
  holdsCopies,
  type ReceivedCard,
  withCards,
  withoutCardSeeds,
  type ReceivedApplication,
  SENT_CHANGED,
  SENT_DAYS,
  type SentApplication,
  withApplications,
  withoutCopies,
} from './applications';
import { vaultKeyFromPrf } from '../crypto/keyVault';
import { type Group, openStore, VaultLocked } from './db';
import type { VaultLock } from './vault';

freshIndexedDBPerTest();

const GROUP = {
  groupId: 'group-1',
  secret: new Uint8Array(32).fill(9),
  signingKey: new Uint8Array(32).fill(7),
  me: { author: 'author-ana', name: 'Ana' },
};

/** An application read from the inbox at `seq`. */
function received(id: string, seq: number): ReceivedApplication {
  return {
    id,
    seq,
    received: 29_000_000 + seq,
    name: `Name ${id}`,
    message: 'Hello.',
    reply: { seed: `seed-${id}`, key: `key-${id}` },
  };
}

const INBOX: DoorInbox = { inbox: 'inbox-1', cursor: 0, instance: null, applications: [] };

/** An application this device sent. */
function sent(id: string, sentAt: number): SentApplication {
  return {
    id,
    door: 'door-1',
    groupName: 'Riverside Tenants',
    seed: new Uint8Array(32).fill(1),
    replyKey: new Uint8Array(32).fill(2),
    sentAt,
  };
}

describe('withApplications and dismissed', () => {
  it('add each application once by id, in the order read', () => {
    const one = withApplications(INBOX, [received('a', 1), received('b', 2), received('a', 3)]);
    expect(one.applications.map((application) => application.id)).toEqual(['a', 'b']);
    const two = withApplications(one, [received('b', 4), received('c', 5)]);
    expect(two.applications.map((application) => [application.id, application.seq])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 5],
    ]);
  });

  it('dismiss one by id and leave the rest', () => {
    const inbox = withApplications(INBOX, [received('a', 1), received('b', 2)]);
    expect(dismissed(inbox, 'b').applications.map((application) => application.dismissed)).toEqual([
      undefined,
      true,
    ]);
  });

  it('dismiss deletes the copy of the Documents it carried, and keeps its name and message (#425)', () => {
    const documents = [{ title: 'What I stand for', text: 'Fair rents, canary-a1.' }];
    const inbox = withApplications(INBOX, [{ ...received('a', 1), documents }, received('b', 2)]);
    const [a, b] = dismissed(inbox, 'a').applications;
    expect(a).toEqual({ ...received('a', 1), dismissed: true });
    expect(b).toEqual(received('b', 2));
    expect(JSON.stringify(dismissed(inbox, 'a'))).not.toContain('canary-a1');
  });

  it('keep sent applications 30 days', () => {
    expect(SENT_DAYS).toBe(30);
  });
});

describe('withoutCopies and holdsCopies (#425)', () => {
  const documents = [{ title: 'What I stand for', text: 'Fair rents.' }];
  const inbox = withApplications(INBOX, [
    { ...received('a', 1), documents },
    { ...received('b', 2), documents },
    received('c', 3),
  ]);
  const answered = (id: string) => id !== 'b';

  it('drop the copy of each answered application alone, keeping every application', () => {
    expect(holdsCopies(inbox, answered)).toBe(true);
    const kept = withoutCopies(inbox, answered);
    expect(kept.applications).toEqual([
      received('a', 1),
      { ...received('b', 2), documents },
      received('c', 3),
    ]);
    expect(holdsCopies(kept, answered)).toBe(false);
    expect({ ...kept, applications: [] }).toEqual({ ...inbox, applications: [] });
  });

  it('leave no inbox where the device no longer holds one, as an edit of the store’s may find', () => {
    expect(heldWithoutCopies(undefined, answered)).toBeUndefined();
    expect(heldWithoutCopies(inbox, answered)).toEqual(withoutCopies(inbox, answered));
  });

  it('find nothing to drop in an inbox the device doesn’t hold, or with nothing answered', () => {
    expect(holdsCopies(undefined, answered)).toBe(false);
    expect(holdsCopies(inbox, () => false)).toBe(false);
    expect(holdsCopies(withApplications(INBOX, [received('a', 1)]), () => true)).toBe(false);
  });
});

describe('withCards and withoutCardSeeds (#426)', () => {
  const card = (id: string, seq: number): ReceivedCard => ({
    id,
    seq,
    received: 29_000_000 + seq,
    seed: `seed-${id}`,
  });

  it('add each card once by id, in the order read, to an inbox kept before cards', () => {
    const one = withCards(INBOX, [card('a', 1), card('b', 2), card('a', 3)]);
    expect(one.cards?.map((held) => held.id)).toEqual(['a', 'b']);
    const two = withCards(one, [card('b', 4), card('c', 5)]);
    expect(two.cards?.map((held) => [held.id, held.seq])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 5],
    ]);
    expect(two.applications).toEqual(INBOX.applications);
  });

  it('drop the seed of each card `done` names, keeping the card, and leave an inbox without cards as it is', () => {
    const inbox = withCards(INBOX, [card('a', 1), card('b', 2)]);
    const kept = withoutCardSeeds(inbox, (held) => held.id === 'a');
    expect(kept.cards).toEqual([{ id: 'a', seq: 1, received: 29_000_001 }, card('b', 2)]);
    expect(withoutCardSeeds(INBOX, () => true)).toEqual(INBOX);
  });
});

describe('a group’s front-door inbox in the store (#121)', () => {
  it('starts absent, takes each edit in one change and tells listeners the group', async () => {
    const store = await openStore();
    await store.addGroup(GROUP);
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    expect((await store.getGroup('group-1'))?.door).toBeUndefined();
    await store.updateInbox('group-1', (held) =>
      withApplications(held ?? INBOX, [received('a', 1)]),
    );
    await store.updateInbox('group-1', (held) =>
      held === undefined ? held : dismissed(held, 'a'),
    );

    expect((await store.getGroup('group-1'))?.door?.applications).toEqual([
      { ...received('a', 1), dismissed: true },
    ]);
    expect(heard).toEqual(['group-1', 'group-1']);
    await store.updateInbox('group-1', () => undefined);
    expect((await store.getGroup('group-1'))?.door).toBeUndefined();
    store.close();
  });

  it('takes none for a group this device is leaving, and drops it with an archive', async () => {
    const store = await openStore();
    await store.addGroup(GROUP);
    await store.addGroup({ ...GROUP, groupId: 'group-2' });
    await store.updateInbox('group-1', () => withApplications(INBOX, [received('a', 1)]));
    await store.markArchived('group-1', 'dissolved');
    await store.updateInbox('group-1', () => withApplications(INBOX, [received('b', 2)]));
    await store.markLeaving('group-2', utf8('{"leave":1}'));
    await store.updateInbox('group-2', () => withApplications(INBOX, [received('c', 3)]));

    const [archived, leaving] = [await store.getGroup('group-1'), await store.getGroup('group-2')];
    expect(archived?.door).toBeUndefined();
    expect(leaving?.door).toBeUndefined();
    await expect(store.updateInbox('missing', () => INBOX)).rejects.toThrow('No such group');
    store.close();
  });
});

describe('the applications this device sent, in a store of their own (#121)', () => {
  it('lists them oldest first, keeps an update by id, and forgets one, telling listeners no group id', async () => {
    const store = await openStore();
    const heard: string[] = [];
    store.subscribe((groupId) => heard.push(groupId));

    await store.addSent(sent('late', 20));
    await store.addSent(sent('early', 10));
    expect((await store.listSent()).map((application) => application.id)).toEqual([
      'early',
      'late',
    ]);

    const invite = new Uint8Array(32).fill(5);
    await store.updateSent('late', (held) => ({ ...held, invite, id: 'other' }));
    await store.updateSent('gone', (held) => ({ ...held, invite }));
    const late = (await store.listSent()).find((application) => application.id === 'late');
    expect(Array.from(late?.invite ?? [])).toEqual(Array.from(invite));

    await store.dropSent('early');
    expect((await store.listSent()).map((application) => application.id)).toEqual(['late']);
    expect(heard).toEqual([SENT_CHANGED, SENT_CHANGED, SENT_CHANGED, SENT_CHANGED]);
    expect(SENT_CHANGED).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    store.close();
  });

  it('upgrades version 6 as #95 left it, adding only the sent store, and keeping every group', async () => {
    const old = await openDB('reconcile', 6, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
        database.createObjectStore('personal', { keyPath: 'id' });
        database.createObjectStore('device');
        database.createObjectStore('vault', { keyPath: 'id' });
      },
    });
    const kept: Group = {
      ...GROUP,
      log: [],
      cursor: 3,
      relayNow: 9,
      instance: 'i',
      outbox: [],
      lastSyncAt: 1,
    };
    await old.put('groups', kept);
    old.close();

    const store = await openStore();
    expect((await store.listGroups()).map((group) => [group.groupId, group.cursor])).toEqual([
      ['group-1', 3],
    ]);
    expect(await store.listSent()).toEqual([]);
    await store.addSent(sent('a', 1));
    expect(await store.listSent()).toHaveLength(1);
    store.close();
  });
});

describe('the front door under a passkey vault (#95, #121)', () => {
  const SALT = new Uint8Array(32).fill(0x33);
  const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
  const LOCK: VaultLock = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

  it('keeps a group’s inbox, which holds no key, through sealing, a locked launch and unlocking', async () => {
    const store = await openStore();
    await store.addGroup(GROUP);
    await store.updateInbox('group-1', () => withApplications(INBOX, [received('a', 1)]));
    await store.sealKeys(LOCK, KEY);
    store.close();

    const locked = await openStore();
    await locked.updateInbox('group-1', (held) =>
      withApplications(held ?? INBOX, [received('b', 2)]),
    );
    await expect(locked.getGroup('group-1')).rejects.toThrow(VaultLocked);
    expect(await locked.unlock(KEY)).toBe(true);
    const door = (await locked.getGroup('group-1'))?.door;
    expect(door?.applications.map((application) => application.id)).toEqual(['a', 'b']);
    locked.close();
  });

  it('keeps an application’s copy of Documents as the rest of it: on the group, which a locked launch reads none of (#425)', async () => {
    const documents = [{ title: 'What I stand for', text: 'Fair rents, canary-b2.' }];
    const store = await openStore();
    await store.addGroup(GROUP);
    await store.updateInbox('group-1', () =>
      withApplications(INBOX, [{ ...received('a', 1), documents }]),
    );
    await store.sealKeys(LOCK, KEY);
    store.close();

    const locked = await openStore();
    await expect(locked.getGroup('group-1')).rejects.toThrow(VaultLocked);
    await expect(locked.listGroups()).rejects.toThrow(VaultLocked);
    expect(await locked.unlock(KEY)).toBe(true);
    const [held] = (await locked.getGroup('group-1'))?.door?.applications ?? [];
    expect(held?.documents).toEqual(documents);
    await locked.updateInbox('group-1', (inbox) =>
      inbox === undefined ? inbox : dismissed(inbox, 'a'),
    );
    locked.close();

    const raw = await openDB('reconcile');
    const records: unknown[] = [];
    for (const name of Array.from(raw.objectStoreNames)) records.push(await raw.getAll(name));
    raw.close();
    expect(JSON.stringify(records)).not.toContain('canary-b2');
  });

  it('seals the applications this device sent with the other keys, so a locked launch reads none until unlocked (#265)', async () => {
    const store = await openStore();
    await store.addGroup(GROUP);
    await store.addSent(sent('a', 1));
    await store.sealKeys(LOCK, KEY);
    store.close();

    const locked = await openStore();
    await expect(locked.listSent()).rejects.toThrow(VaultLocked);
    await expect(locked.listGroups()).rejects.toThrow(VaultLocked);
    expect(await locked.unlock(KEY)).toBe(true);
    expect((await locked.listSent()).map((application) => application.id)).toEqual(['a']);
    locked.close();
  });
});
