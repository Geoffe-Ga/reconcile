/**
 * Personal Documents (#93; ADR-0001, ADR-0074's personal page at level 2):
 * a person's own mission statement and other Documents, kept only in this
 * device's IndexedDB, edited directly with no votes.
 */
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { freshIndexedDBPerTest } from '../test/idb';
import { DATABASE_NAME, openStore } from './db';
import {
  isPersonalDocument,
  keepsHeldCopy,
  newPersonalId,
  PERSONAL_ID_BYTES,
  PERSONAL_TITLE_MAX,
  type PersonalDocument,
} from './personal';

freshIndexedDBPerTest();

/** A well-formed personal Document, with `changes` over it. */
function doc(changes: Partial<PersonalDocument> = {}): PersonalDocument {
  return {
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    title: 'My mission statement',
    text: '# What I stand for\nI show up for my neighbors.\n',
    createdAt: 1_762_650_000_000,
    updatedAt: 1_762_650_000_000,
    ...changes,
  };
}

const OTHER = 'BBBBBBBBBBBBBBBBBBBBBA';

describe('newPersonalId', () => {
  it('is 16 random bytes in unpadded base64url, new each time', () => {
    const ids = new Set(Array.from({ length: 50 }, newPersonalId));

    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(fromBase64url(id)).toHaveLength(PERSONAL_ID_BYTES);
    }
    expect(PERSONAL_ID_BYTES).toBe(16);
  });
});

describe('isPersonalDocument', () => {
  it('accepts a well-formed Document, and a blank text', () => {
    expect(isPersonalDocument(doc())).toBe(true);
    expect(isPersonalDocument(doc({ text: '' }))).toBe(true);
  });

  it('counts the title’s 120 code points after NFC, so an emoji or a combining accent counts once', () => {
    expect(PERSONAL_TITLE_MAX).toBe(120);
    expect(isPersonalDocument(doc({ title: 'x'.repeat(120) }))).toBe(true);
    expect(isPersonalDocument(doc({ title: '🌱'.repeat(120) }))).toBe(true);
    expect(isPersonalDocument(doc({ title: 'é'.repeat(120) }))).toBe(true);
    expect(isPersonalDocument(doc({ title: 'x' }))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['nothing', null],
    ['a list', [doc()]],
    ['an id of 15 bytes', doc({ id: 'A'.repeat(20) })],
    ['an id of 17 bytes', doc({ id: 'A'.repeat(23) })],
    ['an id in non-canonical base64url', doc({ id: `${'A'.repeat(21)}B` })],
    ['an id that isn’t base64url', doc({ id: `${'A'.repeat(21)}=` })],
    ['an id that isn’t text', { ...doc(), id: 16 }],
    ['a blank title', doc({ title: '' })],
    ['a title of spaces', doc({ title: '   ' })],
    ['a title with spaces around it', doc({ title: ' Mine ' })],
    ['a title of 121 code points', doc({ title: 'x'.repeat(121) })],
    ['a title that isn’t text', { ...doc(), title: 7 }],
    ['a text that isn’t text', { ...doc(), text: null }],
    ['a fractional creation time', doc({ createdAt: 1.5 })],
    ['a negative edit time', doc({ updatedAt: -1 })],
    ['an edit time that isn’t a number', { ...doc(), updatedAt: '1' }],
    ['an edit time before its creation', doc({ createdAt: 2, updatedAt: 1 })],
  ])('refuses %s', (_name, value) => {
    expect(isPersonalDocument(value)).toBe(false);
  });
});

describe('keepsHeldCopy', () => {
  it('keeps the device’s copy unless the incoming one was edited later', () => {
    expect(keepsHeldCopy(undefined, doc())).toBe(false);
    expect(keepsHeldCopy(doc({ updatedAt: 5 }), doc({ updatedAt: 6 }))).toBe(false);
    expect(keepsHeldCopy(doc({ updatedAt: 6 }), doc({ updatedAt: 6 }))).toBe(true);
    expect(keepsHeldCopy(doc({ updatedAt: 7 }), doc({ updatedAt: 6 }))).toBe(true);
  });
});

describe('personal Documents in the store', () => {
  it('starts with none', async () => {
    const store = await openStore();

    expect(await store.listPersonal()).toEqual([]);
    expect(await store.getPersonal(doc().id)).toBeUndefined();
  });

  it('keeps a saved Document across a reload: a new store on the same IndexedDB', async () => {
    const first = await openStore();
    await first.savePersonal(doc());
    first.close();

    const reloaded = await openStore();

    expect(await reloaded.listPersonal()).toEqual([doc()]);
    expect(await reloaded.getPersonal(doc().id)).toEqual(doc());
  });

  it('replaces a Document saved again under its id, keeping one copy', async () => {
    const store = await openStore();
    await store.savePersonal(doc());

    await store.savePersonal(doc({ text: 'Rewritten.', updatedAt: 1_762_650_100_000 }));

    expect(await store.listPersonal()).toEqual([
      doc({ text: 'Rewritten.', updatedAt: 1_762_650_100_000 }),
    ]);
  });

  it('lists Documents oldest first, so the first one written leads', async () => {
    const store = await openStore();
    await store.savePersonal(doc({ id: OTHER, title: 'Later', createdAt: 9, updatedAt: 9 }));
    await store.savePersonal(doc({ createdAt: 3, updatedAt: 20 }));
    await store.savePersonal(
      doc({ id: 'CCCCCCCCCCCCCCCCCCCCCA', title: 'Tie', createdAt: 9, updatedAt: 9 }),
    );

    const titles = (await store.listPersonal()).map((kept) => kept.title);

    expect(titles).toEqual(['My mission statement', 'Later', 'Tie']);
  });

  it('refuses a Document that isn’t well formed, keeping what was there', async () => {
    const store = await openStore();
    await store.savePersonal(doc());

    await expect(store.savePersonal(doc({ title: 'x'.repeat(121) }))).rejects.toThrow(
      'This isn’t a personal Document this device can keep.',
    );

    expect(await store.listPersonal()).toEqual([doc()]);
  });

  it('deletes one Document, and leaves alone an id it doesn’t hold', async () => {
    const store = await openStore();
    await store.savePersonal(doc());
    await store.savePersonal(doc({ id: OTHER, title: 'Reading list' }));

    await store.deletePersonal(doc().id);
    await store.deletePersonal('ZZZZZZZZZZZZZZZZZZZZZA');

    expect((await store.listPersonal()).map((kept) => kept.id)).toEqual([OTHER]);
  });

  it('keeps personal Documents apart from groups: neither lists the other', async () => {
    const store = await openStore();
    await store.savePersonal(doc());

    expect(await store.listGroups()).toEqual([]);
  });

  it('upgrades a version 3 database without deleting anything: its groups stay, beside an empty personal store', async () => {
    const old = await openDB(DATABASE_NAME, 3, {
      upgrade(database) {
        database.createObjectStore('groups', { keyPath: 'groupId' });
      },
    });
    const kept = {
      groupId: 'group-1',
      secret: new Uint8Array(32).fill(9),
      signingKey: new Uint8Array(32).fill(7),
      me: { author: 'author-ana', name: 'Ana' },
      log: [],
      cursor: 4,
      relayNow: 12,
      instance: 'relay-1',
      outbox: [],
      lastSyncAt: 1_762_650_000_000,
    };
    await old.put('groups', kept);
    old.close();

    const store = await openStore();

    expect((await store.listGroups()).map((group) => [group.groupId, group.cursor])).toEqual([
      ['group-1', 4],
    ]);
    expect(await store.listPersonal()).toEqual([]);
    store.close();
    const upgraded = await openDB(DATABASE_NAME);
    expect([...upgraded.objectStoreNames].sort()).toEqual([
      'device',
      'groups',
      'personal',
      'vault',
    ]);
    // Version 5 adds #97's device store after #93's version 4, and version 6 the passkey vault (#95).
    expect(upgraded.version).toBe(6);
    upgraded.close();
  });
});
