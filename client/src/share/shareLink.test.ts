/**
 * Sharing a personal Document by a read-only link (#105; ADR-0074's personal
 * page at level 2), against the in-memory relay: the owner's posts, the
 * reader's page, Stop sharing, and keeping a share alive past the relay's
 * 30-day retention (ADR-0057).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { deriveSealKey, newGroupSecret } from '../crypto/groupKeys';
import { vaultKeyFromPrf } from '../crypto/keyVault';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { xchachaSeal } from '../crypto/seal';
import { shareChannelOf, signShareRecord } from '../crypto/share';
import { newSigningKeys } from '../crypto/sign';
import { createRelay } from '../net/relay';
import type { Store } from '../store/db';
import { openStore, VaultLocked } from '../store/db';
import { mailboxAt } from '../store/mailbox';
import type { PersonalDocument, ShareState } from '../store/personal';
import { exportGroups, importGroups } from '../store/snapshot';
import { TEST_NOW, TEST_ORIGIN } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { encodeCopy, type ShareCopy } from './copy';
import {
  keepSharesAlive,
  keepSharing,
  parseShareLink,
  pauseOf,
  postCopy,
  postEdits,
  readShare,
  REFRESH_AFTER_DAYS,
  SHARE_TTL_DAYS,
  type ShareLink,
  type ShareServices,
  shareLinkOf,
  startSharing,
  stopSharing,
} from './shareLink';

freshIndexedDBPerTest();

const DAY_MS = 24 * 60 * 60 * 1000;
const PASSPHRASE = 'a long walk to the river';
const CHEAP = 4;

const stores: Store[] = [];

/** A device's share services, on its whole store, so a test can also save and restore. */
type OwnerServices = ShareServices & { readonly store: Store };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** The owner's Document, as Personal saves it. */
function statement(changes: Partial<PersonalDocument> = {}): PersonalDocument {
  return {
    id: 'U2hhcmVkIHN0YXRlbWVudA',
    title: 'Me',
    text: 'Real.\n',
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...changes,
  };
}

/** A device's share services on `fake`, with a clock a test can move. */
async function owner(fake: FakeRelay, name = 'ana') {
  const store = await openStore(name);
  stores.push(store);
  const clock = { now: TEST_NOW };
  const services: OwnerServices = {
    store,
    relay: createRelay({ fetch: fake.fetch }),
    seal: xchachaSeal,
    now: () => clock.now,
  };
  return { store, services, clock };
}

/** What anyone with the link reads: the relay and the seal, and nothing of the owner's. */
function reader(fake: FakeRelay) {
  return { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal };
}

/** Saves `document`, shares it, and hands back its link. */
async function sharedLink(services: OwnerServices, document = statement()): Promise<ShareLink> {
  await services.store.savePersonal(document);
  const started = await startSharing(services, document.id);
  if (started.kind !== 'shared') throw new Error(`Expected a share, not ${started.kind}.`);
  return started.link;
}

/** The text the link shows, or null for the not-shared line. */
async function shownText(fake: FakeRelay, link: ShareLink): Promise<string | null> {
  const view = await readShare(reader(fake), link);
  return view.kind === 'shown' ? view.text : null;
}

/** Seals `copy` for the link's mailbox, signed by `keys`, and posts it: what any link holder could do. */
async function postSigned(
  fake: FakeRelay,
  link: ShareLink,
  copy: ShareCopy,
  keys = newSigningKeys(),
): Promise<Uint8Array<ArrayBuffer>> {
  const channel = shareChannelOf(link.seed);
  const blob = xchachaSeal.seal(
    channel.mailbox,
    channel.key,
    signShareRecord(keys, encodeCopy(copy)),
  );
  await createRelay({ fetch: fake.fetch }).putBlob(channel.mailbox, blob, 30);
  return blob;
}

/** A copy sealed right, signed by a key other than the owner's. */
function postForged(fake: FakeRelay, link: ShareLink, copy: ShareCopy) {
  return postSigned(fake, link, copy);
}

/** Every blob in the link's mailbox, oldest first. */
function blobsOf(fake: FakeRelay, link: ShareLink): Uint8Array[] {
  return fake.blobs(shareChannelOf(link.seed).mailbox);
}

/** The PUTs the relay took, as their paths with their queries. */
function puts(fake: FakeRelay): string[] {
  return fake.requests.filter((request) => request.method === 'PUT').map(({ url }) => url);
}

describe('share links', () => {
  const link: ShareLink = {
    seed: Uint8Array.from({ length: 32 }, (_, i) => i),
    publicKey: newSigningKeys().publicKey,
  };
  const payload = `${base64url(link.seed)}.${base64url(link.publicKey)}`;

  it('are the origin, then #share/ and the seed and public key, 43 base64url characters each', () => {
    const made = shareLinkOf(TEST_ORIGIN, link);

    expect(made).toBe(`${TEST_ORIGIN}/#share/${payload}`);
    expect(made).toMatch(/^https:\/\/reconcile\.test\/#share\/[\w-]{43}\.[\w-]{43}$/);
  });

  it('read back from the whole link at any origin, the fragment alone, or the bare pair', () => {
    for (const text of [
      shareLinkOf(TEST_ORIGIN, link),
      `https://elsewhere.example/#share/${payload}`,
      `  ${shareLinkOf(TEST_ORIGIN, link)}\n`,
      `#share/${payload}`,
      payload,
    ]) {
      const parsed = parseShareLink(text);
      expect(
        parsed === null ? null : [base64url(parsed.seed), base64url(parsed.publicKey)],
      ).toEqual([base64url(link.seed), base64url(link.publicKey)]);
    }
  });

  it.each([
    ['nothing', ''],
    ['an invite link', `${TEST_ORIGIN}/#join/${base64url(link.seed)}`],
    ['a seed alone', `${TEST_ORIGIN}/#share/${base64url(link.seed)}`],
    ['a short seed', `#share/${base64url(link.seed).slice(1)}.${base64url(link.publicKey)}`],
    ['a long key', `#share/${payload}A`],
    [
      'a seed in non-canonical base64url',
      `#share/${base64url(link.seed).slice(0, 42)}B.${base64url(link.publicKey)}`,
    ],
    ['padding', `#share/${base64url(link.seed)}=.${base64url(link.publicKey)}`],
    ['a third part', `#share/${payload}.${base64url(link.seed)}`],
    ['a path after it', `#share/${payload}/more`],
    ['the slashed form', `#/share/${payload}`],
    ['a path instead of a fragment', `${TEST_ORIGIN}/share/${payload}`],
  ])('refuse %s', (_name, text) => {
    expect(parseShareLink(text)).toBe(null);
  });
});

describe('startSharing', () => {
  it('makes a fresh seed and keypair, and posts the first copy, sealed and padded, to their own mailbox for 30 days', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);

    const link = await sharedLink(services);

    const channel = shareChannelOf(link.seed);
    expect(SHARE_TTL_DAYS).toBe(30);
    expect(puts(fake)).toEqual([`/v1/mailbox/${channel.mailbox}?ttl_days=30`]);
    expect(blobsOf(fake, link).map((blob) => blob.length)).toEqual([1024]);
    const kept = (await store.getPersonal(statement().id))?.share;
    expect(kept && [base64url(kept.seed), base64url(kept.publicKey)]).toEqual([
      base64url(link.seed),
      base64url(link.publicKey),
    ]);
    expect(kept && [kept.n, kept.lastPostedAt, kept.pending]).toEqual([1, TEST_NOW, false]);
    expect(await readShare(reader(fake), link)).toEqual({
      kind: 'shown',
      title: 'Me',
      text: 'Real.\n',
    });
  });

  it('posts the text normalized, as Preview shows it, and leaves the stored text as typed', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);

    const link = await sharedLink(services, statement({ text: 'Real.  \r\n\r\n\r\n\r\nWords.' }));

    expect(await shownText(fake, link)).toBe('Real.\n\n\n\nWords.\n');
    expect((await store.getPersonal(statement().id))?.text).toBe('Real.  \r\n\r\n\r\n\r\nWords.');
  });

  it('gives two shares of one Document unrelated seeds, mailboxes and keys, none of them a group’s', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const signing = newSigningKeys();
    await store.addGroup({
      groupId: 'G'.repeat(43),
      secret: newGroupSecret(),
      signingKey: signing.secretKey,
      me: { author: base64url(signing.publicKey), name: 'Ana' },
    });
    const group = await store.getGroup('G'.repeat(43));
    if (group === undefined) throw new Error('Expected the group.');

    const first = await sharedLink(services);
    await stopSharing(services, statement().id);
    const started = await startSharing(services, statement().id);
    if (started.kind !== 'shared') throw new Error('Expected a second share.');
    const second = started.link;

    const [a, b] = [shareChannelOf(first.seed), shareChannelOf(second.seed)];
    const groupValues = [
      mailboxAt(group, fake.minute),
      base64url(deriveSealKey(group.secret)),
      base64url(group.secret),
      group.me.author,
      base64url(group.signingKey),
    ];
    const shareValues = (link: ShareLink, channel: typeof a) => [
      base64url(link.seed),
      base64url(link.publicKey),
      channel.mailbox,
      base64url(channel.key),
    ];
    const values = [...shareValues(first, a), ...shareValues(second, b)];
    expect(new Set(values).size).toBe(8);
    for (const value of values) expect(groupValues).not.toContain(value);
  });

  it('keeps nothing and copies nothing when the relay can’t be reached', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await store.savePersonal(statement());
    fake.offline = true;

    expect(await startSharing(services, statement().id)).toEqual({ kind: 'failed' });

    expect((await store.getPersonal(statement().id))?.share).toBeUndefined();
  });

  it('refuses a Document whose record would be over 64,000 bytes before any request', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await store.savePersonal(statement({ text: 'x'.repeat(MAX_RECORD_BYTES) }));

    expect(await startSharing(services, statement().id)).toEqual({ kind: 'too-large' });

    expect(fake.requests).toEqual([]);
    expect((await store.getPersonal(statement().id))?.share).toBeUndefined();
  });

  it('says a Document the device doesn’t hold is missing, with no request', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);

    expect(await startSharing(services, statement().id)).toEqual({ kind: 'missing' });
    expect(fake.requests).toEqual([]);
  });

  it('hands back the same link for a Document already shared, posting nothing more', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const link = await sharedLink(services);

    const again = await startSharing(services, statement().id);

    expect(again.kind === 'shared' ? base64url(again.link.seed) : null).toBe(base64url(link.seed));
    expect(puts(fake)).toHaveLength(1);
  });
});

describe('readShare', () => {
  it('ignores a copy posted by someone who only has the link', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const link = await sharedLink(services, statement({ title: 'Me', text: 'Real.\n' }));

    await postForged(fake, link, { v: 1, n: 99, title: 'Me', text: 'Forged.\n' });

    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('ignores a tombstone posted by someone who only has the link', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const link = await sharedLink(services);

    await postForged(fake, link, { v: 1, n: 99, stopped: true });

    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('doesn’t roll back when an older genuine copy is posted again after a newer one', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const [older] = blobsOf(fake, link);
    await store.savePersonal(statement({ text: 'Newer.\n' }));
    await postCopy(services, statement().id);

    await createRelay({ fetch: fake.fetch }).putBlob(
      shareChannelOf(link.seed).mailbox,
      Uint8Array.from(older ?? []),
      30,
    );

    expect(blobsOf(fake, link)).toHaveLength(3);
    expect(await shownText(fake, link)).toBe('Newer.\n');
  });

  it('shows the later of two copies with the same n', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const share = (await store.getPersonal(statement().id))?.share;
    if (share === undefined) throw new Error('Expected a share.');
    const keys = { secretKey: share.secretKey, publicKey: share.publicKey };

    await postSigned(fake, link, { v: 1, n: 5, title: 'Me', text: 'First of two.\n' }, keys);
    await postSigned(fake, link, { v: 1, n: 5, title: 'Me', text: 'Second of two.\n' }, keys);

    expect(await shownText(fake, link)).toBe('Second of two.\n');
  });

  it('shows the not-shared line after a tombstone', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const link = await sharedLink(services);

    await stopSharing(services, statement().id);

    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
  });

  it('keeps a tombstone final, even under a copy with a higher n', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const share = (await store.getPersonal(statement().id))?.share;
    if (share === undefined) throw new Error('Expected a share.');
    const keys = { secretKey: share.secretKey, publicKey: share.publicKey };
    await postSigned(fake, link, { v: 1, n: 2, stopped: true }, keys);

    await postSigned(fake, link, { v: 1, n: 3, title: 'Me', text: 'After the end.\n' }, keys);

    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
  });

  it('skips a blob with one flipped byte, and the next good copy still shows', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const share = (await store.getPersonal(statement().id))?.share;
    if (share === undefined) throw new Error('Expected a share.');
    const keys = { secretKey: share.secretKey, publicKey: share.publicKey };
    const channel = shareChannelOf(link.seed);
    const relay = createRelay({ fetch: fake.fetch });
    const later = xchachaSeal.seal(
      channel.mailbox,
      channel.key,
      signShareRecord(keys, encodeCopy({ v: 1, n: 7, title: 'Me', text: 'Damaged.\n' })),
    );

    for (const index of [0, 30, later.length - 1]) {
      const flipped = Uint8Array.from(later);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      await relay.putBlob(channel.mailbox, flipped, 30);
    }

    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('skips blobs that hold no copy: another mailbox’s, a record that isn’t JSON, a copy of format 2', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const share = (await store.getPersonal(statement().id))?.share;
    if (share === undefined) throw new Error('Expected a share.');
    const keys = { secretKey: share.secretKey, publicKey: share.publicKey };
    const channel = shareChannelOf(link.seed);
    const relay = createRelay({ fetch: fake.fetch });
    const sealed = (bytes: Uint8Array) => xchachaSeal.seal(channel.mailbox, channel.key, bytes);
    const elsewhere = shareChannelOf(new Uint8Array(32).fill(1));

    await relay.putBlob(
      channel.mailbox,
      xchachaSeal.seal(
        elsewhere.mailbox,
        channel.key,
        signShareRecord(keys, encodeCopy({ v: 1, n: 8, title: 'Me', text: 'Moved.\n' })),
      ),
      30,
    );
    await relay.putBlob(
      channel.mailbox,
      sealed(signShareRecord(keys, new TextEncoder().encode('not json'))),
      30,
    );
    await relay.putBlob(
      channel.mailbox,
      sealed(
        signShareRecord(
          keys,
          new TextEncoder().encode('{"v":2,"n":9,"title":"Me","text":"Two.\\n"}'),
        ),
      ),
      30,
    );

    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('reads every page of a full mailbox, so a copy after 100 others still shows', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const channel = shareChannelOf(link.seed);
    const relay = createRelay({ fetch: fake.fetch });
    for (let i = 0; i < 100; i += 1) {
      await relay.putBlob(channel.mailbox, new Uint8Array(1024), 30);
    }
    await store.savePersonal(statement({ text: 'Past the first page.\n' }));

    await postCopy(services, statement().id);

    expect(await shownText(fake, link)).toBe('Past the first page.\n');
  });

  it('shows the not-shared line for an empty mailbox, and for one holding no valid copy', async () => {
    const fake = createFakeRelay();
    const link: ShareLink = {
      seed: new Uint8Array(32).fill(3),
      publicKey: newSigningKeys().publicKey,
    };

    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
    await postForged(fake, link, { v: 1, n: 1, title: 'Me', text: 'Forged.\n' });
    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
  });

  it('only ever names the share’s mailbox to the relay, and only reads', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const link = await sharedLink(services);
    fake.requests.length = 0;

    await readShare(reader(fake), link);

    const mailbox = shareChannelOf(link.seed).mailbox;
    expect(fake.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /v1/mailbox/${mailbox}?after=0&limit=100`,
    ]);
  });

  it('rejects when the relay can’t be reached, so the page can say so', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const link = await sharedLink(services);
    fake.offline = true;

    await expect(readShare(reader(fake), link)).rejects.toThrow();
  });
});

describe('postCopy', () => {
  it('counts on from the highest copy in the mailbox that verifies, not a forged one', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await postForged(fake, link, { v: 1, n: 99, title: 'Me', text: 'Forged.\n' });
    await store.savePersonal(statement({ text: 'Second.\n' }));

    expect(await postCopy(services, statement().id)).toBe('posted');

    expect((await store.getPersonal(statement().id))?.share?.n).toBe(2);
    expect(await shownText(fake, link)).toBe('Second.\n');
  });

  it('counts on from its own last number when the relay has lost every copy, as a fresh relay has', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await postCopy(services, statement().id);
    fake.restart();

    expect(await postCopy(services, statement().id)).toBe('posted');

    expect((await store.getPersonal(statement().id))?.share?.n).toBe(3);
    expect(blobsOf(fake, link)).toHaveLength(1);
    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('posts after an older backup is restored with a number above every copy, and the page shows it', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const { file } = await exportGroups(store, PASSPHRASE, CHEAP);
    for (const text of ['Two.\n', 'Three.\n']) {
      await store.savePersonal(statement({ text, updatedAt: TEST_NOW + 1 }));
      await postCopy(services, statement().id);
    }
    const restored = await owner(fake, 'restored');
    await importGroups(restored.store, file, PASSPHRASE);
    expect((await restored.store.getPersonal(statement().id))?.share?.n).toBe(1);

    // A restored share waits for the person (#328); once they keep it, it counts on.
    expect(await keepSharing(restored.services, statement().id)).toBe('posted');

    expect((await restored.store.getPersonal(statement().id))?.share?.n).toBe(4);
    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('finds the tombstone once the person keeps a share restored from a backup made before Stop sharing, drops it and posts nothing', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const { file } = await exportGroups(store, PASSPHRASE, CHEAP);
    await stopSharing(services, statement().id);
    const restored = await owner(fake, 'restored');
    await importGroups(restored.store, file, PASSPHRASE);
    const before = puts(fake).length;

    expect(await postCopy(restored.services, statement().id)).toBe('paused');
    expect(await keepSharing(restored.services, statement().id)).toBe('stopped');

    expect(puts(fake)).toHaveLength(before);
    expect((await restored.store.getPersonal(statement().id))?.share).toBeUndefined();
    expect((await restored.store.getPersonal(statement().id))?.text).toBe('Real.\n');
    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
  });

  it('leaves the share pending and the page as it was when the relay is down', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await store.savePersonal(statement({ text: 'Offline edit.\n' }));
    fake.offline = true;

    expect(await postCopy(services, statement().id)).toBe('failed');

    const share = (await store.getPersonal(statement().id))?.share;
    expect(share && [share.n, share.lastPostedAt, share.pending]).toEqual([1, TEST_NOW, true]);
    fake.offline = false;
    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('sets pending on any failed post, even one with no edit to send', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await sharedLink(services);
    fake.offline = true;

    expect(await postCopy(services, statement().id)).toBe('failed');

    expect((await store.getPersonal(statement().id))?.share?.pending).toBe(true);
  });

  it('marks pending, and posts nothing, once the Document has grown too large to share', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await store.savePersonal(statement({ text: 'x'.repeat(MAX_RECORD_BYTES) }));
    await store.updateShare(
      statement().id,
      (held) => held.share && { ...held.share, pending: false },
    );
    const before = fake.requests.length;

    expect(await postCopy(services, statement().id)).toBe('too-large');

    expect(fake.requests).toHaveLength(before);
    expect((await store.getPersonal(statement().id))?.share?.pending).toBe(true);
    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('keeps pending set when the Document changed while its copy was posting', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await sharedLink(services);
    const put = services.relay.putBlob;
    const editing: ShareServices = {
      ...services,
      relay: {
        ...services.relay,
        async putBlob(mailbox, blob, ttl) {
          const seq = await put(mailbox, blob, ttl);
          await store.savePersonal(statement({ text: 'Typed meanwhile.\n' }));
          return seq;
        },
      },
    };
    await store.savePersonal(statement({ text: 'Posting.\n' }));

    expect(await postCopy(editing, statement().id)).toBe('posted');

    const share = (await store.getPersonal(statement().id))?.share;
    expect(share && [share.n, share.pending]).toEqual([2, true]);
  });

  it('does nothing for a Document that isn’t shared, or isn’t on the device', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await store.savePersonal(statement());

    expect(await postCopy(services, statement().id)).toBe('unshared');
    expect(await postCopy(services, 'Tm8gc3VjaCBkb2N1bWVudA')).toBe('unshared');
    expect(fake.requests).toEqual([]);
  });

  it('posts one copy at a time for one Document, so two posts never share a number', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await store.savePersonal(statement({ text: 'Both.\n' }));
    // The first read's answer waits a moment, so a second post that didn't wait its turn would read meanwhile.
    let reads = 0;
    const slow: ShareServices = {
      ...services,
      relay: {
        ...services.relay,
        async getBlobs(mailbox, after) {
          reads += 1;
          const page = await services.relay.getBlobs(mailbox, after);
          if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 30));
          return page;
        },
      },
    };

    await Promise.all([postCopy(slow, statement().id), postCopy(slow, statement().id)]);

    expect((await store.getPersonal(statement().id))?.share?.n).toBe(3);
    expect(blobsOf(fake, link)).toHaveLength(3);
  });
});

describe('postEdits', () => {
  it('posts a copy when an edit waits for the link, and nothing when none does', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);

    expect(await postEdits(services, statement().id)).toBe('unchanged');
    await store.savePersonal(statement({ title: 'Me, renamed' }));
    expect(await postEdits(services, statement().id)).toBe('posted');

    expect(blobsOf(fake, link)).toHaveLength(2);
    expect(await readShare(reader(fake), link)).toEqual({
      kind: 'shown',
      title: 'Me, renamed',
      text: 'Real.\n',
    });
  });

  it('does nothing for a Document that isn’t shared', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await store.savePersonal(statement());

    expect(await postEdits(services, statement().id)).toBe('unchanged');
    expect(fake.requests).toEqual([]);
  });
});

describe('one post at a time', () => {
  it('runs the next post for a Document after one that threw', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await store.savePersonal(statement({ text: 'After the failure.\n' }));
    const failing: ShareServices = {
      ...services,
      store: { ...store, getPersonal: () => Promise.reject(new Error('IndexedDB refused.')) },
    };

    const [threw, posted] = await Promise.allSettled([
      postCopy(failing, statement().id),
      postCopy(services, statement().id),
    ]);

    expect(threw.status).toBe('rejected');
    expect(posted).toEqual({ status: 'fulfilled', value: 'posted' });
    expect(await shownText(fake, link)).toBe('After the failure.\n');
  });
});

describe('stopSharing', () => {
  it('posts a tombstone, drops the share state and keeps the Document', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);

    expect(await stopSharing(services, statement().id)).toBe('stopped');

    expect(blobsOf(fake, link).map((blob) => blob.length)).toEqual([1024, 1024]);
    const kept = await store.getPersonal(statement().id);
    expect(kept?.share).toBeUndefined();
    expect(kept?.text).toBe('Real.\n');
    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
    expect(await postCopy(services, statement().id)).toBe('unshared');
  });

  it('changes nothing offline, and says so', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    fake.offline = true;

    expect(await stopSharing(services, statement().id)).toBe('failed');

    fake.offline = false;
    expect((await store.getPersonal(statement().id))?.share?.n).toBe(1);
    expect(await shownText(fake, link)).toBe('Real.\n');
  });

  it('posts no second tombstone for a share another copy of this device already stopped', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    const { file } = await exportGroups(store, PASSPHRASE, CHEAP);
    await stopSharing(services, statement().id);
    const restored = await owner(fake, 'restored');
    await importGroups(restored.store, file, PASSPHRASE);

    expect(await stopSharing(restored.services, statement().id)).toBe('stopped');

    expect(blobsOf(fake, link)).toHaveLength(2);
    expect((await restored.store.getPersonal(statement().id))?.share).toBeUndefined();
  });

  it('is done already for a Document that isn’t shared', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await store.savePersonal(statement());

    expect(await stopSharing(services, statement().id)).toBe('stopped');
    expect(fake.requests).toEqual([]);
  });
});

describe('keepSharesAlive', () => {
  it('posts again a share last posted 20 days ago, and not one posted 19 days ago', async () => {
    const fake = createFakeRelay();
    const { store, services, clock } = await owner(fake);
    const link = await sharedLink(services);
    expect(REFRESH_AFTER_DAYS).toBe(20);

    clock.now = TEST_NOW + 19 * DAY_MS;
    await keepSharesAlive(services);
    expect(blobsOf(fake, link)).toHaveLength(1);

    clock.now = TEST_NOW + 20 * DAY_MS;
    await keepSharesAlive(services);
    expect(blobsOf(fake, link)).toHaveLength(2);
    const share = (await store.getPersonal(statement().id))?.share;
    expect(share && [share.n, share.lastPostedAt, share.pending]).toEqual([
      2,
      TEST_NOW + 20 * DAY_MS,
      false,
    ]);
  });

  it('posts a share last posted just under 30 days ago, and pauses one posted 30 days ago, which may have been stopped elsewhere (#339)', async () => {
    const fake = createFakeRelay();
    const { services, clock } = await owner(fake);
    expect(SHARE_TTL_DAYS).toBe(30);
    const older = await sharedLink(services);
    clock.now = TEST_NOW + 1;
    const other = statement({ id: 'T3RoZXIgc3RhdGVtZW50IQ', title: 'Other' });
    const newer = await sharedLink(services, other);
    clock.now = TEST_NOW + SHARE_TTL_DAYS * DAY_MS;

    expect(await keepSharesAlive(services)).toEqual([[other.id, 'posted']]);
    expect(await postCopy(services, statement().id)).toBe('paused');

    expect(blobsOf(fake, older)).toHaveLength(1);
    expect(blobsOf(fake, newer)).toHaveLength(2);
  });

  it('posts an edit made while the relay was down at the next run, and clears pending', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    const link = await sharedLink(services);
    await store.savePersonal(statement({ text: 'Written offline.\n' }));
    fake.offline = true;
    await postCopy(services, statement().id);
    expect((await store.getPersonal(statement().id))?.share?.pending).toBe(true);
    fake.offline = false;

    await keepSharesAlive(services);

    expect((await store.getPersonal(statement().id))?.share?.pending).toBe(false);
    expect(await shownText(fake, link)).toBe('Written offline.\n');
  });

  it('leaves alone a Document that isn’t shared, and goes on past a share that fails', async () => {
    const fake = createFakeRelay();
    const { store, services } = await owner(fake);
    await sharedLink(services);
    const other = statement({ id: 'T3RoZXIgc3RhdGVtZW50IQ', title: 'Other' });
    const otherLink = await sharedLink(services, other);
    await store.savePersonal(statement({ id: 'UGxhaW4gc3RhdGVtZW50IQ', title: 'Plain' }));
    await store.savePersonal(statement({ text: 'x'.repeat(MAX_RECORD_BYTES) }));
    await store.savePersonal({ ...other, text: 'Other, edited.\n' });
    const before = puts(fake).length;

    // Oldest first, then by id, as Personal lists them.
    expect(await keepSharesAlive(services)).toEqual([
      [other.id, 'posted'],
      [statement().id, 'too-large'],
    ]);

    expect(puts(fake)).toHaveLength(before + 1);
    expect(await shownText(fake, otherLink)).toBe('Other, edited.\n');
  });
});

describe('pauseOf', () => {
  const live: ShareState = {
    seed: new Uint8Array(32).fill(1),
    secretKey: new Uint8Array(32).fill(2),
    publicKey: new Uint8Array(32).fill(3),
    n: 3,
    lastPostedAt: TEST_NOW,
    pending: false,
  };
  const lifetime = SHARE_TTL_DAYS * DAY_MS;

  it('is null for a share last posted under 30 days ago, and idle from 30 days on (#339)', () => {
    expect(pauseOf(live, TEST_NOW + lifetime - 1)).toBeNull();
    expect(pauseOf(live, TEST_NOW + lifetime)).toBe('idle');
    expect(pauseOf({ ...live, pending: true }, TEST_NOW + lifetime + DAY_MS)).toBe('idle');
  });

  it('says restored for a share a restore paused, however recently it was posted (#328)', () => {
    expect(pauseOf({ ...live, paused: true }, TEST_NOW)).toBe('restored');
    expect(pauseOf({ ...live, paused: true }, TEST_NOW + lifetime)).toBe('restored');
  });

  it('is null for a share never posted, whose link no one could have opened', () => {
    expect(pauseOf({ ...live, lastPostedAt: null }, TEST_NOW + lifetime)).toBeNull();
  });
});

describe('a device whose keys are locked with a passkey (#255)', () => {
  const SALT = new Uint8Array(32).fill(0x33);
  const KEY = vaultKeyFromPrf(new Uint8Array(32).fill(0x11), SALT);
  const LOCK = { credentialId: Uint8Array.of(1, 2, 3, 4), prfSalt: SALT };

  /** Ana's device with one Document shared, sealed, then opened again and still locked. */
  async function lockedOwner(fake: FakeRelay) {
    const { services, store } = await owner(fake);
    const link = await sharedLink(services);
    await services.store.savePersonal({
      ...statement(),
      text: 'Edited.\n',
      updatedAt: TEST_NOW + 1,
    });
    await store.sealKeys(LOCK, KEY);
    store.close();
    return { link, ...(await owner(fake)) };
  }

  it('posts nothing, starts nothing and stops nothing, saying it’s locked', async () => {
    const fake = createFakeRelay();
    const { link, services, store } = await lockedOwner(fake);
    await store.savePersonal({ ...statement({ id: 'T3RoZXIgc3RhdGVtZW50IQ' }), title: 'Other' });
    const requests = fake.requests.length;

    expect(await stopSharing(services, statement().id)).toBe('locked');
    expect(await startSharing(services, 'T3RoZXIgc3RhdGVtZW50IQ')).toEqual({ kind: 'locked' });
    await expect(postCopy(services, statement().id)).rejects.toThrow(VaultLocked);
    await expect(postEdits(services, statement().id)).rejects.toThrow(VaultLocked);
    await expect(keepSharesAlive(services)).rejects.toThrow(VaultLocked);

    expect(fake.requests).toHaveLength(requests);
    expect(await shownText(fake, link)).toBe('Real.\n');
    expect((await store.listPersonalEntries()).map((entry) => entry.share?.pending)).toEqual([
      undefined,
      true,
    ]);
  });

  it('fails with any other error the lock check meets, sending nothing', async () => {
    const fake = createFakeRelay();
    const { services } = await owner(fake);
    const broken = new Error('IndexedDB refused.');
    const failing: OwnerServices = {
      ...services,
      store: Object.assign(Object.create(services.store) as Store, {
        requireUnlocked: () => Promise.reject(broken),
      }),
    };

    await expect(startSharing(failing, statement().id)).rejects.toBe(broken);
    await expect(stopSharing(failing, statement().id)).rejects.toBe(broken);
    expect(fake.requests).toEqual([]);
  });

  it('posts, then stops, with the share’s keys from the vault once unlocked', async () => {
    const fake = createFakeRelay();
    const { link, services, store } = await lockedOwner(fake);
    expect(await store.unlock(KEY)).toBe(true);

    expect(await keepSharesAlive(services)).toEqual([[statement().id, 'posted']]);
    expect(await shownText(fake, link)).toBe('Edited.\n');
    expect(await stopSharing(services, statement().id)).toBe('stopped');
    expect(await readShare(reader(fake), link)).toEqual({ kind: 'gone' });
  });
});
