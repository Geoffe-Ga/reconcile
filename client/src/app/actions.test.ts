import { afterEach, describe, expect, it } from 'vitest';

import { openDB } from 'idb';

import { deriveSealKey } from '../crypto/groupKeys';
import {
  deriveInviteKey,
  inviteChannelOf,
  newInviteSeed,
  verifyInviteToken,
} from '../crypto/invite';
import { kxPublicKeyOf } from '../crypto/box';
import { epochCommit } from '../crypto/epoch';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { xchachaSeal } from '../crypto/seal';
import { publicKeyOf } from '../crypto/sign';
import { DEFAULT_JOIN_LEVEL, FOUNDER_LEVEL, LEVELS } from '../engine/capabilities';
import {
  base64url,
  fromBase64url,
  type ParsedEvent,
  parseRecord,
  signEvent,
} from '../engine/event';
import { fold } from '../engine/fold';
import { DEFAULT_RULES } from '../engine/rules';
import { type Envelope, INVITE_TTL_DAYS, openEnvelope, sealEnvelope } from '../invite/envelope';
import { createRelay } from '../net/relay';
import { type Group, openStore, type Store } from '../store/db';
import { keyChangeOf } from '../store/epochs';
import { clearExpiredBallots } from '../store/expiry';
import { mailboxAt } from '../store/mailbox';
import { createSync, type Sync } from '../store/sync';
import { contains, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { forgedLog, keepLog } from '../test/forgedResult';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  createGroup,
  type CreateGroupValues,
  joinGroup,
  leaveGroup,
  lookupInvite,
  makeInvite,
  type Services,
} from './actions';
import { parseInviteLink } from './invite';
import { castBallot, propose } from './proposals';

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
  const sync = createSync({ store, relay, seal: xchachaSeal, clock: () => NOW });
  return { store, relay, sync, seal: xchachaSeal, now: () => NOW };
}

const ORIGIN = 'https://reconcile.test';

/** A secret's spellings a leak could take: base64url, standard base64 and hex. */
function spellings(secret: Uint8Array): string[] {
  const b64url = base64url(secret);
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const hex = Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [b64url, b64, hex, hex.toUpperCase()];
}

/** Writes `group` straight into device `name`'s IndexedDB, as an older sync might have left it. */
async function putGroup(name: string, group: Group): Promise<void> {
  const db = await openDB(name);
  await db.put('groups', group);
  db.close();
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
    ...(group.relayNow === null ? [] : [mailboxAt(group, group.relayNow)]),
    base64url(deriveSealKey(group.secret)),
    base64url(group.secret),
    base64url(group.signingKey),
    group.me.author,
    ...keys,
  ]);
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
    expect(group).not.toHaveProperty('mailbox');
    expect(group.secret).toHaveLength(32);
    expect(group.me.name).toBe('Ana');
    expect(group.signingKey).toHaveLength(32);
    expect(group.me.author).toBe(base64url(publicKeyOf(group.signingKey)));
    expect(group.me.author).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(group.outbox).toHaveLength(1);
    expect(group.kxKey).toHaveLength(32);
    const kx = base64url(kxPublicKeyOf(group.kxKey ?? new Uint8Array()));

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
        rules: DEFAULT_RULES,
        kx,
      },
    });
  });

  it('writes the founding rules into genesis, so the group folds with DEFAULT_RULES', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const group = await stored(ana, await created(ana));
    const record = group.outbox[0] ?? new Uint8Array();
    const state = fold([{ seq: 1, received: 29_000_000, bytes: record }], 29_000_000);
    expect(state.group).toBe(group.groupId);
    expect(state.rules).toEqual(DEFAULT_RULES);
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
    expect(fake.blobs(mailboxAt(group, fake.minute))).toHaveLength(1);
    expect(group.outbox).toEqual([]);
    expect(fold(group.log, group.relayNow).title).toBe('House rules');
  });

  it('refuses a Document too large for one record, before anything is stored or sent', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const result = await createGroup(ana, { ...VALUES, text: 'x'.repeat(66_000) });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(await ana.store.listGroups()).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('takes a genesis record of exactly 64,000 bytes, key and signature included, and refuses one more', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const base = { ...VALUES, chat: null, text: 'x' };
    const result = await createGroup(ana, base);
    if (result.outcome !== 'created') throw new Error('Expected a group.');
    const record = (await stored(ana, result.groupId)).outbox[0] ?? new Uint8Array();
    const room = MAX_RECORD_BYTES - record.length;
    const fits = await createGroup(ana, { ...base, text: 'x'.repeat(1 + room) });
    if (fits.outcome !== 'created') throw new Error('Expected a group.');
    expect((await stored(ana, fits.groupId)).outbox[0]).toHaveLength(64_000);
    expect(await createGroup(ana, { ...base, text: 'x'.repeat(1 + room + 1) })).toEqual({
      outcome: 'too-large',
    });
  });

  it('counts the bytes of a Document, not its characters', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    // 32,000 characters, each two bytes in UTF-8: far under 64,000 characters, over 64,000 bytes.
    const result = await createGroup(ana, { ...VALUES, text: 'é'.repeat(32_000) });
    expect(result).toEqual({ outcome: 'too-large' });
    expect(await ana.store.listGroups()).toEqual([]);
  });

  it('gives two groups with the same name and founder different secrets and unrelated mailboxes', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const one = await stored(ana, await created(ana));
    const two = await stored(ana, await created(ana));
    expect(one.groupId).not.toBe(two.groupId);
    expect(base64url(one.secret)).not.toBe(base64url(two.secret));
    expect(mailboxAt(one, 29_000_000)).not.toBe(mailboxAt(two, 29_000_000));
    expect(base64url(deriveSealKey(one.secret))).not.toBe(base64url(deriveSealKey(two.secret)));
  });

  it('seals what it sends: no blob holds the group’s words, names, keys or ids', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const group = await stored(ana, await created(ana));
    await ana.sync.syncOnce();

    const [put] = fake.requests.filter((request) => request.method === 'PUT');
    const blob = put?.body ?? new Uint8Array();
    // The genesis carries every founding rule, removal's bar and window (#115) among them,
    // which takes even this small group's genesis past the 1 KiB blob into the 4 KiB one.
    expect(blob).toHaveLength(4096);
    const readable = [
      ...['Riverside Tenants', 'Ana', 'House rules', 'Quiet hours start at ten.'].map(utf8),
      ...[group.groupId, group.me.author, base64url(group.secret)].map(utf8),
      group.secret,
      group.signingKey,
      publicKeyOf(group.signingKey),
    ];
    for (const bytes of readable) expect(contains(blob, bytes)).toBe(false);
  });

  it('makes different keys for every group', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    const one = await stored(ana, await created(ana));
    const two = await stored(ana, await created(ana, { ...VALUES, title: 'Other' }));
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
    await joinBy(ana, await linkTo(ben, theirs), 'Ana');
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

/** The link `services` makes for `groupId`, as Copy invite link does. */
function linkTo(services: Services, groupId: string): Promise<string> {
  return makeInvite(services, groupId, ORIGIN);
}

/** The seed in an invite link. */
function seedOf(link: string): Uint8Array {
  const seed = parseInviteLink(link);
  if (seed === null) throw new Error(`Expected an invite link, not ${link}.`);
  return seed;
}

/** Opens `link` on `services` and joins as `name`; returns the group id. */
async function joinBy(services: Services, link: string, name: string): Promise<string> {
  const lookup = await lookupInvite(services, seedOf(link));
  if (lookup.kind !== 'found') throw new Error(`Expected to find the group, not ${lookup.kind}.`);
  return joinGroup(services, lookup.group, name, DEFAULT_JOIN_LEVEL);
}

/** The envelope a link's seed opens, read straight from the fake relay. */
function envelopeAt(fake: FakeRelay, link: string): Envelope | null {
  const channel = inviteChannelOf(seedOf(link));
  return openEnvelope(xchachaSeal, channel, fake.blobs(channel.mailbox));
}

/** Ana's device, with a group she created and synced. */
async function anaWithGroup(fake: FakeRelay, values = VALUES) {
  const ana = await device(fake, 'ana');
  const groupId = await created(ana, values);
  await ana.sync.syncOnce();
  return { ana, groupId };
}

describe('makeInvite', () => {
  it('posts a header, then the relay-accepted log, to a new invite mailbox kept 1 day', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    fake.requests.length = 0;

    const link = await linkTo(ana, groupId);

    expect(link).toMatch(/^https?:\/\/[^#]+\/#join\/[A-Za-z0-9_-]{43}$/);
    const { mailbox } = inviteChannelOf(seedOf(link));
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT /v1/mailbox/${mailbox}?ttl_days=${String(INVITE_TTL_DAYS)}`,
      `PUT /v1/mailbox/${mailbox}?ttl_days=${String(INVITE_TTL_DAYS)}`,
    ]);
    expect(INVITE_TTL_DAYS).toBe(1);
    const group = await stored(ana, groupId);
    const envelope = envelopeAt(fake, link);
    expect(envelope).toEqual({
      groupSecret: Uint8Array.from(group.secret),
      epoch: 0,
      preview: {
        groupName: 'Riverside Tenants',
        inviterName: 'Ana',
        documentTitle: 'House rules',
        excerpt: 'Quiet hours start at ten.',
      },
      token: { by: group.me.author, sig: expect.any(String) as string },
      entries: group.log.map((record) => ({ ...record, bytes: Uint8Array.from(record.bytes) })),
      cleared: [],
    });
    const sig = fromBase64url(envelope?.token.sig ?? '');
    expect(verifyInviteToken(publicKeyOf(group.signingKey), sig, groupId)).toBe(true);
  });

  it('carries the log in seq order, never what still waits in the outbox', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    fake.offline = true;
    await ana.store.enqueue(groupId, utf8('not yet sent'));
    fake.offline = false;

    const envelope = envelopeAt(fake, await linkTo(ana, groupId));

    const group = await stored(ana, groupId);
    expect(envelope?.entries.map((entry) => entry.seq)).toEqual(group.log.map((r) => r.seq));
    expect(group.outbox).toHaveLength(1);
  });

  it('shows the first section as plain text, cut to 280 code points and “…”', async () => {
    const fake = createFakeRelay();
    const long = `**Quiet** ${'hours '.repeat(80)}`;
    const { ana, groupId } = await anaWithGroup(fake, { ...VALUES, text: `${long}\n\nBins.` });

    const excerpt = envelopeAt(fake, await linkTo(ana, groupId))?.preview.excerpt ?? '';

    expect(excerpt.startsWith('Quiet hours hours')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(Array.from(excerpt)).toHaveLength(281);
  });

  it('makes a new seed and mailbox each time', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const [one, two] = [await linkTo(ana, groupId), await linkTo(ana, groupId)];
    expect(one).not.toBe(two);
    expect(inviteChannelOf(seedOf(one)).mailbox).not.toBe(inviteChannelOf(seedOf(two)).mailbox);
  });

  it('rejects while the relay is out of reach, so there is no link to copy', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    fake.offline = true;
    await expect(linkTo(ana, groupId)).rejects.toThrow();
  });

  it('rejects when a PUT after the first fails, so a partial envelope never gets a link', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    let puts = 0;
    const relay = {
      ...ana.relay,
      putBlob: (...args: Parameters<typeof ana.relay.putBlob>) =>
        puts++ === 0 ? ana.relay.putBlob(...args) : Promise.reject(new Error('relay full')),
    };
    await expect(makeInvite({ ...ana, relay }, groupId, ORIGIN)).rejects.toThrow('relay full');
    expect(puts).toBe(2);
  });

  it('refuses a group the device isn’t in', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    await expect(linkTo(ana, 'nope')).rejects.toThrow('No such group');
  });

  it.each([
    ['dissolved (#108)', { reason: 'dissolved' }],
    ['back from a backup and unheard from since (#231)', { reason: 'unconfirmed', since: 1 }],
  ] as const)(
    'refuses a copy kept read-only, %s, posting nothing: its link would vouch for a live group',
    async (_why, archived) => {
      const fake = createFakeRelay();
      const { ana, groupId } = await anaWithGroup(fake);
      await putGroup('ana', { ...(await stored(ana, groupId)), archived });
      fake.requests.length = 0;

      await expect(linkTo(ana, groupId)).rejects.toThrow('This group is read-only on this device.');
      expect(fake.requests).toEqual([]);
    },
  );

  it('sends no group secret, seed or key in any spelling, in any path, query or body', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const link = await linkTo(ana, groupId);
    const ben = await device(fake, 'ben');
    await joinBy(ben, link, 'Ben');
    await ben.sync.syncOnce();

    const group = await stored(ana, groupId);
    const seed = seedOf(link);
    const leaks = [group.secret, seed, deriveInviteKey(seed), deriveSealKey(group.secret)];
    expect(fake.requests.length).toBeGreaterThan(4);
    for (const request of fake.requests) {
      const body = request.body ?? new Uint8Array();
      for (const secret of leaks) {
        expect(contains(body, secret)).toBe(false);
        for (const text of spellings(secret)) {
          expect(request.url).not.toContain(text);
          expect(contains(body, utf8(text))).toBe(false);
        }
      }
    }
  });
});

describe('lookupInvite', () => {
  it('opens the envelope: the group, its preview, secret and token, and every entry', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const link = await linkTo(ana, groupId);
    const ben = await device(fake, 'ben');
    fake.minute += 5;

    const lookup = await lookupInvite(ben, seedOf(link));

    const group = await stored(ana, groupId);
    expect(lookup).toEqual({
      kind: 'found',
      group: {
        groupId,
        preview: envelopeAt(fake, link)?.preview,
        secret: Uint8Array.from(group.secret),
        epoch: 0,
        token: envelopeAt(fake, link)?.token,
        cleared: [],
        page: {
          records: group.log.map((record) => ({ ...record, bytes: Uint8Array.from(record.bytes) })),
          // The highest seq among the entries: Ana's own base cursor is 0 (#110).
          cursor: Math.max(...group.log.map((record) => record.seq)),
          relayNow: fake.minute,
          instance: fake.instance,
        },
      },
    });
    expect(await ben.store.listGroups()).toEqual([]);
  });

  it('reads only the invite mailbox the seed derives', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const link = await linkTo(ana, groupId);
    const ben = await device(fake, 'ben');
    fake.requests.length = 0;

    await lookupInvite(ben, seedOf(link));

    const { mailbox } = inviteChannelOf(seedOf(link));
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET /v1/mailbox/${mailbox}?after=0&limit=100`,
    ]);
  });

  it('finds nothing once the relay has dropped the envelope, 2 UTC days on', async () => {
    const fake = createFakeRelay({ minute: 1440 * 20_000 + 60 });
    const { ana, groupId } = await anaWithGroup(fake);
    const link = await linkTo(ana, groupId);
    const ben = await device(fake, 'ben');

    fake.minute = 1440 * 20_001 + 1439;
    expect((await lookupInvite(ben, seedOf(link))).kind).toBe('found');
    fake.minute = 1440 * 20_002;
    expect(await lookupInvite(ben, seedOf(link))).toEqual({ kind: 'missing' });
  });

  it('finds nothing in an empty mailbox, a mailbox missing a chunk, or blobs that won’t open', async () => {
    const fake = createFakeRelay();
    const ben = await device(fake, 'ben');
    const seed = newInviteSeed();
    expect(await lookupInvite(ben, seed)).toEqual({ kind: 'missing' });

    const { ana, groupId } = await anaWithGroup(fake);
    const link = await linkTo(ana, groupId);
    const { mailbox } = inviteChannelOf(seedOf(link));
    const [header] = fake.blobs(mailbox);
    await ben.relay.putBlob(inviteChannelOf(seed).mailbox, Uint8Array.from(header ?? []));
    expect(await lookupInvite(ben, seed)).toEqual({ kind: 'missing' });

    fake.drop(mailbox, 1);
    expect(await lookupInvite(ben, seedOf(link))).toEqual({ kind: 'missing' });
    await ben.relay.putBlob(mailbox, new Uint8Array(1024).fill(7));
    expect(await lookupInvite(ben, seedOf(link))).toEqual({ kind: 'missing' });
  });

  it('finds nothing in an envelope whose entries hold no genesis', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const group = await stored(ana, groupId);
    const seed = newInviteSeed();
    const channel = inviteChannelOf(seed);
    const forged = sealEnvelope(xchachaSeal, channel, {
      groupSecret: group.secret,
      epoch: 0,
      preview: { groupName: 'g', inviterName: 'i', documentTitle: 't', excerpt: 'e' },
      token: { by: group.me.author, sig: 'A'.repeat(86) },
      entries: [{ seq: 1, received: 1, bytes: utf8('not a record') }],
      cleared: [],
    });
    for (const blob of forged) await ana.relay.putBlob(channel.mailbox, blob, 1);

    expect(await lookupInvite(await device(fake, 'ben'), seed)).toEqual({ kind: 'missing' });
  });

  it('says the relay is out of reach rather than that the link is bad', async () => {
    const fake = createFakeRelay();
    const ben = await device(fake, 'ben');
    fake.offline = true;
    expect(await lookupInvite(ben, newInviteSeed())).toEqual({ kind: 'offline' });
  });

  it('merges what a member’s device lacks, in seq order, with no new key or join', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const ben = await device(fake, 'ben');
    await joinBy(ben, await linkTo(ana, groupId), 'Ben');
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    const before = await stored(ben, groupId);
    // Ben's device loses the genesis, as if the relay had purged it before he read it.
    ben.store.close();
    const reopened = await device(fake, 'ben');
    const lost = { ...before, log: before.log.slice(1), missingHistory: true };
    await putGroup('ben', lost);

    const lookup = await lookupInvite(reopened, seedOf(await linkTo(ana, groupId)));

    expect(lookup).toEqual({ kind: 'joined', groupId });
    const after = await stored(reopened, groupId);
    expect(after.log.map((record) => record.seq)).toEqual(before.log.map((record) => record.seq));
    expect(after.missingHistory).toBe(false);
    expect(after.me).toEqual(before.me);
    expect(base64url(after.signingKey)).toBe(base64url(before.signingKey));
    expect(after.outbox).toEqual([]);
  });

  it('merges no forged result back into a log whose ballots the device cleared (#268)', async () => {
    const fake = createFakeRelay();
    const forged = forgedLog();
    const { group: groupId, proposal, genuine } = forged;
    const at = { relayNow: forged.closedAt + 43_200, lastSyncAt: NOW };
    const ana = await device(fake, 'ana');
    await keepLog(ana.store, forged, 'ana', at);
    expect(await clearExpiredBallots(ana.store, groupId)).toEqual([proposal]);
    // Ben's device hasn't cleared yet, so the log his invite carries still holds the forgery.
    const ben = await device(fake, 'ben');
    await keepLog(ben.store, forged, 'ben', at);
    const link = await linkTo(ben, groupId);
    const carried = envelopeAt(fake, link)?.entries.map((entry) => parseRecord(entry.bytes)?.id);
    expect(carried).toContain(forged.forged.id);

    expect(await lookupInvite(ana, seedOf(link))).toEqual({ kind: 'joined', groupId });

    const after = await stored(ana, groupId);
    const events = after.log.flatMap((record) => parseRecord(record.bytes) ?? []);
    expect(events.map(({ event }) => event.type)).not.toContain('vote');
    expect(events.filter(({ event }) => event.type === 'result').map(({ id }) => id)).toEqual([
      genuine.id,
    ]);
    const state = fold(after.log, after.relayNow, [], after.cleared);
    expect(state.proposals[0]?.result?.id).toBe(genuine.id);
    expect(state.proposals[0]?.outcome.kind).toBe('pass');
    // Merged in its place, the forgery would have been read ahead as the record instead.
    const merged = [...after.log, forged.forged.record].sort((a, b) => a.seq - b.seq);
    expect(fold(merged, after.relayNow, [], after.cleared).proposals[0]?.result?.id).toBe(
      forged.forged.id,
    );
  });
});

/**
 * Ana's group, which Ben joins; Ana proposes, both vote with Ana leaving a
 * note, a device posts the result a minute on, and 30 days on both devices
 * clear the ballots (#111).
 */
async function decidedAndCleared(fake: FakeRelay) {
  const { ana, groupId } = await anaWithGroup(fake);
  const ben = await device(fake, 'ben');
  await joinBy(ben, await linkTo(ana, groupId), 'Ben');
  for (const services of [ben, ana]) await services.sync.syncOnce();
  const atom = fold((await stored(ana, groupId)).log, null).atoms[0]?.id ?? '';
  const values = { title: 'Later quiet hours', why: 'Shift work.', link: null };
  const text = 'Quiet hours start at eleven.';
  const proposed = await propose(ana, groupId, { ...values, atom, text });
  if (proposed.outcome !== 'proposed') throw new Error('Expected the Proposal to queue.');
  const { proposalId } = proposed;
  for (const services of [ana, ben]) await services.sync.syncOnce();
  const scores = { [proposalId]: 4 as const };
  await castBallot(ana, groupId, { proposal: proposalId, scores, note: 'Not for travel.' });
  await castBallot(ben, groupId, { proposal: proposalId, scores, note: '' });
  for (const services of [ana, ben]) await services.sync.syncOnce();
  fake.minute += 1;
  for (const services of [ana, ben, ana]) await services.sync.syncOnce();
  fake.minute += 43_200;
  for (const services of [ana, ana]) await services.sync.syncOnce();
  return { ana, ben, groupId, proposalId };
}

describe('joinGroup', () => {
  async function folded(services: Services, groupId: string): Promise<string[]> {
    const group = await stored(services, groupId);
    return fold(group.log, group.relayNow).members.map((member) => member.name);
  }

  it('keeps the group with the invite’s secret and history, and queues a join with the token', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const anaGroup = await stored(ana, groupId);
    const link = await linkTo(ana, groupId);
    const ben = await device(fake, 'ben');
    const lookup = await lookupInvite(ben, seedOf(link));
    if (lookup.kind !== 'found') throw new Error('Expected to find the group.');

    const [follow] = LEVELS;
    expect(await joinGroup(ben, lookup.group, 'Ben', follow)).toBe(groupId);

    const before = await stored(ben, groupId);
    expect(before.me.name).toBe('Ben');
    expect(before.signingKey).toHaveLength(32);
    expect(before.me.author).toBe(base64url(publicKeyOf(before.signingKey)));
    expect(before.me.author).not.toBe(anaGroup.me.author);
    expect(base64url(before.secret)).toBe(base64url(anaGroup.secret));
    expect(before.cursor).toBe(lookup.group.page.cursor);
    expect(before.instance).toBe(fake.instance);
    expect(before.relayNow).toBe(fake.minute);
    expect(fold(before.log, before.relayNow).title).toBe('House rules');
    expect(before.kxKey).toHaveLength(32);
    expect(before.epoch ?? 0).toBe(0);
    const kx = base64url(kxPublicKeyOf(before.kxKey ?? new Uint8Array()));
    expect(queued(before)?.event).toEqual({
      v: 1,
      type: 'join',
      group: groupId,
      author: before.me.author,
      ts: NOW,
      body: { name: 'Ben', level: follow, token: lookup.group.token, kx },
    });

    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    expect(await folded(ben, groupId)).toEqual(['Ana', 'Ben']);
    expect(await folded(ana, groupId)).toEqual(['Ana', 'Ben']);
    const benState = fold((await stored(ana, groupId)).log, null);
    expect(benState.members.map((member) => member.level)).toEqual([FOUNDER_LEVEL, follow]);
    expect(benState.members.map((member) => member.invitedBy)).toEqual([null, anaGroup.me.author]);
  });

  it('gives a newcomer the whole history, even what the relay has purged', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const ben = await device(fake, 'ben');
    await joinBy(ben, await linkTo(ana, groupId), 'Ben');
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    const mailbox = mailboxAt(await stored(ana, groupId), fake.minute);
    fake.drop(mailbox, 2);
    expect(fake.blobs(mailbox)).toEqual([]);

    const cal = await device(fake, 'cal');
    await joinBy(cal, await linkTo(ben, groupId), 'Cal');
    for (const services of [cal, ana, ben]) await services.sync.syncOnce();

    for (const services of [ana, ben, cal]) {
      expect(await folded(services, groupId)).toEqual(['Ana', 'Ben', 'Cal']);
    }
    const state = fold((await stored(cal, groupId)).log, null);
    expect(state.title).toBe('House rules');
    expect(state.members.map((member) => member.invitedBy)).toEqual([
      null,
      (await stored(ana, groupId)).me.author,
      (await stored(ben, groupId)).me.author,
    ]);
  });

  it('carries the Proposals whose ballots the inviter cleared, so a newcomer folds the same Document from their results (#111)', async () => {
    const fake = createFakeRelay();
    const { ana, groupId, proposalId } = await decidedAndCleared(fake);
    const anaGroup = await stored(ana, groupId);
    expect(anaGroup.cleared).toEqual([proposalId]);

    const link = await linkTo(ana, groupId);
    expect(envelopeAt(fake, link)?.cleared).toEqual([proposalId]);
    const cal = await device(fake, 'cal');
    await joinBy(cal, link, 'Cal');

    const calGroup = await stored(cal, groupId);
    expect(calGroup.cleared).toEqual([proposalId]);
    const types = calGroup.log.map((record) => parseRecord(record.bytes)?.event.type);
    expect(types).not.toContain('vote');
    expect(types).toContain('result');
    const anaState = fold(anaGroup.log, anaGroup.relayNow, [], anaGroup.cleared);
    const calState = fold(calGroup.log, calGroup.relayNow, [], calGroup.cleared);
    expect(calState.atoms).toEqual(anaState.atoms);
    expect(calState.atoms[0]?.text).toBe('Quiet hours start at eleven.\n');
    // Without the header's cleared, the result alone, with no ballots, would read as nobody voting.
    expect(fold(calGroup.log, calGroup.relayNow).atoms).not.toEqual(anaState.atoms);
  });

  it('takes the week from the invite GET’s now: its first pass starts there and posts the join there (#110)', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const link = await linkTo(ana, groupId);
    const ben = await device(fake, 'ben');
    // Ana's genesis went to the last week; Ben opens the link in the next one.
    fake.minute += 200;
    const lookup = await lookupInvite(ben, seedOf(link));
    if (lookup.kind !== 'found') throw new Error('Expected to find the group.');
    const before = fake.requests.length;

    await joinGroup(ben, lookup.group, 'Ben', DEFAULT_JOIN_LEVEL);
    await ben.sync.syncOnce();

    const group = await stored(ben, groupId);
    const [lastWeek, thisWeek] = [mailboxAt(group, 29_000_000), mailboxAt(group, fake.minute)];
    expect(lastWeek).not.toBe(thisWeek);
    // The join's own pass, then the one this call gets after it (#260), with nothing to post.
    expect(
      fake.requests.slice(before).map((r) => `${r.method} ${r.url.split('?')[0] ?? ''}`),
    ).toEqual([
      `GET /v1/mailbox/${thisWeek}`,
      `PUT /v1/mailbox/${thisWeek}`,
      `GET /v1/mailbox/${lastWeek}`,
      `GET /v1/mailbox/${thisWeek}`,
      `GET /v1/mailbox/${thisWeek}`,
      `GET /v1/mailbox/${lastWeek}`,
    ]);
    await ana.sync.syncOnce();
    expect(await folded(ana, groupId)).toEqual(['Ana', 'Ben']);
  });

  it('never adds a second join for the same group', async () => {
    const fake = createFakeRelay();
    const { ana, groupId } = await anaWithGroup(fake);
    const ben = await device(fake, 'ben');
    const lookup = await lookupInvite(ben, seedOf(await linkTo(ana, groupId)));
    if (lookup.kind !== 'found') throw new Error('Expected to find the group.');

    await expect(joinGroup(ana, lookup.group, 'Ana again', FOUNDER_LEVEL)).rejects.toThrow();
    expect((await stored(ana, groupId)).outbox).toEqual([]);
  });
});

describe('leaveGroup', () => {
  it('queues a signed leave, marks the group leaving, and the group goes once the relay has it', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const created = await createGroup(ana, VALUES);
    if (created.outcome !== 'created') throw new Error('Expected a group.');
    await ana.sync.syncOnce();
    fake.offline = true;

    await leaveGroup(ana, created.groupId);

    const group = await stored(ana, created.groupId);
    const leave = queued(group);
    expect(leave?.event).toMatchObject({
      type: 'leave',
      group: created.groupId,
      author: group.me.author,
      ts: NOW,
      body: {},
    });
    expect(group.leaving).toEqual(group.outbox[0]);
    fake.offline = false;
    await ana.sync.syncOnce();
    expect(await ana.store.getGroup(created.groupId)).toBeUndefined();
  });

  it('refuses a group this device isn’t in', async () => {
    const ana = await device(createFakeRelay(), 'ana');
    await expect(leaveGroup(ana, 'no-such-group')).rejects.toThrow('No such group on this device.');
  });
});

describe('encryption keys and a new group key (#98)', () => {
  /** Ana's group, with Ben and Cal in it, every device synced. */
  async function threeInGroup(fake: FakeRelay) {
    const { ana, groupId } = await anaWithGroup(fake);
    const ben = await device(fake, 'ben');
    const cal = await device(fake, 'cal');
    const [, , create] = LEVELS;
    for (const [services, name] of [
      [ben, 'Ben'],
      [cal, 'Cal'],
    ] as const) {
      const lookup = await lookupInvite(services, seedOf(await linkTo(ana, groupId)));
      if (lookup.kind !== 'found') throw new Error('Expected to find the group.');
      await joinGroup(services, lookup.group, name, create);
      await services.sync.syncOnce();
    }
    for (const services of [ana, ben, cal]) await services.sync.syncOnce();
    return { ana, ben, cal, groupId };
  }

  /** Cal leaves, and Ana's device writes the new key. */
  async function calLeaves(
    ana: Services & { sync: Sync },
    cal: Services & { sync: Sync },
    groupId: string,
  ) {
    await leaveGroup(cal, groupId);
    await cal.sync.syncOnce();
    await ana.sync.syncOnce();
    expect((await stored(ana, groupId)).epoch).toBe(1);
  }

  it('makes each group its own encryption key, unrelated to its signing key or any other group’s', async () => {
    const fake = createFakeRelay();
    const ana = await device(fake, 'ana');
    const [one, two] = [await created(ana), await created(ana)];
    const [first, second] = [await stored(ana, one), await stored(ana, two)];
    const keys = [first.kxKey, second.kxKey, first.signingKey, second.signingKey].map((key) =>
      base64url(key ?? new Uint8Array()),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it('carries the group’s current secret and epoch in an invite, and each entry’s epoch', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cal, groupId } = await threeInGroup(fake);
    await calLeaves(ana, cal, groupId);
    await ben.sync.syncOnce();
    // Ben steps up a level, so the log holds a record read from epoch 1's mailbox too.
    const [follow] = LEVELS;
    const benGroup = await stored(ben, groupId);
    const step = signEvent(benGroup.signingKey, {
      type: 'level',
      group: groupId,
      ts: NOW,
      body: { level: follow },
    });
    await ben.store.enqueue(groupId, step.record);
    await ben.sync.syncOnce();
    await ana.sync.syncOnce();
    const held = await stored(ana, groupId);

    const envelope = envelopeAt(fake, await linkTo(ana, groupId));

    expect(envelope?.epoch).toBe(1);
    expect(base64url(envelope?.groupSecret ?? new Uint8Array())).toBe(base64url(held.secret));
    expect(envelope?.entries.map((entry) => entry.epoch ?? 0)).toEqual(
      held.log.map((record) => record.epoch ?? 0),
    );
    expect(envelope?.entries.some((entry) => entry.epoch === 1)).toBe(true);
  });

  it('lets a newcomer join at the invite’s epoch, on the new mailbox, and fold what everyone folds', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cal, groupId } = await threeInGroup(fake);
    await calLeaves(ana, cal, groupId);
    const dee = await device(fake, 'dee');
    await joinBy(dee, await linkTo(ana, groupId), 'Dee');
    for (const services of [dee, ana, ben, dee]) await services.sync.syncOnce();

    const kept = await stored(dee, groupId);
    expect(kept.epoch).toBe(1);
    const state = fold(kept.log, kept.relayNow);
    expect(state.members.map((member) => member.name)).toEqual(['Ana', 'Ben', 'Dee']);
    expect(keyChangeOf(kept, state)).toBeNull();
    const anaState = fold((await stored(ana, groupId)).log, null);
    expect(anaState.members.map((member) => member.name)).toEqual(['Ana', 'Ben', 'Dee']);
  });

  it('leaves someone who joins from a link made before the key changed outside, and says why', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cal, groupId } = await threeInGroup(fake);
    const stale = await linkTo(cal, groupId);
    await calLeaves(ana, cal, groupId);
    await ben.sync.syncOnce();

    const dee = await device(fake, 'dee');
    await joinBy(dee, stale, 'Dee');
    await dee.sync.syncOnce();
    await ana.sync.syncOnce();

    const kept = await stored(dee, groupId);
    expect(keyChangeOf(kept, fold(kept.log, kept.relayNow))).toBe('missed');
    const anaState = fold((await stored(ana, groupId)).log, null);
    expect(anaState.members.map((member) => member.name)).toEqual(['Ana', 'Ben']);
  });

  it('brings a device that missed the new key the current one from a newer invite, checked against its commit', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cal, groupId } = await threeInGroup(fake);
    const stale = await linkTo(cal, groupId);
    await calLeaves(ana, cal, groupId);
    await ben.sync.syncOnce();
    const dee = await device(fake, 'dee');
    await joinBy(dee, stale, 'Dee');
    await dee.sync.syncOnce();

    expect(await lookupInvite(dee, seedOf(await linkTo(ben, groupId)))).toEqual({
      kind: 'joined',
      groupId,
    });

    const [kept, current] = [await stored(dee, groupId), await stored(ana, groupId)];
    expect(kept.epoch).toBe(1);
    expect(base64url(kept.secret)).toBe(base64url(current.secret));
    expect(keyChangeOf(kept, fold(kept.log, kept.relayNow))).toBeNull();
    // Dee's join waited out the freeze; now it goes to the new mailbox, and everyone sees Dee.
    for (const services of [dee, ana, ben]) await services.sync.syncOnce();
    const anaState = fold((await stored(ana, groupId)).log, null);
    expect(anaState.members.map((member) => member.name)).toEqual(['Ana', 'Ben', 'Dee']);
  });

  it('refuses an invite whose secret isn’t the one its epoch’s key change commits to', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cal, groupId } = await threeInGroup(fake);
    await calLeaves(ana, cal, groupId);
    await ben.sync.syncOnce();
    const held = await stored(ana, groupId);
    const state = fold(held.log, held.relayNow);
    expect(epochCommit(groupId, 1, held.secret)).toBe(state.rotations[0]?.commit);
    const seed = newInviteSeed();
    const channel = inviteChannelOf(seed);
    const forged = sealEnvelope(xchachaSeal, channel, {
      groupSecret: new Uint8Array(32).fill(1),
      epoch: 1,
      preview: { groupName: 'G', inviterName: 'Ana', documentTitle: 'T', excerpt: '' },
      token: { by: held.me.author, sig: 'A'.repeat(86) },
      entries: held.log,
      cleared: [],
    });
    for (const blob of forged) await ana.relay.putBlob(channel.mailbox, blob, INVITE_TTL_DAYS);

    const newcomer = await device(fake, 'dee');
    expect(await lookupInvite(newcomer, seed)).toEqual({ kind: 'missing' });

    // A member's device takes it as damaged too, and keeps its own key.
    const before = await stored(ben, groupId);
    expect(await lookupInvite(ben, seed)).toEqual({ kind: 'missing' });
    expect(base64url((await stored(ben, groupId)).secret)).toBe(base64url(before.secret));
  });
});
