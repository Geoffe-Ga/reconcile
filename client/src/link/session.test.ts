/**
 * Linking a second device over the relay (#96), both sides against
 * `fakeRelay`: the handshake's order, the commitment, confirming on the
 * existing device only, the bundle, expiry, and what the relay holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import {
  type LinkChannel,
  type LinkCode,
  type LinkKeys,
  linkCode,
  linkSecrets,
  linkTranscript,
  newLinkKeys,
  pairingChannelOf,
  parseLinkCode,
  sharedSecret,
} from '../crypto/link';
import { xchachaSeal } from '../crypto/seal';
import { fold } from '../engine/fold';
import { createRelay, type Relay } from '../net/relay';
import { type Group, openStore, type Store, VaultLocked } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { local, utf8 } from '../test/bytes';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { testGroup } from '../test/groups';
import { freshIndexedDBPerTest } from '../test/idb';
import { testKeys } from '../test/keys';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { scanDb } from '../test/scanDb';
import {
  EXISTING_DEVICE,
  joinLink,
  LINK_LIFETIME_MS,
  LINK_TTL_DAYS,
  type LinkOffer,
  type LinkServices,
  NEW_DEVICE,
  offerLink,
} from './session';
import { sealBundle } from './bundle';

freshIndexedDBPerTest();

const CANARY = {
  group: 'Canary Linked Commons',
  founder: 'Canaryana Linker',
  atom: 'Canary atom: the bundle never shows this.',
};

/** The device clock, which a test moves on. */
let clock = 1_762_650_000_000;

beforeEach(() => {
  clock = 1_762_650_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** One device's link services on `fake`, with its own store. */
async function device(fake: FakeRelay, name: string): Promise<LinkServices & { store: Store }> {
  const store = await openStore(name);
  return { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal, store, now: () => clock };
}

/** Keeps the canary group, synced, on `store`, as the founder's device holds it. */
async function keepCanary(store: Store) {
  const made = testGroup({ name: CANARY.group, founder: CANARY.founder, atoms: [CANARY.atom] });
  const groupId = made.state.group ?? '';
  const { secretKey, author } = testKeys(CANARY.founder.toLowerCase());
  const secret = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);
  await store.addGroup({ groupId, secret, signingKey: secretKey, me: { author, name: 'Ana' } });
  const last = made.records.at(-1);
  await store.applyPull(
    groupId,
    {
      records: [...made.records],
      cursor: last?.seq ?? 0,
      relayNow: (last?.received ?? 0) + 1,
      instance: 'relay-1',
      lastSyncAt: 1_762_000_000_000,
    },
    eventIdOf,
  );
  return { groupId, secret, secretKey };
}

/** The one group `store` holds. */
async function onlyGroup(store: Store): Promise<Group> {
  const [group, ...others] = await store.listGroups();
  if (group === undefined || others.length > 0) throw new Error('Expected exactly one group.');
  return group;
}

/** The code A shows, as B reads it. */
function codeOf(offer: LinkOffer): LinkCode {
  const code = parseLinkCode(offer.code);
  if (code === null) throw new Error('Expected a link code.');
  return code;
}

/** The PUTs the fake relay took, as their mailbox ids and query strings. */
function puts(fake: FakeRelay): { mailbox: string; query: string }[] {
  return fake.requests
    .filter((request) => request.method === 'PUT')
    .map((request) => {
      const url = new URL(request.url, 'http://relay.test');
      return { mailbox: url.pathname.split('/').at(-1) ?? '', query: url.search };
    });
}

/** The bundle mailbox and K for a link whose one-time keys a test chose. */
function bundleOf(code: LinkCode, a: LinkKeys, b: LinkKeys): LinkChannel {
  const transcript = linkTranscript(code.seed, a.publicKey, b.publicKey);
  return linkSecrets(sharedSecret(a.secretKey, b.publicKey), transcript).bundle;
}

/** Posts `key` to the pairing mailbox under `tag`, sealed as a link device does, from outside. */
async function postKey(relay: Relay, seed: Uint8Array, tag: number, key: Uint8Array) {
  const channel = pairingChannelOf(seed);
  const plaintext = Uint8Array.from([tag, ...key]);
  await relay.putBlob(
    channel.mailbox,
    xchachaSeal.seal(channel.mailbox, channel.key, plaintext),
    1,
  );
}

describe('linking, end to end over the relay', () => {
  it('gives the new device every group, the same keys and log, after one Match on the existing device', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const kept = await keepCanary(a.store);

    const offer = offerLink(a);
    expect(await offer.poll()).toEqual({ kind: 'waiting' });
    const join = await joinLink(b, codeOf(offer));
    expect(await join.poll()).toEqual({ kind: 'waiting' });

    const onA = await offer.poll();
    const onB = await join.poll();
    expect(onA.kind).toBe('compare');
    expect(onB).toEqual(onA);
    expect(onA.kind === 'compare' ? onA.number : '').toMatch(/^[0-9]{6}$/);
    // B waits for the bundle, which only A's Match sends.
    expect(await join.poll()).toEqual(onA);

    expect(await offer.confirm()).toBe('sent');
    expect(await join.poll()).toEqual({ kind: 'linked', groups: 1 });

    const held = await onlyGroup(b.store);
    expect(held.groupId).toBe(kept.groupId);
    expect(local(held.signingKey)).toEqual(local(kept.secretKey));
    expect(local(held.secret)).toEqual(local(kept.secret));
    expect(held.backup).toBeUndefined();
    const original = await onlyGroup(a.store);
    expect(fold(held.log, held.relayNow)).toEqual(fold(original.log, original.relayNow));
  });

  it('counts every group the new device now has, its own included', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    await keepCanary(a.store);
    await b.store.addGroup({
      groupId: 'already-on-the-laptop',
      secret: new Uint8Array(32).fill(1),
      signingKey: new Uint8Array(32).fill(2),
      me: { author: 'author-zed', name: 'Zed' },
    });

    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    await join.poll();
    await offer.confirm();

    expect(await join.poll()).toEqual({ kind: 'linked', groups: 2 });
  });

  it('puts every blob in this flow with ttl_days=1, in throwaway mailboxes', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const kept = await keepCanary(a.store);

    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    await join.poll();
    await offer.confirm();
    await join.poll();

    expect(LINK_TTL_DAYS).toBe(1);
    const sent = puts(fake);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.every(({ query }) => query === '?ttl_days=1')).toBe(true);
    const pairing = pairingChannelOf(codeOf(offer).seed).mailbox;
    expect(sent.slice(0, 2).map(({ mailbox }) => mailbox)).toEqual([pairing, pairing]);
    const groupMailboxes = new Set(fake.requests.map((request) => request.url));
    expect([...groupMailboxes].some((url) => url.includes(kept.groupId))).toBe(false);
  });

  it('leaves the relay nothing readable: no seed, K, one-time key, group secret, signing key or words', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const kept = await keepCanary(a.store);
    const keysA = newLinkKeys();
    const keysB = newLinkKeys();
    const offer = offerLink(a, keysA);
    const code = codeOf(offer);
    const join = await joinLink(b, code, keysB);
    const { key } = bundleOf(code, keysA, keysB);
    const pairingKey = local(pairingChannelOf(code.seed).key);
    const publicA = local(keysA.publicKey);
    const publicB = local(keysB.publicKey);
    const secretA = local(keysA.secretKey);
    const secretB = local(keysB.secretKey);
    const seed = local(code.seed);
    const kHeld = local(key);
    await offer.poll();
    await join.poll();
    await offer.confirm();
    expect(await join.poll()).toEqual({ kind: 'linked', groups: 1 });

    const canaries = [
      ...keyCanaries('seed', seed),
      ...keyCanaries('K', kHeld),
      ...keyCanaries('e_A', secretA),
      ...keyCanaries('e_B', secretB),
      ...keyCanaries('E_A', publicA),
      ...keyCanaries('E_B', publicB),
      ...keyCanaries('pairing seal key', pairingKey),
      ...keyCanaries('group secret', kept.secret),
      ...keyCanaries('signing key', kept.secretKey),
      textCanary('group name', CANARY.group),
      textCanary('Atom text', CANARY.atom),
    ];
    const seen = fake.requests.flatMap((request) => [
      utf8(request.url),
      request.body ?? new Uint8Array(),
    ]);
    expect(seen.flatMap((bytes) => findCanaries(bytes, canaries))).toEqual([]);
    // The scan finds what it looks for: the pairing mailbox id is in every handshake URL.
    const pairing = textCanary('pairing mailbox', pairingChannelOf(seed).mailbox);
    expect(seen.flatMap((bytes) => findCanaries(bytes, [pairing]))).not.toEqual([]);
  });

  it('wipes the seed, K and one-time keys once the bundle is in', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    await keepCanary(a.store);
    const keysA = newLinkKeys();
    const keysB = newLinkKeys();
    const offer = offerLink(a, keysA);
    const code = codeOf(offer);
    const join = await joinLink(b, code, keysB);
    await offer.poll();
    await join.poll();

    await offer.confirm();
    await join.poll();

    expect(keysA.secretKey.every((byte) => byte === 0)).toBe(true);
    expect(keysB.secretKey.every((byte) => byte === 0)).toBe(true);
  });
});

describe('linking a device whose keys are locked with a passkey (#95)', () => {
  const LOCK = { credentialId: Uint8Array.of(4, 2), prfSalt: new Uint8Array(32).fill(6) };
  const VAULT_KEY = new Uint8Array(32).fill(8);
  const BACKUP_KEY = new Uint8Array(32).fill(0xb3);

  /**
   * Device `name`'s link services, its keys locked with a passkey; unlocked
   * in this session only if `unlocked`.
   */
  async function sealedDevice(fake: FakeRelay, name: string, unlocked: boolean) {
    const sealing = await openStore(name);
    await sealing.sealKeys(LOCK, VAULT_KEY);
    if (unlocked) {
      return {
        relay: createRelay({ fetch: fake.fetch }),
        seal: xchachaSeal,
        store: sealing,
        now: () => clock,
      };
    }
    sealing.close();
    return device(fake, name);
  }

  /** Everything IndexedDB database `name` holds, raw: text and bytes joined, for a canary scan. */
  async function rawBytes(name: string): Promise<Uint8Array> {
    const { text, bytes } = await scanDb(name);
    return Uint8Array.from([...utf8(text), ...bytes.flatMap((held) => [0, ...held])]);
  }

  it('seals everything that arrives on a new device with a vault: keys, secret and relay backup key', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await sealedDevice(fake, 'laptop', true);
    const kept = await keepCanary(a.store);
    await a.store.setRelayBackupKey(BACKUP_KEY);

    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    await join.poll();
    expect(await offer.confirm()).toBe('sent');
    expect(await join.poll()).toEqual({ kind: 'linked', groups: 1 });

    const canaries = [
      ...keyCanaries('group secret', kept.secret),
      ...keyCanaries('signing key', kept.secretKey),
      ...keyCanaries('backup key', BACKUP_KEY),
    ];
    expect(findCanaries(await rawBytes('laptop'), canaries)).toEqual([]);
    const held = await onlyGroup(b.store);
    expect(local(held.signingKey)).toEqual(local(kept.secretKey));
    expect(local((await b.store.getRelayBackup())?.key ?? new Uint8Array())).toEqual(
      local(BACKUP_KEY),
    );
  });

  it('sends nothing on Match from an existing device whose keys this session hasn’t unlocked', async () => {
    const fake = createFakeRelay();
    const sealing = await openStore('phone');
    await sealing.setRelayBackupKey(BACKUP_KEY);
    sealing.close();
    const a = await sealedDevice(fake, 'phone', false);
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    await join.poll();
    const before = puts(fake).length;

    await expect(offer.confirm()).rejects.toThrow(VaultLocked);

    expect(puts(fake)).toHaveLength(before);
    expect(await offer.poll()).toEqual({ kind: 'closed' });
    expect(await join.poll()).toEqual({ kind: 'compare', number: expect.any(String) as string });
  });

  it('checks this session holds the unlocked keys before it reads anything to send, as Save a backup does', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    await keepCanary(a.store);
    const listGroups = vi.spyOn(a.store, 'listGroups');
    const store = { ...a.store, requireUnlocked: () => Promise.reject(new VaultLocked()) };
    const b = await device(fake, 'laptop');
    const offer = offerLink({ ...a, store });
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    await join.poll();
    const before = puts(fake).length;

    await expect(offer.confirm()).rejects.toThrow(VaultLocked);

    expect(listGroups).not.toHaveBeenCalled();
    expect(puts(fake)).toHaveLength(before);
    expect(await offer.poll()).toEqual({ kind: 'closed' });
  });

  it('refuses the bundle on a new device whose keys this session hasn’t unlocked, keeping nothing', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    await keepCanary(a.store);
    const b = await sealedDevice(fake, 'laptop', false);
    const before = await rawBytes('laptop');
    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    await join.poll();
    await offer.confirm();

    await expect(join.poll()).rejects.toThrow(VaultLocked);

    expect(local(await rawBytes('laptop'))).toEqual(local(before));
  });
});

describe('the existing device (A)', () => {
  it('never posts E_A before it has taken an E_B', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const offer = offerLink(a);
    const { seed } = codeOf(offer);

    for (let i = 0; i < 3; i += 1) expect(await offer.poll()).toEqual({ kind: 'waiting' });
    // Neither junk nor a key posted as if from an existing device counts as the new device's.
    await postKey(a.relay, seed, EXISTING_DEVICE, newLinkKeys().publicKey);
    await a.relay.putBlob(
      pairingChannelOf(seed).mailbox,
      xchachaSeal.seal(pairingChannelOf(seed).mailbox, new Uint8Array(32), utf8('junk')),
      1,
    );
    expect(await offer.poll()).toEqual({ kind: 'waiting' });

    expect(puts(fake)).toHaveLength(2);
    expect(fake.blobs(pairingChannelOf(seed).mailbox)).toHaveLength(2);
  });

  it('skips a new device key it can’t use: the wrong length, or a low-order point', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    const { seed } = codeOf(offer);
    await postKey(a.relay, seed, NEW_DEVICE, new Uint8Array(32));
    await postKey(a.relay, seed, NEW_DEVICE, new Uint8Array(31).fill(9));

    expect(await offer.poll()).toEqual({ kind: 'waiting' });
    const join = await joinLink(b, codeOf(offer));
    const onA = await offer.poll();

    expect(onA.kind).toBe('compare');
    expect(await join.poll()).toEqual(onA);
  });

  it('takes the first E_B in relay order: a second one doesn’t change its number', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const first = await device(fake, 'laptop');
    const second = await device(fake, 'someone-else');
    const offer = offerLink(a);

    const joinFirst = await joinLink(first, codeOf(offer));
    const joinSecond = await joinLink(second, codeOf(offer));
    const onA = await offer.poll();
    const onFirst = await joinFirst.poll();
    const onSecond = await joinSecond.poll();

    expect(onFirst).toEqual(onA);
    expect(onSecond.kind).toBe('compare');
    expect(onSecond).not.toEqual(onA);
    // A later key changes nothing, and A posts E_A only once.
    await joinLink(await device(fake, 'third'), codeOf(offer));
    expect(await offer.poll()).toEqual(onA);
    const pairing = pairingChannelOf(codeOf(offer).seed).mailbox;
    expect(puts(fake).filter(({ mailbox }) => mailbox === pairing)).toHaveLength(4);
  });

  it('retries posting E_A for the key it took, never another, when the relay can’t be reached', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    const realPut = a.relay.putBlob.bind(a.relay);
    const put = vi
      .spyOn(a.relay, 'putBlob')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(offer.poll()).rejects.toThrow('Failed to fetch');
    await joinLink(await device(fake, 'late'), codeOf(offer));
    put.mockImplementation(realPut);
    const onA = await offer.poll();

    expect(await join.poll()).toEqual(onA);
  });

  it('sends nothing under K after Don’t match, and closes', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    await keepCanary(a.store);
    const keysA = newLinkKeys();
    const keysB = newLinkKeys();
    const offer = offerLink(a, keysA);
    const code = codeOf(offer);
    const join = await joinLink(b, code, keysB);
    const bundle = bundleOf(code, keysA, keysB).mailbox;
    await offer.poll();
    const onB = await join.poll();
    const before = fake.requests.length;

    offer.drop();

    expect(await offer.poll()).toEqual({ kind: 'closed' });
    await expect(offer.confirm()).rejects.toThrow('This link is closed.');
    expect(fake.requests.slice(before).filter((request) => request.method === 'PUT')).toEqual([]);
    expect(fake.blobs(bundle)).toEqual([]);
    // B keeps waiting for a bundle that never comes, until the person cancels it.
    expect(await join.poll()).toEqual(onB);
    expect(onB.kind).toBe('compare');
  });

  it('shares one look between two polls at once, so it posts E_A once', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const offer = offerLink(a);
    await joinLink(await device(fake, 'laptop'), codeOf(offer));
    const before = fake.requests.length;

    const [one, two] = await Promise.all([offer.poll(), offer.poll()]);

    expect(two).toEqual(one);
    expect(fake.requests.slice(before).map((request) => request.method)).toEqual(['GET', 'PUT']);
    const third = await offer.poll();
    expect(third).toEqual(one);
  });

  it('can’t confirm before it has shown a number', async () => {
    const fake = createFakeRelay();
    const offer = offerLink(await device(fake, 'phone'));
    await expect(offer.confirm()).rejects.toThrow('There is no number to confirm yet.');
  });

  it('drops the code after 10 minutes, and sends nothing after', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    expect(offer.expiresAt).toBe(clock + LINK_LIFETIME_MS);
    expect(LINK_LIFETIME_MS).toBe(600_000);

    clock += LINK_LIFETIME_MS - 1;
    expect(await offer.poll()).toEqual({ kind: 'waiting' });
    await joinLink(b, codeOf(offer));
    expect((await offer.poll()).kind).toBe('compare');
    clock += 1;
    const before = fake.requests.length;

    expect(await offer.poll()).toEqual({ kind: 'expired' });
    expect(await offer.confirm()).toBe('expired');
    expect(fake.requests.length).toBe(before);
  });

  it('drops everything once the bundle is sent', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const offer = offerLink(a);
    await joinLink(await device(fake, 'laptop'), codeOf(offer));
    await offer.poll();

    expect(await offer.confirm()).toBe('sent');

    expect(await offer.poll()).toEqual({ kind: 'closed' });
    await expect(offer.confirm()).rejects.toThrow('This link is closed.');
  });

  it('closes, sending nothing more, when a bundle PUT fails', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    await keepCanary(a.store);
    const offer = offerLink(a);
    await joinLink(await device(fake, 'laptop'), codeOf(offer));
    await offer.poll();
    vi.spyOn(a.relay, 'putBlob').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(offer.confirm()).rejects.toThrow('Failed to fetch');

    expect(await offer.poll()).toEqual({ kind: 'closed' });
  });

  it('sends nothing when it closes while the snapshot is taken', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const offer = offerLink(a);
    await joinLink(await device(fake, 'laptop'), codeOf(offer));
    await offer.poll();
    const listGroups = a.store.listGroups.bind(a.store);
    vi.spyOn(a.store, 'listGroups').mockImplementation(async () => {
      offer.drop();
      return listGroups();
    });
    const before = fake.requests.length;

    await expect(offer.confirm()).rejects.toThrow('This link is closed.');
    expect(fake.requests.length).toBe(before);
  });

  it('posts nothing when it closes while a look at the relay is on its way', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const offer = offerLink(a);
    await joinLink(await device(fake, 'laptop'), codeOf(offer));
    const getBlobs = a.relay.getBlobs.bind(a.relay);
    vi.spyOn(a.relay, 'getBlobs').mockImplementation(async (mailbox, after) => {
      const page = await getBlobs(mailbox, after);
      offer.drop();
      return page;
    });
    const before = puts(fake).length;

    expect(await offer.poll()).toEqual({ kind: 'closed' });
    expect(puts(fake)).toHaveLength(before);
  });
});

describe('the new device (B)', () => {
  it('stops when the E_A posted doesn’t match the code’s commitment', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    const code = codeOf(offer);
    const join = await joinLink(b, code);
    // Someone who saw the code posts their own key as if they were A, before A does.
    await postKey(a.relay, code.seed, EXISTING_DEVICE, newLinkKeys().publicKey);
    await offer.poll();

    expect(await join.poll()).toEqual({ kind: 'mismatch' });
    expect(await join.poll()).toEqual({ kind: 'mismatch' });
  });

  it('ignores the new devices’ keys and blobs that don’t open while it waits for E_A', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    const code = codeOf(offer);
    const join = await joinLink(b, code);
    await postKey(a.relay, code.seed, NEW_DEVICE, newLinkKeys().publicKey);
    const channel = pairingChannelOf(code.seed);
    await a.relay.putBlob(
      channel.mailbox,
      xchachaSeal.seal(channel.mailbox, channel.key, utf8('no')),
      1,
    );

    expect(await join.poll()).toEqual({ kind: 'waiting' });
    const onA = await offer.poll();
    expect(await join.poll()).toEqual(onA);
  });

  it('has nothing to confirm: only the existing device can send the bundle', async () => {
    const fake = createFakeRelay();
    const join = await joinLink(
      await device(fake, 'laptop'),
      codeOf(offerLink(await device(fake, 'phone'))),
    );
    expect(Object.keys(join).sort()).toEqual(['drop', 'poll']);
  });

  it.each([
    [
      'groups that don’t check out',
      (bundle: LinkChannel) => sealBundle(xchachaSeal, bundle, utf8('{"format":1,"groups":[{}]}')),
    ],
    [
      'a header that doesn’t parse',
      (bundle: LinkChannel) => [xchachaSeal.seal(bundle.mailbox, bundle.key, utf8('{"chunks":0}'))],
    ],
  ])('finds a bundle with %s damaged, and keeps nothing', async (_name, blobsFor) => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const keysA = newLinkKeys();
    const keysB = newLinkKeys();
    const offer = offerLink(a, keysA);
    const code = codeOf(offer);
    const join = await joinLink(b, code, keysB);
    await offer.poll();
    await join.poll();
    const bundle = bundleOf(code, keysA, keysB);
    for (const blob of blobsFor(bundle)) await a.relay.putBlob(bundle.mailbox, blob, 1);

    expect(await join.poll()).toEqual({ kind: 'damaged' });
    expect(await join.poll()).toEqual({ kind: 'damaged' });
    expect(await b.store.listGroups()).toEqual([]);
  });

  it('shares one look between two polls at once', async () => {
    const fake = createFakeRelay();
    const join = await joinLink(
      await device(fake, 'laptop'),
      codeOf(offerLink(await device(fake, 'phone'))),
    );
    const before = fake.requests.length;

    await Promise.all([join.poll(), join.poll()]);

    expect(fake.requests.length - before).toBe(1);
  });

  it('gives up 10 minutes after posting its key, even once it shows a number', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const offer = offerLink(a);
    const join = await joinLink(await device(fake, 'laptop'), codeOf(offer));
    await offer.poll();
    expect((await join.poll()).kind).toBe('compare');
    clock += LINK_LIFETIME_MS;

    expect(await join.poll()).toEqual({ kind: 'expired' });
  });

  it('gives up 10 minutes after posting its key', async () => {
    const fake = createFakeRelay();
    const join = await joinLink(
      await device(fake, 'laptop'),
      codeOf(offerLink(await device(fake, 'phone'))),
    );
    clock += LINK_LIFETIME_MS - 1;
    expect(await join.poll()).toEqual({ kind: 'waiting' });
    clock += 1;
    const before = fake.requests.length;

    expect(await join.poll()).toEqual({ kind: 'expired' });
    expect(fake.requests.length).toBe(before);
  });

  it('closes when dropped, and reads nothing more', async () => {
    const fake = createFakeRelay();
    const join = await joinLink(
      await device(fake, 'laptop'),
      codeOf(offerLink(await device(fake, 'phone'))),
    );
    const before = fake.requests.length;

    join.drop();

    expect(await join.poll()).toEqual({ kind: 'closed' });
    expect(fake.requests.length).toBe(before);
  });

  it('keeps nothing and makes no number when it closes while a look is on its way', async () => {
    const fake = createFakeRelay();
    const a = await device(fake, 'phone');
    const b = await device(fake, 'laptop');
    const offer = offerLink(a);
    const join = await joinLink(b, codeOf(offer));
    await offer.poll();
    const getBlobs = b.relay.getBlobs.bind(b.relay);
    vi.spyOn(b.relay, 'getBlobs').mockImplementation(async (mailbox, after) => {
      const page = await getBlobs(mailbox, after);
      join.drop();
      return page;
    });

    expect(await join.poll()).toEqual({ kind: 'closed' });
  });

  it('posts nothing it can be held to and keeps no key when its first PUT fails', async () => {
    const fake = createFakeRelay();
    const offer = offerLink(await device(fake, 'phone'));
    const b = await device(fake, 'laptop');
    fake.offline = true;

    await expect(joinLink(b, codeOf(offer))).rejects.toThrow('Failed to fetch');

    fake.offline = false;
    expect(await offer.poll()).toEqual({ kind: 'waiting' });
  });
});

describe('the code', () => {
  it('is RL1. and the seed with the commitment to E_A', () => {
    const keys = newLinkKeys();
    const offer = offerLink(
      {
        relay: createRelay({ fetch: createFakeRelay().fetch }),
        seal: xchachaSeal,
        store: {
          listGroups: () => Promise.resolve([]),
          listPersonal: () => Promise.resolve([]),
          getRelayBackup: () => Promise.resolve(undefined),
          requireUnlocked: () => Promise.resolve(),
          restoreGroups: () => Promise.resolve(),
          adoptRelayBackupKey: () => Promise.resolve(false),
        },
        now: () => clock,
      },
      keys,
    );
    const { seed } = codeOf(offer);
    expect(offer.code).toBe(linkCode(seed, keys.publicKey));
    expect(base64url(seed)).toHaveLength(43);
  });
});
