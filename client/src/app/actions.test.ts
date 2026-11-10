import { afterEach, describe, expect, it } from 'vitest';

import { MAX_PLAINTEXT_BYTES } from '../crypto/seal';
import { publicKeyOf } from '../crypto/sign';
import { stubSeal } from '../crypto/stubSeal';
import { DEFAULT_JOIN_LEVEL, FOUNDER_LEVEL, LEVELS } from '../engine/capabilities';
import { base64url, type ParsedEvent, parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
import { createRelay } from '../net/relay';
import { type Group, openStore, type Store } from '../store/db';
import { createSync, type Sync } from '../store/sync';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  createGroup,
  type CreateGroupValues,
  joinGroup,
  lookupInvite,
  type Services,
} from './actions';
import { newInvite } from './invite';

freshIndexedDBPerTest();

const NOW = 1_762_650_000_000;
const opened: Store[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

const VALUES: CreateGroupValues = {
  groupName: 'Riverside Tenants',
  yourName: 'Ana',
  chat: 'https://chat.example.org/riverside',
  title: 'House rules',
  text: 'Quiet hours start at ten.\n\nBins go out on Tuesday.\n',
};

/** One device: its own store, on the shared fake relay. */
async function device(fake: FakeRelay, name: string): Promise<Services & { sync: Sync }> {
  const store = await openStore(name);
  opened.push(store);
  const relay = createRelay({ fetch: fake.fetch });
  const sync = createSync({ store, relay, clock: () => NOW });
  return { store, relay, sync, seal: stubSeal, now: () => NOW };
}

/** The stored group, which the test expects to exist. */
async function stored(services: Services, groupId: string): Promise<Group> {
  const group = await services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  return group;
}

/** The event the signed record at `index` in the group's outbox carries, once it verifies. */
function queued(group: Group, index = 0): ParsedEvent | null {
  return parseRecord(group.outbox[index] ?? new Uint8Array());
}

/** Every key, secret and id a group's stored record holds, as text, apart from the relay's instance. */
function secretsOf(group: Group): Set<string> {
  // Genesis carries `group: ""`, which is no id.
  const keys = group.log.flatMap((record) => [
    base64url(record.bytes.subarray(0, 32)),
    ...[parseRecord(record.bytes)?.event.group ?? ''].filter((id) => id !== ''),
  ]);
  return new Set([
    group.groupId,
    group.mailbox,
    base64url(group.secret),
    base64url(group.signingKey),
    group.me.author,
    ...keys,
  ]);
}

/** Whether `needle` occurs anywhere inside `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  const last = haystack.length - needle.length;
  for (let start = 0; start <= last; start += 1) {
    if (needle.every((byte, i) => haystack[start + i] === byte)) return true;
  }
  return false;
}

async function created(services: Services, values = VALUES): Promise<string> {
  const result = await createGroup(services, values);
  if (result.outcome !== 'created') throw new Error('Expected a created group.');
  return result.groupId;
}

describe('createGroup', () => {
  it('keeps the group under its genesis id, with fresh keys, and queues the genesis', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const groupId = await created(ana);

    const group = await stored(ana, groupId);
    expect(group.mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(group.secret).toHaveLength(32);
    expect(group.me.name).toBe('Ana');
    expect(group.signingKey).toHaveLength(32);
    expect(group.me.author).toBe(base64url(publicKeyOf(group.signingKey)));
    expect(group.me.author).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(group.outbox).toHaveLength(1);

    const genesis = queued(group);
    expect(genesis?.id).toBe(groupId);
    expect(genesis?.event).toEqual({
      v: 1,
      type: 'genesis',
      group: '',
      author: group.me.author,
      ts: NOW,
      body: {
        name: 'Riverside Tenants',
        founder: 'Ana',
        chat: 'https://chat.example.org/riverside',
        title: 'House rules',
        atoms: ['Quiet hours start at ten.\n', 'Bins go out on Tuesday.\n'],
      },
    });
  });

  it('normalizes each section as Atom text before signing the genesis', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const text = 'Cafe\u0301 rules  \r\nstay.\t\r\n\r\n\r\n- Be kind\r- Ask first';
    const group = await stored(ana, await created(ana, { ...VALUES, text }));
    const genesis = queued(group)?.event;
    expect(genesis?.type === 'genesis' ? genesis.body.atoms : null).toEqual([
      'Caf\u00e9 rules\nstay.\n',
      '- Be kind\n- Ask first\n',
    ]);
  });

  it('leaves the chat out of genesis when there is none', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const group = await stored(ana, await created(ana, { ...VALUES, chat: null }));
    expect(queued(group)?.event.body).not.toHaveProperty('chat');
  });

  it('sends the genesis to the group’s mailbox straight away', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const groupId = await created(ana);
    await ana.sync.syncOnce();

    const group = await stored(ana, groupId);
    expect(fake.blobs(group.mailbox)).toHaveLength(1);
    expect(group.outbox).toEqual([]);
    expect(fold(group.log, group.relayNow).title).toBe('House rules');
  });

  it('refuses a Document too large for one blob, before anything is stored or sent', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const result = await createGroup(ana, { ...VALUES, text: 'x'.repeat(66_000) });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(await ana.store.listGroups()).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('counts the record’s key and signature toward the blob’s limit', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    // A genesis whose bytes alone fit the largest blob, but not with the 96-byte header.
    const base = { ...VALUES, chat: null, text: 'x' };
    const result = await createGroup(ana, base);
    if (result.outcome !== 'created') throw new Error('Expected a group.');
    const record = (await stored(ana, result.groupId)).outbox[0] ?? new Uint8Array();
    const room = MAX_PLAINTEXT_BYTES - record.length;
    const text = 'x'.repeat(1 + room + 1);
    expect(await createGroup(ana, { ...base, text })).toEqual({ outcome: 'too-large' });
    expect(await createGroup(ana, { ...base, text: 'x'.repeat(1 + room) })).toMatchObject({
      outcome: 'created',
    });
  });

  it('makes different keys for every group', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const one = await stored(ana, await created(ana));
    const two = await stored(ana, await created(ana, { ...VALUES, title: 'Other' }));
    expect(one.mailbox).not.toBe(two.mailbox);
    expect(base64url(one.secret)).not.toBe(base64url(two.secret));
    expect(base64url(one.signingKey)).not.toBe(base64url(two.signingKey));
    expect(one.me.author).not.toBe(two.me.author);
  });
});

describe('contains', () => {
  it('finds a run of bytes anywhere, and nothing that isn’t there', () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    expect(contains(bytes, Uint8Array.of(3, 4))).toBe(true);
    expect(contains(bytes, Uint8Array.of(1, 2))).toBe(true);
    expect(contains(bytes, Uint8Array.of(2, 4))).toBe(false);
    expect(contains(bytes, Uint8Array.of(4, 5))).toBe(false);
  });
});

describe('a device in two groups', () => {
  it('holds two unrelated keys, and shares no key, secret or id between the groups', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const ben = await device(fake, 'ben');
    const own = await created(ana);
    const theirs = await created(ben, { ...VALUES, groupName: 'Hilltop Allotments' });
    await ben.sync.syncOnce();
    const benGroup = await stored(ben, theirs);
    const invite = { mailbox: benGroup.mailbox, secret: benGroup.secret };
    const lookup = await lookupInvite(ana, invite);
    if (lookup.kind !== 'found') throw new Error('Expected to find the group.');
    await joinGroup(ana, invite, lookup.group, 'Ana', DEFAULT_JOIN_LEVEL);
    await ana.sync.syncOnce();

    const [one, two] = [await stored(ana, own), await stored(ana, theirs)];
    expect(one.log).toHaveLength(1);
    expect(two.log).toHaveLength(2);
    expect(one.me.author).not.toBe(two.me.author);
    const shared = [...secretsOf(one)].filter((value) => secretsOf(two).has(value));
    expect(shared).toEqual([]);
    for (const [group, other] of [
      [one, two],
      [two, one],
    ] as const) {
      const records = [...group.log.map((record) => record.bytes), ...group.outbox];
      for (const bytes of records) {
        expect(contains(bytes, other.signingKey)).toBe(false);
        expect(contains(bytes, other.secret)).toBe(false);
        expect(contains(bytes, publicKeyOf(other.signingKey))).toBe(false);
      }
    }
  });
});

describe('lookupInvite', () => {
  async function anaInvites(fake: FakeRelay) {
    const ana = await device(fake, 'ana');
    const groupId = await created(ana);
    await ana.sync.syncOnce();
    const group = await stored(ana, groupId);
    return { ana, groupId, invite: { mailbox: group.mailbox, secret: group.secret } };
  }

  it('finds the group’s id, name and Document title from its genesis', async () => {
    const fake = createFakeRelay();
    const { groupId, invite } = await anaInvites(fake);
    const ben = await device(fake, 'ben');

    const lookup = await lookupInvite(ben, invite);

    expect(lookup).toMatchObject({
      kind: 'found',
      group: { groupId, name: 'Riverside Tenants', title: 'House rules' },
    });
  });

  it('tells a device already in the group so', async () => {
    const fake = createFakeRelay();
    const { ana, groupId, invite } = await anaInvites(fake);
    expect(await lookupInvite(ana, invite)).toEqual({ kind: 'joined', groupId });
  });

  it('finds nothing in an empty mailbox, or in blobs that won’t open', async () => {
    const fake = createFakeRelay();
    const ben = await device(fake, 'ben');
    const invite = newInvite();
    expect(await lookupInvite(ben, invite)).toEqual({ kind: 'missing' });

    await ben.relay.putBlob(invite.mailbox, new Uint8Array(1024).fill(7));
    expect(await lookupInvite(ben, invite)).toEqual({ kind: 'missing' });
  });

  it('says the relay is out of reach rather than that the link is bad', async () => {
    const fake = createFakeRelay();
    const ben = await device(fake, 'ben');
    fake.offline = true;
    expect(await lookupInvite(ben, newInvite())).toEqual({ kind: 'offline' });
  });

  it('reads only the mailbox, and sends no secret', async () => {
    const fake = createFakeRelay();
    const { invite } = await anaInvites(fake);
    const ben = await device(fake, 'ben');
    fake.requests.length = 0;

    await lookupInvite(ben, invite);

    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET /v1/mailbox/${invite.mailbox}?after=0&limit=100`,
    ]);
  });
});

describe('joinGroup', () => {
  async function folded(services: Services, groupId: string): Promise<string[]> {
    const group = await stored(services, groupId);
    return fold(group.log, group.relayNow).members.map((member) => member.name);
  }

  it('keeps the group with what the invite read, queues the join, and both devices agree', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const groupId = await created(ana);
    await ana.sync.syncOnce();
    const anaGroup = await stored(ana, groupId);
    const invite = { mailbox: anaGroup.mailbox, secret: anaGroup.secret };
    const ben = await device(fake, 'ben');
    const lookup = await lookupInvite(ben, invite);
    if (lookup.kind !== 'found') throw new Error('Expected to find the group.');

    const [follow] = LEVELS;
    expect(await joinGroup(ben, invite, lookup.group, 'Ben', follow)).toBe(groupId);

    const before = await stored(ben, groupId);
    expect(before.me.name).toBe('Ben');
    expect(before.signingKey).toHaveLength(32);
    expect(before.me.author).toBe(base64url(publicKeyOf(before.signingKey)));
    expect(before.me.author).not.toBe(anaGroup.me.author);
    expect(before.mailbox).toBe(invite.mailbox);
    expect(before.cursor).toBe(lookup.group.page.cursor);
    expect(fold(before.log, before.relayNow).title).toBe('House rules');
    expect(queued(before)?.event).toEqual({
      v: 1,
      type: 'join',
      group: groupId,
      author: before.me.author,
      ts: NOW,
      body: { name: 'Ben', level: follow },
    });

    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    expect(await folded(ben, groupId)).toEqual(['Ana', 'Ben']);
    expect(await folded(ana, groupId)).toEqual(['Ana', 'Ben']);
    const benState = fold((await stored(ana, groupId)).log, null);
    expect(benState.members.map((member) => member.level)).toEqual([FOUNDER_LEVEL, follow]);
  });

  it('never adds a second join for the same group', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const groupId = await created(ana);
    await ana.sync.syncOnce();
    const group = await stored(ana, groupId);
    const page = { records: [], cursor: 0, relayNow: 0, instance: 'i' };
    const found = { groupId, name: 'n', title: 't', page };
    const invite = { mailbox: group.mailbox, secret: group.secret };

    await expect(joinGroup(ana, invite, found, 'Ana again', FOUNDER_LEVEL)).rejects.toThrow();
    expect((await stored(ana, groupId)).outbox).toEqual([]);
  });
});
