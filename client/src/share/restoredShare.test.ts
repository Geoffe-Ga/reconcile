/**
 * A restored share starts paused (#328, #105's gap). A person stops sharing a
 * Document by link, and the relay keeps the tombstone for 30 days; an older
 * backup still holds the share as live. A device restored from it and opened
 * only once the tombstone has lapsed would find nothing in the mailbox and
 * post the Document to the old link again. So every share a restore brings
 * back is paused: nothing goes to its mailbox until the person says Keep
 * sharing on that Document, and Stop sharing posts only a tombstone.
 *
 * One test per restore path that can carry a share: a backup file, the relay
 * copy as recovery (#118) restores it, and a backup file restored on the
 * unlock screen (#95). A linked device's copy (#96) carries no share
 * (`withoutShares`), and the relay copy linked devices keep (#247) is
 * covered in `app/linkedBackup.test.ts`.
 *
 * A device needn't restore anything to miss a Stop (#339): two devices can
 * hold one live share, and the one not opened until the tombstone lapsed has
 * nothing to tell it the link was stopped. So a share this device hasn't
 * posted to for the tombstone's lifetime is paused too.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { shareChannelOf } from '../crypto/share';
import { createRelay, type Relay } from '../net/relay';
import { openStore, type Store } from '../store/db';
import type { PersonalDocument } from '../store/personal';
import { fetchRelayBackup, startRelayBackup } from '../store/relayBackup';
import {
  exportGroups,
  importGroups,
  importSnapshot,
  replaceWithBackup,
  takeSnapshot,
} from '../store/snapshot';
import { TEST_NOW } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  keepSharesAlive,
  keepSharing,
  postCopy,
  postEdits,
  readShare,
  REFRESH_AFTER_DAYS,
  SHARE_TTL_DAYS,
  type ShareLink,
  type ShareServices,
  startSharing,
  stopSharing,
} from './shareLink';

freshIndexedDBPerTest();

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;
const PASSPHRASE = 'a long walk to the river';
const CHEAP = 4;

/** Past the tombstone's lifetime: the relay drops a 30-day blob on the 31st day after the day it arrived. */
const LAPSED_DAYS = SHARE_TTL_DAYS + 2;

const STATEMENT: PersonalDocument = {
  id: 'UmVzdG9yZWQgc3RhdGVtZQ',
  title: 'What I stand for',
  text: 'I show up for my neighbors.\n',
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
};

const READING: PersonalDocument = {
  id: 'UmVhZGluZyBsaXN0IHR3bw',
  title: 'Reading list',
  text: '- Braiding Sweetgrass\n',
  createdAt: TEST_NOW + 1,
  updatedAt: TEST_NOW + 1,
};

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** One device: its store, and its share services on the fake relay, with a clock a test moves. */
interface Device {
  readonly store: Store;
  readonly services: ShareServices & { readonly store: Store; readonly relay: Relay };
  readonly clock: { now: number };
}

/** Opens device `name` on `fake`, its clock at `at`. */
async function device(fake: FakeRelay, name: string, at = TEST_NOW): Promise<Device> {
  const store = await openStore(name);
  stores.push(store);
  const clock = { now: at };
  const services = {
    store,
    relay: createRelay({ fetch: fake.fetch }),
    seal: xchachaSeal,
    now: () => clock.now,
  };
  return { store, services, clock };
}

/** Saves `document` on `owner`, shares it, and hands back its link. */
async function shared(owner: Device, document = STATEMENT): Promise<ShareLink> {
  await owner.store.savePersonal(document);
  const started = await startSharing(owner.services, document.id);
  if (started.kind !== 'shared') throw new Error(`Expected a share, not ${started.kind}.`);
  return started.link;
}

/** What the link shows to anyone who holds it. */
function shows(fake: FakeRelay, link: ShareLink) {
  return readShare({ relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal }, link);
}

/** Every PUT the relay took for the link's mailbox. */
function postsTo(fake: FakeRelay, link: ShareLink): string[] {
  const { mailbox } = shareChannelOf(link.seed);
  return fake.requests
    .filter(({ method, url }) => method === 'PUT' && url.startsWith(`/v1/mailbox/${mailbox}?`))
    .map(({ url }) => url);
}

/** Moves the relay's clock on `days` days, so every blob posted for 30 days before then has gone. */
function laterBy(fake: FakeRelay, days: number): number {
  fake.minute += days * DAY_MINUTES;
  return TEST_NOW + days * DAY_MS;
}

/** Takes a backup of `owner` now, and hands back how to restore it onto another device later. */
type RestorePath = (owner: Device) => Promise<(onto: Device) => Promise<unknown>>;

/** A backup file, saved and restored from Settings (#78). */
const backupFile: RestorePath = async (owner) => {
  const { file } = await exportGroups(owner.store, PASSPHRASE, CHEAP);
  return (onto) => importGroups(onto.store, file, PASSPHRASE);
};

/** The relay copy (#97), as recovery (#118) restores it: `fetchRelayBackup`, then `importSnapshot`. */
const relayCopy: RestorePath = async (owner) => {
  const { store, services } = owner;
  await startRelayBackup({ store, relay: services.relay, now: services.now });
  const state = await store.getRelayBackup();
  if (state === undefined) throw new Error('Expected a relay backup key.');
  const key = Uint8Array.from(state.key);
  return async (onto) => {
    const plaintext = await fetchRelayBackup(onto.services.relay, key);
    if (plaintext === null) throw new Error('Expected the relay copy.');
    await importSnapshot(onto.store, plaintext);
  };
};

/** A backup file restored on the unlock screen, once a passkey no longer opens the vault (#95). */
const unlockScreen: RestorePath = async (owner) => {
  const { file } = await exportGroups(owner.store, PASSPHRASE, CHEAP);
  return (onto) => replaceWithBackup(onto.store, file, PASSPHRASE);
};

const PATHS: readonly (readonly [string, RestorePath])[] = [
  ['a backup file', backupFile],
  ['the relay copy, as recovery restores it (#118)', relayCopy],
  ['a backup file on the unlock screen (#95)', unlockScreen],
];

/**
 * Ana shares her statement, backs up while the link is live, then stops
 * sharing. A new device restores the backup only once the tombstone has
 * lapsed at the relay: the mailbox holds nothing, as if never stopped.
 */
async function stoppedThenRestoredLate(fake: FakeRelay, path: RestorePath) {
  const ana = await device(fake, 'ana');
  const link = await shared(ana);
  const restore = await path(ana);
  expect(await stopSharing(ana.services, STATEMENT.id)).toBe('stopped');
  const at = laterBy(fake, LAPSED_DAYS);
  expect(fake.blobs(shareChannelOf(link.seed).mailbox)).toEqual([]);
  const restored = await device(fake, 'restored', at);
  await restore(restored);
  return { link, restored, posts: postsTo(fake, link).length };
}

describe('a share a restore brings back (#328)', () => {
  it.each(PATHS)(
    'from %s, posts nothing to the link, even after its tombstone lapsed, until the person keeps sharing',
    async (_path, path) => {
      const fake = createFakeRelay();
      const { link, restored, posts } = await stoppedThenRestoredLate(fake, path);
      const { store, services, clock } = restored;

      // Each way a copy goes out: at launch, on leaving the editor after an edit, and directly.
      expect(await keepSharesAlive(services)).toEqual([]);
      await store.savePersonal({ ...STATEMENT, text: 'Written after the restore.\n' });
      expect(await postEdits(services, STATEMENT.id)).toBe('paused');
      expect(await postCopy(services, STATEMENT.id)).toBe('paused');
      clock.now += REFRESH_AFTER_DAYS * DAY_MS;
      expect(await keepSharesAlive(services)).toEqual([]);

      expect(postsTo(fake, link)).toHaveLength(posts);
      expect(await shows(fake, link)).toEqual({ kind: 'gone' });
      expect((await store.getPersonal(STATEMENT.id))?.share?.paused).toBe(true);
    },
  );

  it('posts once the person keeps sharing, and keeps the link alive from then on', async () => {
    const fake = createFakeRelay();
    const { link, restored, posts } = await stoppedThenRestoredLate(fake, backupFile);
    const { store, services, clock } = restored;
    await store.savePersonal({ ...STATEMENT, text: 'Written after the restore.\n' });

    expect(await keepSharing(services, STATEMENT.id)).toBe('posted');

    expect(postsTo(fake, link)).toHaveLength(posts + 1);
    expect(await shows(fake, link)).toEqual({
      kind: 'shown',
      title: STATEMENT.title,
      text: 'Written after the restore.\n',
    });
    const share = (await store.getPersonal(STATEMENT.id))?.share;
    expect(share?.paused).toBeUndefined();
    expect(share?.pending).toBe(false);
    expect(share?.lastPostedAt).toBe(clock.now);
    clock.now += REFRESH_AFTER_DAYS * DAY_MS;
    expect(await keepSharesAlive(services)).toEqual([[STATEMENT.id, 'posted']]);
    expect(postsTo(fake, link)).toHaveLength(posts + 2);
  });

  it('keeps the person’s choice when the relay can’t be reached, and posts at the next launch', async () => {
    const fake = createFakeRelay();
    const { link, restored, posts } = await stoppedThenRestoredLate(fake, backupFile);
    fake.offline = true;

    expect(await keepSharing(restored.services, STATEMENT.id)).toBe('failed');

    const share = (await restored.store.getPersonal(STATEMENT.id))?.share;
    expect(share?.paused).toBeUndefined();
    expect(share?.pending).toBe(true);
    fake.offline = false;
    expect(await keepSharesAlive(restored.services)).toEqual([[STATEMENT.id, 'posted']]);
    expect(postsTo(fake, link)).toHaveLength(posts + 1);
  });

  it('Stop sharing posts only a tombstone, and nothing goes to the link after it', async () => {
    const fake = createFakeRelay();
    const { link, restored, posts } = await stoppedThenRestoredLate(fake, backupFile);
    const { store, services, clock } = restored;

    expect(await stopSharing(services, STATEMENT.id)).toBe('stopped');

    expect(postsTo(fake, link)).toHaveLength(posts + 1);
    expect(fake.blobs(shareChannelOf(link.seed).mailbox)).toHaveLength(1);
    expect(await shows(fake, link)).toEqual({ kind: 'gone' });
    expect((await store.getPersonal(STATEMENT.id))?.share).toBeUndefined();
    await store.savePersonal({ ...STATEMENT, text: 'Written after Stop sharing.\n' });
    expect(await postEdits(services, STATEMENT.id)).toBe('unchanged');
    clock.now += REFRESH_AFTER_DAYS * DAY_MS;
    expect(await keepSharesAlive(services)).toEqual([]);
    expect(await keepSharing(services, STATEMENT.id)).toBe('unshared');
    expect(postsTo(fake, link)).toHaveLength(posts + 1);
  });

  it('changes nothing when Stop sharing can’t reach the relay: the share stays paused', async () => {
    const fake = createFakeRelay();
    const { link, restored, posts } = await stoppedThenRestoredLate(fake, backupFile);
    fake.offline = true;

    expect(await stopSharing(restored.services, STATEMENT.id)).toBe('failed');

    fake.offline = false;
    expect((await restored.store.getPersonal(STATEMENT.id))?.share?.paused).toBe(true);
    expect(await keepSharesAlive(restored.services)).toEqual([]);
    expect(postsTo(fake, link)).toHaveLength(posts);
  });

  it('finds the tombstone when the person keeps sharing a link stopped since, and posts nothing', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const link = await shared(ana);
    const restore = await backupFile(ana);
    await stopSharing(ana.services, STATEMENT.id);
    // Restored within the tombstone's lifetime, so the relay still holds it.
    const restored = await device(fake, 'restored', laterBy(fake, SHARE_TTL_DAYS - 1));
    await restore(restored);
    const posts = postsTo(fake, link).length;

    expect(await keepSharing(restored.services, STATEMENT.id)).toBe('stopped');

    expect(postsTo(fake, link)).toHaveLength(posts);
    expect((await restored.store.getPersonal(STATEMENT.id))?.share).toBeUndefined();
    expect(await shows(fake, link)).toEqual({ kind: 'gone' });
  });

  it('leaves alone a share the device makes after the restore', async () => {
    const fake = createFakeRelay();
    const { restored } = await stoppedThenRestoredLate(fake, backupFile);
    const { store, services, clock } = restored;
    const own = await shared(restored, READING);
    await store.savePersonal({ ...READING, text: '- Braiding Sweetgrass\n- Emergent Strategy\n' });

    expect(await postEdits(services, READING.id)).toBe('posted');
    expect(await shows(fake, own)).toEqual({
      kind: 'shown',
      title: READING.title,
      text: '- Braiding Sweetgrass\n- Emergent Strategy\n',
    });
    clock.now += REFRESH_AFTER_DAYS * DAY_MS;
    expect(await keepSharesAlive(services)).toEqual([[READING.id, 'posted']]);
    expect((await store.getPersonal(READING.id))?.share?.paused).toBeUndefined();
  });

  it('leaves alone the device’s own live share, which no restore brought', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    await ana.store.savePersonal(STATEMENT);
    const restore = await backupFile(ana);
    const laptop = await device(fake, 'laptop');
    const older = { ...STATEMENT, createdAt: TEST_NOW - 1, updatedAt: TEST_NOW - 1 };
    const link = await shared(laptop, older);
    const own = await laptop.store.getPersonal(STATEMENT.id);

    // The file's later copy holds no share, so the laptop keeps its own, unpaused.
    await restore(laptop);
    // A link bundle (#96) never carries a share either.
    await importSnapshot(laptop.store, (await takeSnapshot(ana.store, 'link')).plaintext, 'link');

    const held = (await laptop.store.getPersonal(STATEMENT.id))?.share;
    expect(held?.paused).toBeUndefined();
    expect(held?.seed).toEqual(own?.share?.seed);
    expect(await postCopy(laptop.services, STATEMENT.id)).toBe('posted');
    expect((await shows(fake, link)).kind).toBe('shown');
  });
});

/** The fake relay's clock when a test begins: day 0 of the tests below. */
const DAY_ZERO = createFakeRelay().minute;

/** Moves the relay's clock to `days` days after day 0, and hands back a device's time then. */
function onDay(fake: FakeRelay, days: number): number {
  fake.minute = DAY_ZERO + days * DAY_MINUTES;
  return TEST_NOW + days * DAY_MS;
}

/**
 * Ana's phone and laptop both hold her statement's live share (#339): the
 * phone shared it on day 0, and the laptop restored the phone's backup and
 * she kept sharing there. She stops sharing on the laptop on `stoppedOn`,
 * and the phone isn't opened again until `openedOn`. Hands back the phone,
 * its clock on `openedOn`, and how many posts the link had taken by then.
 */
async function stoppedElsewhere(fake: FakeRelay, stoppedOn: number, openedOn: number) {
  const phone = await device(fake, 'phone');
  const link = await shared(phone);
  const laptop = await device(fake, 'laptop');
  await (
    await backupFile(phone)
  )(laptop);
  expect(await keepSharing(laptop.services, STATEMENT.id)).toBe('posted');
  laptop.clock.now = onDay(fake, stoppedOn);
  expect(await stopSharing(laptop.services, STATEMENT.id)).toBe('stopped');
  phone.clock.now = onDay(fake, openedOn);
  return { link, phone, posts: postsTo(fake, link).length };
}

describe('a share another device stopped (#339)', () => {
  it('posts nothing from a device not opened until the tombstone lapsed, until the person keeps sharing there', async () => {
    const fake = createFakeRelay();
    const { link, phone, posts } = await stoppedElsewhere(fake, 0, LAPSED_DAYS);
    const { store, services, clock } = phone;
    expect(fake.blobs(shareChannelOf(link.seed).mailbox)).toEqual([]);
    // No restore paused it: the phone just hasn't posted for the tombstone's lifetime.
    expect((await store.getPersonal(STATEMENT.id))?.share?.paused).toBeUndefined();

    // Each way a copy goes out: at launch, on leaving the editor after an edit, and directly.
    expect(await keepSharesAlive(services)).toEqual([]);
    await store.savePersonal({ ...STATEMENT, text: 'Written on the phone.\n' });
    expect(await postEdits(services, STATEMENT.id)).toBe('paused');
    expect(await postCopy(services, STATEMENT.id)).toBe('paused');
    expect(postsTo(fake, link)).toHaveLength(posts);
    expect(await shows(fake, link)).toEqual({ kind: 'gone' });

    expect(await keepSharing(services, STATEMENT.id)).toBe('posted');

    expect(postsTo(fake, link)).toHaveLength(posts + 1);
    expect(await shows(fake, link)).toEqual({
      kind: 'shown',
      title: STATEMENT.title,
      text: 'Written on the phone.\n',
    });
    clock.now += REFRESH_AFTER_DAYS * DAY_MS;
    expect(await keepSharesAlive(services)).toEqual([[STATEMENT.id, 'posted']]);
  });

  it('finds the tombstone when the person keeps sharing while the relay still holds it, and posts nothing', async () => {
    const fake = createFakeRelay();
    // Stopped on day 10, so its tombstone outlives the phone's own 30 days.
    const { link, phone, posts } = await stoppedElsewhere(fake, 10, SHARE_TTL_DAYS + 5);

    expect(await keepSharesAlive(phone.services)).toEqual([]);
    expect(await keepSharing(phone.services, STATEMENT.id)).toBe('stopped');

    expect(postsTo(fake, link)).toHaveLength(posts);
    expect((await phone.store.getPersonal(STATEMENT.id))?.share).toBeUndefined();
    expect(await shows(fake, link)).toEqual({ kind: 'gone' });
  });

  it('keeps the person’s choice when the relay can’t be reached, and posts at the next launch', async () => {
    const fake = createFakeRelay();
    const { link, phone, posts } = await stoppedElsewhere(fake, 0, LAPSED_DAYS);
    fake.offline = true;

    expect(await keepSharing(phone.services, STATEMENT.id)).toBe('failed');

    expect((await phone.store.getPersonal(STATEMENT.id))?.share?.pending).toBe(true);
    fake.offline = false;
    phone.clock.now += DAY_MS;
    expect(await keepSharesAlive(phone.services)).toEqual([[STATEMENT.id, 'posted']]);
    expect(postsTo(fake, link)).toHaveLength(posts + 1);
  });

  it('asks again when a choice made offline still hasn’t posted 30 days later', async () => {
    const fake = createFakeRelay();
    const { link, phone, posts } = await stoppedElsewhere(fake, 0, LAPSED_DAYS);
    fake.offline = true;
    expect(await keepSharing(phone.services, STATEMENT.id)).toBe('failed');
    fake.offline = false;

    phone.clock.now += SHARE_TTL_DAYS * DAY_MS;

    expect(await keepSharesAlive(phone.services)).toEqual([]);
    expect(await postCopy(phone.services, STATEMENT.id)).toBe('paused');
    expect(postsTo(fake, link)).toHaveLength(posts);
  });

  it('Stop sharing posts only a tombstone, and nothing goes to the link after it', async () => {
    const fake = createFakeRelay();
    const { link, phone, posts } = await stoppedElsewhere(fake, 0, LAPSED_DAYS);
    const { store, services, clock } = phone;

    expect(await stopSharing(services, STATEMENT.id)).toBe('stopped');

    expect(postsTo(fake, link)).toHaveLength(posts + 1);
    expect(await shows(fake, link)).toEqual({ kind: 'gone' });
    expect((await store.getPersonal(STATEMENT.id))?.share).toBeUndefined();
    clock.now += REFRESH_AFTER_DAYS * DAY_MS;
    expect(await keepSharesAlive(services)).toEqual([]);
    expect(postsTo(fake, link)).toHaveLength(posts + 1);
  });
});
