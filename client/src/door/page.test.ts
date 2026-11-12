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
  FINAL,
  isFinal,
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

  it('takes its excerpt from the Document’s first section as it stands, after sections come and go (#75)', () => {
    const log = opened();
    const removal = log.propose('Ana', { atom: 0, text: '', title: 'Drop the first section' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, removal, 4);
    log.minute += 1;
    expect(log.state().atoms.map((atom) => atom.id)).toEqual([`${log.group}.1`]);
    expect(pageFor(log.state(), DOOR, plain).excerpt).toBe('Bins.');
    const added = log.addSection('Ana', null, { text: 'Everyone is **welcome** here.\n' });
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, added, 4);
    log.minute += 1;
    expect(log.state().atoms[0]?.id).toBe(added);
    expect(pageFor(log.state(), DOOR, plain).excerpt).toBe('Everyone is welcome here.\n');
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

  it('write and read a final page, a closed one for good (#288)', () => {
    expect(FINAL).toEqual({ v: 1, open: false, final: true });
    expect(textOf(encodePage(FINAL))).toBe('{"v":1,"open":false,"final":true}');
    expect(parsePage(encodePage(FINAL))).toEqual(FINAL);
    expect(isFinal(FINAL)).toBe(true);
    expect(isFinal({ v: 1, open: false })).toBe(false);
    expect(isFinal(open)).toBe(false);
  });

  it.each([
    ['another version', '{"v":2,"open":false}'],
    ['a closed page with a name', '{"v":1,"open":false,"name":"R"}'],
    ['a final that is not true', '{"v":1,"open":false,"final":false}'],
    ['a final page with a name', '{"v":1,"open":false,"final":true,"name":"R"}'],
    [
      'an open page that says final',
      `{"v":1,"open":true,"name":"R","excerpt":"E","box":"${BOX}","final":true}`,
    ],
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

describe('a final page closes its door for good (#288, #277)', () => {
  const services = (fake = createFakeRelay()) => ({
    fake,
    relay: createRelay({ fetch: fake.fetch }),
    seal: xchachaSeal,
  });
  const address = addressOf(DOOR);
  const page = { v: 1, open: true, name: 'Riverside', excerpt: 'Fair rents.', box: BOX } as const;
  /** The PUTs the fake relay took. */
  const puts = (fake: ReturnType<typeof createFakeRelay>) =>
    fake.requests.filter((request) => request.method === 'PUT');

  /** An open page signed with the door's own key, as anyone holding `sign` could post one. */
  async function postSigned(
    { relay, seal }: Omit<ReturnType<typeof services>, 'fake'>,
    signed: Parameters<typeof encodePage>[0],
  ) {
    const { page: mailbox, pageKey } = doorChannelsOf(address);
    const keys = doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box)).signing;
    await relay.putBlob(
      mailbox,
      seal.seal(mailbox, pageKey, signDoorRecord(keys, encodePage(signed))),
    );
  }

  it('reads closed once any valid copy is final, whatever valid copy comes after it', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    const [genuine] = fake.blobs(doorChannelsOf(address).page);
    expect(await publishPage({ relay, seal }, DOOR, FINAL, fake.minute)).toEqual({
      kind: 'posted',
    });
    // Someone who left holds `sign`: a forged open page with their own box, then a replay of the old one.
    await postSigned({ relay, seal }, { ...page, box: base64url(new Uint8Array(32).fill(0x66)) });
    await relay.putBlob(doorChannelsOf(address).page, Uint8Array.from(genuine ?? []));
    expect(fake.blobs(doorChannelsOf(address).page)).toHaveLength(4);
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'closed' });
    expect((await latestCopy({ relay, seal }, address))?.page).toEqual(FINAL);
  });

  it('still lets the last copy decide while no copy is final, so a narrowing can reopen', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    await publishPage({ relay, seal }, DOOR, { v: 1, open: false }, fake.minute);
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'closed' });
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'open', page });
  });

  it('goes by the newest final copy when there are several', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, FINAL, fake.minute);
    const first = fake.minute;
    fake.minute += REFRESH_MINUTES;
    await publishPage({ relay, seal }, DOOR, FINAL, fake.minute);
    await postSigned({ relay, seal }, page);
    expect(await latestCopy({ relay, seal }, address)).toMatchObject({
      received: first + REFRESH_MINUTES,
      page: FINAL,
    });
  });

  it('posts a final page where no copy is, keeps it while under 7 days old, then posts it again', async () => {
    const { fake, relay, seal } = services();
    expect(await publishPage({ relay, seal }, DOOR, FINAL, fake.minute)).toEqual({
      kind: 'posted',
    });
    const posted = fake.minute;
    fake.minute += REFRESH_MINUTES - 1;
    expect(await publishPage({ relay, seal }, DOOR, FINAL, fake.minute)).toEqual({
      kind: 'current',
      received: posted,
    });
    fake.minute += 1;
    expect(await publishPage({ relay, seal }, DOOR, FINAL, fake.minute)).toEqual({
      kind: 'posted',
    });
    expect(puts(fake)).toHaveLength(2);
  });

  it('posts a final page over an open copy and over a plain closed one', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, page, fake.minute);
    await publishPage({ relay, seal }, DOOR, { v: 1, open: false }, fake.minute);
    expect(await publishPage({ relay, seal }, DOOR, FINAL, fake.minute)).toEqual({
      kind: 'posted',
    });
    expect(puts(fake)).toHaveLength(3);
  });

  it('keeps a plain closed page current beside a final copy, and an open page never', async () => {
    const { fake, relay, seal } = services();
    await publishPage({ relay, seal }, DOOR, FINAL, fake.minute);
    expect(await publishPage({ relay, seal }, DOOR, { v: 1, open: false }, fake.minute)).toEqual({
      kind: 'current',
      received: fake.minute,
    });
    expect(await publishPage({ relay, seal }, DOOR, page, fake.minute)).toEqual({ kind: 'posted' });
    expect(await readDoor({ relay, seal }, address)).toEqual({ kind: 'closed' });
  });
});
