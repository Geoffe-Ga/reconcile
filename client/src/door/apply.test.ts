import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf, newKxKey } from '../crypto/box';
import {
  applicationIdOf,
  APPLICATION_INFO,
  doorChannelsOf,
  openPadded,
  REPLY_INFO,
  replyMailboxOf,
  sealPadded,
} from '../crypto/door';
import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { openStore } from '../store/db';
import { DOOR } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  type Application,
  apply,
  checkReplies,
  encodeApplication,
  inviteSeedIn,
  MESSAGE_MAX,
  NAME_MAX,
  parseApplication,
} from './apply';
import { addressOf, type OpenPage } from './page';

freshIndexedDBPerTest();

const NOW = 1_762_650_000_000;
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();
const textOf = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);

/** A reply seed and key, in their one canonical spelling. */
const SEED = base64url(new Uint8Array(32).fill(3));
const KEY = base64url(kxPublicKeyOf(new Uint8Array(32).fill(4)));
const APPLICATION: Application = {
  name: 'Kim',
  message: 'I live at number 12.',
  reply: { seed: SEED, key: KEY },
};

/** The door's address, its page and the box secret that opens what's sealed to it. */
const ADDRESS = addressOf(DOOR);
const BOX_SECRET = fromBase64url(DOOR.box);
const PAGE: OpenPage = {
  v: 1,
  open: true,
  name: 'Riverside Tenants',
  excerpt: 'We keep rents fair.',
  box: base64url(kxPublicKeyOf(BOX_SECRET)),
};

describe('encodeApplication and parseApplication', () => {
  it('write the three fields in one order and read them back', () => {
    expect(textOf(encodeApplication(APPLICATION))).toBe(
      `{"name":"Kim","message":"I live at number 12.","reply":{"seed":"${SEED}","key":"${KEY}"}}`,
    );
    expect(parseApplication(encodeApplication(APPLICATION))).toEqual(APPLICATION);
    expect(NAME_MAX).toBe(120);
    expect(MESSAGE_MAX).toBe(2000);
  });

  it('take a name of 120 code points and a message of 2,000, and refuse one more of either', () => {
    const name = '😀'.repeat(120);
    const message = 'm'.repeat(2000);
    expect(parseApplication(encodeApplication({ ...APPLICATION, name, message }))).not.toBeNull();
    expect(parseApplication(encodeApplication({ ...APPLICATION, name: `${name}x` }))).toBeNull();
    expect(
      parseApplication(encodeApplication({ ...APPLICATION, message: `${message}x` })),
    ).toBeNull();
  });

  it.each([
    ['a blank name', { ...APPLICATION, name: '  ' }],
    ['a reply seed that is not 32 bytes', { ...APPLICATION, reply: { seed: 'short', key: KEY } }],
    [
      'a reply key no box can be sealed to',
      { ...APPLICATION, reply: { seed: SEED, key: base64url(new Uint8Array(32)) } },
    ],
    ['a contact field', { ...APPLICATION, email: 'kim@example.com' }],
    ['a reply with another field', { ...APPLICATION, reply: { seed: SEED, key: KEY, name: 'x' } }],
    ['a message that is not text', { ...APPLICATION, message: 7 }],
  ])('refuse %s', (_name, value) => {
    expect(parseApplication(encoder.encode(JSON.stringify(value)))).toBeNull();
  });

  it('refuse bytes that aren’t a JSON object', () => {
    for (const bytes of [encoder.encode('[1]'), encoder.encode('nope'), Uint8Array.of(0xff)]) {
      expect(parseApplication(bytes)).toBeNull();
    }
  });
});

describe('inviteSeedIn', () => {
  const seed = new Uint8Array(32).fill(6);

  it('reads the seed from an invite link, from any origin', () => {
    expect(inviteSeedIn(`https://reconcile.test/#join/${base64url(seed)}`)).toEqual(seed);
  });

  it.each([
    ['a bare seed', base64url(new Uint8Array(32).fill(6))],
    ['a door link', `https://reconcile.test/#door/${base64url(new Uint8Array(32).fill(6))}`],
    ['a damaged seed', 'https://reconcile.test/#join/abc'],
    ['no link at all', 'Welcome!'],
  ])('refuses %s', (_name, text) => {
    expect(inviteSeedIn(text)).toBeNull();
  });
});

/** The one item in `items`. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined || items.length !== 1) throw new Error('Expected exactly one.');
  return item;
}

/** An applicant's services on `fake`, with its own store. */
async function applicant(fake = createFakeRelay(), clock = () => NOW) {
  const store = await openStore('applicant');
  return { fake, store, relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal, now: clock };
}

describe('apply: Send at the front door', () => {
  it('puts the application sealed to the page’s box, padded, in the inbox for 30 days', async () => {
    const services = await applicant();
    expect(
      await apply(services, ADDRESS, PAGE, { name: ' Kim ', message: 'I live at number 12.' }),
    ).toBe('sent');

    const { method, url, body } = only(services.fake.requests);
    const { inbox } = doorChannelsOf(ADDRESS);
    expect([method, url]).toEqual(['PUT', `/v1/mailbox/${inbox}?ttl_days=30`]);
    const blob = body ?? new Uint8Array();
    expect(blob).toHaveLength(1024);
    const opened = parseApplication(
      openPadded(BOX_SECRET, blob, APPLICATION_INFO, inbox) ?? new Uint8Array(),
    );
    expect(opened).toMatchObject({ name: 'Kim', message: 'I live at number 12.' });
    services.store.close();
  });

  it('keeps the reply seed and key on this device, under the application’s id', async () => {
    const services = await applicant();
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' });

    const blob = only(services.fake.requests).body ?? new Uint8Array();
    const { inbox } = doorChannelsOf(ADDRESS);
    const opened = parseApplication(
      openPadded(BOX_SECRET, blob, APPLICATION_INFO, inbox) ?? new Uint8Array(),
    );
    const kept = only(await services.store.listSent());
    expect(kept).toMatchObject({
      id: applicationIdOf(blob),
      door: base64url(ADDRESS),
      groupName: 'Riverside Tenants',
      sentAt: NOW,
    });
    expect(opened?.reply).toEqual({
      seed: base64url(kept.seed),
      key: base64url(kxPublicKeyOf(kept.replyKey)),
    });
    services.store.close();
  });

  it('keeps nothing when the relay can’t be reached', async () => {
    const services = await applicant();
    services.fake.offline = true;
    expect(await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' })).toBe('failed');
    expect(await services.store.listSent()).toEqual([]);
    services.store.close();
  });

  it('sends each application with a reply seed and key of its own', async () => {
    const services = await applicant();
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' });
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' });
    const [one, two] = await services.store.listSent();
    expect(base64url(one?.seed ?? new Uint8Array())).not.toBe(
      base64url(two?.seed ?? new Uint8Array()),
    );
    expect(base64url(one?.replyKey ?? new Uint8Array())).not.toBe(
      base64url(two?.replyKey ?? new Uint8Array()),
    );
    services.store.close();
  });
});

describe('checkReplies: an applicant’s device looks for an invite', () => {
  /** A member's reply to `kept`, sealed to its reply key, carrying `text`. */
  async function reply(
    services: Awaited<ReturnType<typeof applicant>>,
    text: string,
    key?: Uint8Array,
  ) {
    const [kept] = await services.store.listSent();
    if (kept === undefined) throw new Error('Expected an application.');
    const mailbox = replyMailboxOf(kept.seed);
    const blob = sealPadded(
      key ?? kxPublicKeyOf(kept.replyKey),
      encoder.encode(text),
      REPLY_INFO,
      mailbox,
    );
    await services.relay.putBlob(mailbox, blob, 2);
  }

  it('keeps the invite a reply carries, and the latest of two', async () => {
    let now = NOW;
    const services = await applicant(createFakeRelay(), () => now);
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' });
    await checkReplies(services);
    expect((await services.store.listSent())[0]?.invite).toBeUndefined();

    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(8);
    await reply(services, `https://reconcile.test/#join/${base64url(first)}`);
    await reply(services, 'not an invite');
    await reply(services, `https://reconcile.test/#join/${base64url(second)}`, newKxKey());
    now += DAY_MS;
    await checkReplies(services);
    expect(Array.from((await services.store.listSent())[0]?.invite ?? [])).toEqual(
      Array.from(first),
    );
    await reply(services, `https://reconcile.test/#join/${base64url(second)}`);
    await checkReplies(services);
    expect(Array.from((await services.store.listSent())[0]?.invite ?? [])).toEqual(
      Array.from(second),
    );
    services.store.close();
  });

  it('forgets an application 30 days after it was sent, and reads nothing for it', async () => {
    let now = NOW;
    const services = await applicant(createFakeRelay(), () => now);
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' });
    now += 30 * DAY_MS - 1;
    await checkReplies(services);
    expect(await services.store.listSent()).toHaveLength(1);
    now += 1;
    const before = services.fake.requests.length;
    await checkReplies(services);
    expect(await services.store.listSent()).toEqual([]);
    expect(services.fake.requests).toHaveLength(before);
    services.store.close();
  });

  it('carries on past a reply mailbox it can’t read', async () => {
    const services = await applicant();
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' });
    services.fake.offline = true;
    await expect(checkReplies(services)).resolves.toBeUndefined();
    services.store.close();
  });

  it('round-trips any name and message within the limits (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 120 }).filter((text) => text.trim() !== ''),
        fc.string({ maxLength: 300 }),
        (name, message) => {
          const value = { ...APPLICATION, name, message };
          expect(parseApplication(encodeApplication(value))).toEqual(value);
        },
      ),
      { numRuns: 50 },
    );
  });
});
