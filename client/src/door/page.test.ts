import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorChannelsOf, doorKeysOf, signDoorRecord } from '../crypto/door';
import { xchachaSeal } from '../crypto/seal';
import { newSigningKeys } from '../crypto/sign';
import { createRelay } from '../net/relay';
import { COUNTED, DOOR, ROTATED } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { groupLog } from '../test/votes';
import {
  addressOf,
  DOOR_PREFIX,
  doorLinkOf,
  encodePage,
  excerptOf,
  latestCopy,
  openPage,
  PAGE_TTL_DAYS,
  pageFor,
  parseDoorLink,
  parseDoorPayload,
  parsePage,
  publishPage,
  readDoor,
  REFRESH_MINUTES,
} from './page';

const encoder = new TextEncoder();

/** A box key, in its one canonical spelling. */
const BOX = base64url(new Uint8Array(32).fill(0x42));

/** The words of a page's plaintext. */
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A group of Ana, Ben and Cal, with canary names, whose door is open. */
function opened(door = DOOR, names = ['Ben', 'Cal']) {
  const log = groupLog({ members: names, atoms: ['We keep rents **fair**.', 'Bins.'] });
  const proposal = log.rules('Ana', 'frontDoor', door, { title: 'Open a front door' });
  for (const name of ['Ana', ...names]) log.vote(name, proposal, 4);
  log.minute += 1;
  return log;
}

/** Strips Markdown as the app's `plainText` does, for these tests' one sentence. */
const plain = (text: string) => text.replaceAll('**', '');

describe('the door link', () => {
  const address = doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box)).signing.publicKey;

  it('is the origin, then #door/ and the door’s 43-character address', () => {
    const link = doorLinkOf('https://reconcile.test', address);
    expect(DOOR_PREFIX).toBe('#door/');
    expect(link).toBe(`https://reconcile.test/#door/${base64url(address)}`);
    expect(link).toMatch(/^https:\/\/reconcile\.test\/#door\/[A-Za-z0-9_-]{43}$/);
  });

  it('reads back from the whole link, its fragment, or the bare address', () => {
    const text = base64url(address);
    for (const pasted of [`https://elsewhere.example/#door/${text}`, ` #door/${text} `, text]) {
      expect(parseDoorLink(pasted)).toEqual(address);
    }
    expect(parseDoorPayload(text)).toEqual(address);
  });

  it.each([
    ['an invite link', `https://reconcile.test/#join/${'A'.repeat(43)}`],
    ['42 characters', `#door/${'A'.repeat(42)}`],
    ['a spare bit set', `#door/${'A'.repeat(42)}B`],
    ['a slash after it', `#door/${'A'.repeat(43)}/`],
    ['nothing', ''],
  ])('refuses %s', (_name, text) => {
    expect(parseDoorLink(text)).toBeNull();
  });

  it('names the address a door’s secrets make', () => {
    expect(addressOf(DOOR)).toEqual(address);
    expect(base64url(addressOf(ROTATED))).not.toBe(base64url(address));
  });
});

describe('excerptOf', () => {
  it('keeps text of 280 code points whole, and cuts longer text to 280 plus “…”', () => {
    const exact = '😀'.repeat(280);
    expect(excerptOf(exact)).toBe(exact);
    expect(excerptOf(`${exact}x`)).toBe(`${exact}…`);
    expect(Array.from(excerptOf('a'.repeat(1000)))).toHaveLength(281);
  });
});

describe('pageFor: what the page says, and nothing else', () => {
  it('carries the group’s name, the first section as plain text and the box key, with no count', () => {
    const state = opened().state();
    const page = pageFor(state, DOOR, plain);
    const { boxPublic } = doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box));
    expect(page).toEqual({
      v: 1,
      open: true,
      name: 'Riverside Tenants',
      excerpt: 'We keep rents fair.',
      box: base64url(boxPublic),
    });
    expect(textOf(encodePage(page))).not.toContain('count');
  });

  it('shows the member count only when the group chose to', () => {
    const state = opened(COUNTED).state();
    expect(pageFor(state, COUNTED, plain)).toMatchObject({ count: 3 });
  });

  it('never carries a member’s name, whatever their names are (fast-check)', () => {
    const name = fc.stringMatching(/^[A-Z][a-z]{3,12}zq$/);
    fc.assert(
      fc.property(fc.uniqueArray(name, { minLength: 2, maxLength: 3 }), (names) => {
        const log = groupLog({ founder: 'Anazq', members: names });
        const open = log.rules('Anazq', 'frontDoor', COUNTED, { title: 'Open' });
        for (const voter of ['Anazq', ...names]) log.vote(voter, open, 4);
        log.minute += 1;
        const text = textOf(encodePage(pageFor(log.state(), COUNTED, plain)));
        for (const member of ['Anazq', ...names]) expect(text).not.toContain(member);
      }),
      { numRuns: 10 },
    );
  });
});

describe('encodePage and parsePage', () => {
  const open = { v: 1, open: true, name: 'R', excerpt: 'E', box: BOX } as const;

  it('write a page’s fields in one order and read them back', () => {
    expect(textOf(encodePage(open))).toBe(
      `{"v":1,"open":true,"name":"R","excerpt":"E","box":"${BOX}"}`,
    );
    expect(textOf(encodePage({ ...open, count: 4 }))).toBe(
      `{"v":1,"open":true,"name":"R","excerpt":"E","count":4,"box":"${BOX}"}`,
    );
    expect(textOf(encodePage({ v: 1, open: false }))).toBe('{"v":1,"open":false}');
    for (const page of [open, { ...open, count: 4 }, { v: 1, open: false } as const]) {
      expect(parsePage(encodePage(page))).toEqual(page);
    }
  });

  it.each([
    ['another version', '{"v":2,"open":false}'],
    ['a closed page with a name', '{"v":1,"open":false,"name":"R"}'],
    ['an open page with no box', '{"v":1,"open":true,"name":"R","excerpt":"E"}'],
    ['a box that is not a key', '{"v":1,"open":true,"name":"R","excerpt":"E","box":"short"}'],
    [
      'a count that is not a whole number',
      `{"v":1,"open":true,"name":"R","excerpt":"E","count":1.5,"box":"${BOX}"}`,
    ],
    ['a negative count', `{"v":1,"open":true,"name":"R","excerpt":"E","count":-1,"box":"${BOX}"}`],
    [
      'an extra field',
      `{"v":1,"open":true,"name":"R","excerpt":"E","box":"${BOX}","people":["Ana"]}`,
    ],
    [
      'a name over 120 code points and its “…”',
      `{"v":1,"open":true,"name":"${'n'.repeat(122)}","excerpt":"E","box":"${BOX}"}`,
    ],
    [
      'an excerpt over 280 code points and its “…”',
      `{"v":1,"open":true,"name":"R","excerpt":"${'e'.repeat(282)}","box":"${BOX}"}`,
    ],
    ['an open that is not true or false', '{"v":1,"open":"yes"}'],
    ['a list', '[1]'],
    ['bytes that are not UTF-8', '�'],
  ])('refuse %s', (_name, text) => {
    const bytes = text === '�' ? Uint8Array.of(0xff, 0xfe) : encoder.encode(text);
    expect(parsePage(bytes)).toBeNull();
  });
});

describe('publishing and reading the page', () => {
  const services = (fake = createFakeRelay()) => ({
    fake,
    relay: createRelay({ fetch: fake.fetch }),
    seal: xchachaSeal,
  });
  const address = addressOf(DOOR);
  const page = { v: 1, open: true, name: 'Riverside', excerpt: 'Fair rents.', box: BOX } as const;

  it('reads a door with no copy as closed', async () => {
    const { relay, seal } = services();
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'closed' });
  });

  it('posts the page sealed, padded and signed for 30 days, and reads it back', async () => {
    const { fake, relay, seal } = services();
    expect(await publishPage({ relay, seal }, DOOR, page, fake.minute)).toEqual({ kind: 'posted' });
    const [put] = fake.requests.filter((request) => request.method === 'PUT');
    expect(put?.url).toBe(
      `/v1/mailbox/${doorChannelsOf(address).page}?ttl_days=${String(PAGE_TTL_DAYS)}`,
    );
    expect(PAGE_TTL_DAYS).toBe(30);
    expect(put?.body?.length).toBe(1024);
    expect(textOf(put?.body ?? new Uint8Array())).not.toContain('Riverside');
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'open', page });
  });

  it('posts nothing while the newest copy says the same and is under 7 days old, then posts again', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    const posted = fake.minute;
    fake.minute += REFRESH_MINUTES - 1;
    expect(await publishPage({ relay, seal }, DOOR, page, fake.minute)).toEqual({
      kind: 'current',
      received: posted,
    });
    fake.minute += 1;
    expect(REFRESH_MINUTES).toBe(7 * 1440);
    expect(await publishPage({ relay, seal }, DOOR, page, fake.minute)).toEqual({ kind: 'posted' });
    expect((await latestCopy({ relay, seal }, address))?.received).toBe(posted + REFRESH_MINUTES);
  });

  it('posts again when the page changes, and readers take the last copy', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    const renamed = { ...page, name: 'Riverside Tenants' };
    expect(await publishPage({ relay, seal }, DOOR, renamed, fake.minute)).toEqual({
      kind: 'posted',
    });
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'open', page: renamed });
    expect(await publishPage({ relay, seal }, DOOR, { v: 1, open: false }, fake.minute)).toEqual({
      kind: 'posted',
    });
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'closed' });
  });

  it('closes a door once: no closed page where no copy says open, however old the closed one', async () => {
    const { fake, relay, seal } = services();
    const closed = { v: 1, open: false } as const;
    expect(await publishPage({ relay, seal }, DOOR, closed, fake.minute)).toEqual({
      kind: 'current',
      received: fake.minute,
    });
    expect(fake.requests.filter((request) => request.method === 'PUT')).toEqual([]);
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    expect(await publishPage({ relay, seal }, DOOR, closed, fake.minute)).toEqual({
      kind: 'posted',
    });
    const at = fake.minute;
    fake.minute += 3 * REFRESH_MINUTES;
    expect(await publishPage({ relay, seal }, DOOR, closed, fake.minute)).toEqual({
      kind: 'current',
      received: at,
    });
    expect(fake.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
  });

  it('ignores a copy signed by another key, a malformed blob and a page that doesn’t parse', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    const { page: mailbox, pageKey } = doorChannelsOf(address);
    const forged = { ...page, name: 'Somewhere else' };
    const other = newSigningKeys();
    await relay.putBlob(
      mailbox,
      seal.seal(mailbox, pageKey, signDoorRecord(other, encodePage(forged))),
    );
    await relay.putBlob(mailbox, new Uint8Array(1024));
    const keys = doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box)).signing;
    await relay.putBlob(
      mailbox,
      seal.seal(mailbox, pageKey, signDoorRecord(keys, encoder.encode('{"v":9}'))),
    );
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'open', page });
  });

  it('opens nothing from a record that isn’t a page', () => {
    expect(openPage(new Uint8Array(10), address)).toBeNull();
  });
});
