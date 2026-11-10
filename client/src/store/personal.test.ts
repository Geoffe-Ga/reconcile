/**
 * Personal Documents (#93; ADR-0001, ADR-0074's personal page at level 2):
 * a person's own mission statement and other Documents, kept only in this
 * device's IndexedDB, edited directly with no votes.
 */
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { newSigningKeys } from '../crypto/sign';
import { freshIndexedDBPerTest } from '../test/idb';
import { DATABASE_NAME, openStore } from './db';
import {
  isPersonalDocument,
  isShareState,
  keepsHeldCopy,
  newPersonalId,
  PERSONAL_ID_BYTES,
  PERSONAL_TITLE_MAX,
  type PersonalDocument,
  type ShareState,
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

const KEYS = newSigningKeys();

/** A well-formed share (#105), with `changes` over it. */
function share(changes: Partial<ShareState> = {}): ShareState {
  return {
    seed: new Uint8Array(32).fill(5),
    secretKey: KEYS.secretKey,
    publicKey: KEYS.publicKey,
    n: 1,
    lastPostedAt: 1_762_650_000_000,
    pending: false,
    ...changes,
  };
}

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

describe('isShareState', () => {
  it('accepts a share before its first post and after one, pending or not', () => {
    expect(isShareState(share())).toBe(true);
    expect(isShareState(share({ n: 0, lastPostedAt: null, pending: true }))).toBe(true);
    expect(isPersonalDocument(doc({ share: share() }))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['nothing', null],
    ['a seed of 31 bytes', share({ seed: new Uint8Array(31) })],
    ['a seed of 33 bytes', share({ seed: new Uint8Array(33) })],
    ['a seed that isn’t bytes', { ...share(), seed: Array.from(new Uint8Array(32)) }],
    ['a secret key of 31 bytes', share({ secretKey: KEYS.secretKey.subarray(0, 31) })],
    ['a public key of 31 bytes', share({ publicKey: KEYS.publicKey.subarray(0, 31) })],
    ['a public key that isn’t its secret key’s', share({ publicKey: newSigningKeys().publicKey })],
    ['a negative n', share({ n: -1 })],
    ['a fractional n', share({ n: 1.5 })],
    ['a fractional post time', share({ lastPostedAt: 1.5 })],
    ['a post time that isn’t a number', { ...share(), lastPostedAt: '1' }],
    ['a pending that isn’t true or false', { ...share(), pending: 1 }],
  ])('refuses %s, alone and on a Document', (_name, value) => {
    expect(isShareState(value)).toBe(false);
    expect(isPersonalDocument({ ...doc(), share: value })).toBe(false);
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
    expect([...upgraded.objectStoreNames].sort()).toEqual(['groups', 'personal']);
    expect(upgraded.version).toBe(4);
    upgraded.close();
  });
});

/** `value` with every byte array spelled as a plain list, so arrays IndexedDB cloned compare equal. */
function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      Object.prototype.toString.call(item) === '[object Uint8Array]'
        ? Array.from(item as Uint8Array)
        : item,
    ),
  ) as unknown;
}

describe('a shared Document in the store (#105)', () => {
  it('keeps its share state when the editor saves it again, marking the link behind once the words change', async () => {
    const store = await openStore();
    await store.savePersonal(doc());
    await store.updateShare(doc().id, () => share());

    await store.savePersonal(doc({ updatedAt: 1_762_650_100_000 }));
    expect(plain(await store.getPersonal(doc().id))).toEqual(
      plain(doc({ updatedAt: 1_762_650_100_000, share: share() })),
    );

    await store.savePersonal(doc({ title: 'Renamed', updatedAt: 1_762_650_200_000 }));
    expect(plain((await store.getPersonal(doc().id))?.share)).toEqual(
      plain(share({ pending: true })),
    );

    await store.updateShare(doc().id, () => share());
    await store.savePersonal(doc({ title: 'Renamed', text: 'New words.' }));
    expect(plain((await store.getPersonal(doc().id))?.share)).toEqual(
      plain(share({ pending: true })),
    );
  });

  it('never takes a share from what the editor saves: only updateShare sets one', async () => {
    const store = await openStore();
    await store.savePersonal(doc({ share: share() }));

    expect(await store.getPersonal(doc().id)).toEqual(doc());

    await store.updateShare(doc().id, () => share());
    await store.savePersonal(doc({ share: share({ n: 9 }) }));
    expect(plain((await store.getPersonal(doc().id))?.share)).toEqual(plain(share()));
  });

  it('sets, changes and drops a share in one change, handing the edit the stored Document', async () => {
    const store = await openStore();
    await store.savePersonal(doc());
    const seen: (ShareState | undefined)[] = [];

    const set = await store.updateShare(doc().id, (held) => {
      seen.push(held.share);
      return share();
    });
    const changed = await store.updateShare(doc().id, (held) => {
      seen.push(held.share);
      return held.share === undefined ? undefined : { ...held.share, n: 2 };
    });
    const dropped = await store.updateShare(doc().id, () => undefined);

    expect(plain(seen)).toEqual(plain([undefined, share()]));
    expect(plain(set)).toEqual(plain(doc({ share: share() })));
    expect(plain(changed)).toEqual(plain(doc({ share: share({ n: 2 }) })));
    expect(dropped).toEqual(doc());
    expect(await store.getPersonal(doc().id)).toEqual(doc());
    expect(await store.listPersonal()).toEqual([doc()]);
  });

  it('changes nothing for a Document the device no longer holds, so no share brings one back', async () => {
    const store = await openStore();

    const kept = await store.updateShare(doc().id, () => share());

    expect(kept).toBeUndefined();
    expect(await store.listPersonal()).toEqual([]);
  });

  it('refuses a share that isn’t well formed, keeping what was there', async () => {
    const store = await openStore();
    await store.savePersonal(doc());
    await store.updateShare(doc().id, () => share());

    await expect(store.updateShare(doc().id, () => share({ n: -1 }))).rejects.toThrow(
      'This isn’t a share this device can keep.',
    );

    expect(plain((await store.getPersonal(doc().id))?.share)).toEqual(plain(share()));
  });

  it('deletes a shared Document whole, share state and all', async () => {
    const store = await openStore();
    await store.savePersonal(doc());
    await store.updateShare(doc().id, () => share());

    await store.deletePersonal(doc().id);

    expect(await store.listPersonal()).toEqual([]);
  });
});
