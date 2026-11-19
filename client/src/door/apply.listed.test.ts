/**
 * No personal Documents at a newly listed or held door (#432;
 * docs/spec/listed-doors.md §5.3, ADR-0081's one preventive rule).
 *
 * A fake door keeps whatever it's sent, and a personal Document ties a
 * person to their beliefs, so `apply` itself refuses Documents for a door
 * the shelf lists and first listed under 43,200 relay minutes ago, whatever
 * its caller passes: the form's hiding the picker isn't the guard. The clock
 * here is the fake relay's own (`test/fakeShelf.ts`): the door is listed at
 * one relay minute, and the shelf read 43,199 and 43,200 minutes later.
 */
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import { APPLICATION_INFO, doorChannelsOf, doorKeysOf, openPadded } from '../crypto/door';
import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { createShelf } from '../net/shelf';
import { NEW_LISTING_MINUTES } from '../shelf/fold';
import { createShelfReader, type KeptShelf, type ShelfReader } from '../shelf/read';
import { type NoticeBody, signShelfBody } from '../shelf/record';
import { nameSkeleton } from '../shelf/skeleton';
import { openStore } from '../store/db';
import { COVENANT_HASH, DOOR } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { createFakeShelf, notify, release } from '../test/fakeShelf';
import { freshIndexedDBPerTest } from '../test/idb';
import { apply, listingRemoved, takesDocuments } from './apply';
import { addressOf, type OpenPage } from './page';

freshIndexedDBPerTest();

const ADDRESS = addressOf(DOOR);
const DOOR_ADDRESS = base64url(ADDRESS);
const BOX_SECRET = fromBase64url(DOOR.box);
const SIGNING = doorKeysOf(fromBase64url(DOOR.sign), BOX_SECRET).signing;
const PAGE: OpenPage = {
  v: 1,
  open: true,
  name: 'Riverside Tenants',
  excerpt: 'We keep rents fair.',
  box: base64url(kxPublicKeyOf(BOX_SECRET)),
};
const { inbox: INBOX } = doorChannelsOf(ADDRESS);

/** The relay minute the door is first listed. */
const LISTED_AT = 29_000_000;

const STATEMENT = { title: 'What I stand for', text: 'Fair rents.' };
const WITH_DOCUMENTS = { name: 'Kim', message: 'Hi.', documents: [STATEMENT] };

/** A device's keep for its shelf copy, in memory. */
function memoryKeep() {
  let kept: KeptShelf | undefined;
  return {
    getShelfCopy: () => Promise.resolve(kept),
    keepShelfCopy: (copy: KeptShelf | null) => {
      kept = copy ?? undefined;
      return Promise.resolve();
    },
  };
}

/**
 * A shelf where the door was listed at {@link LISTED_AT} and is read
 * `minutes` later by the fake relay's clock; or one that doesn't list it.
 */
async function shelfAfter(
  minutes: number,
  { listed = true, notices = [] as readonly NoticeBody[] } = {},
): Promise<ShelfReader> {
  const fake = createFakeShelf({ minute: LISTED_AT });
  const shelf = createShelf({ fetch: fake.fetch });
  if (listed) {
    const name = 'Riverside Tenants';
    await shelf.put(
      DOOR_ADDRESS,
      signShelfBody(SIGNING, {
        v: 1,
        kind: 'listing',
        open: true,
        name,
        skeleton: nameSkeleton(name),
        covenant: COVENANT_HASH,
      }),
    );
    await release(shelf, DOOR_ADDRESS);
  }
  fake.minute = LISTED_AT + minutes;
  for (const notice of notices) await notify(shelf, notice);
  return createShelfReader({ shelf, keep: memoryKeep(), now: () => 0 });
}

/** An applicant's services, reading `shelf`. */
async function applicant(shelf: ShelfReader | undefined) {
  const fake = createFakeRelay();
  const store = await openStore('applicant');
  const relay = createRelay({ fetch: fake.fetch });
  const now = () => 1_762_650_000_000;
  return { fake, store, relay, seal: xchachaSeal, now, ...(shelf ? { shelf } : {}) };
}

/** The keys of the one application in the inbox, opened with the door's box secret. */
function sentKeys(requests: readonly { readonly body: Uint8Array | null }[]): string[] {
  const [request] = requests;
  const plaintext = openPadded(
    BOX_SECRET,
    request?.body ?? new Uint8Array(),
    APPLICATION_INFO,
    INBOX,
  );
  const text = new TextDecoder().decode(plaintext ?? new Uint8Array());
  return Object.keys(JSON.parse(text) as Record<string, unknown>);
}

describe('takesDocuments: whether the shelf lets a door take personal Documents', () => {
  it('says no for a door listed 43,199 relay minutes ago, and yes at 43,200', async () => {
    expect(NEW_LISTING_MINUTES).toBe(43_200);
    expect(await takesDocuments(await shelfAfter(43_199), DOOR_ADDRESS)).toBe(false);
    expect(await takesDocuments(await shelfAfter(43_200), DOOR_ADDRESS)).toBe(true);
  });

  it('says yes for a door the shelf doesn’t list, and with no shelf at all', async () => {
    expect(await takesDocuments(await shelfAfter(0, { listed: false }), DOOR_ADDRESS)).toBe(true);
    expect(await takesDocuments(undefined, DOOR_ADDRESS)).toBe(true);
  });

  it('says yes while the relay has no shelf (no steward key), as before #432', async () => {
    const fake = createFakeShelf({ available: false });
    const reader = createShelfReader({
      shelf: createShelf({ fetch: fake.fetch }),
      keep: memoryKeep(),
      now: () => 0,
    });
    expect(await takesDocuments(reader, DOOR_ADDRESS)).toBe(true);
  });
});

describe('a door the steward holds or removes (#489, §6.1)', () => {
  const hold: NoticeBody = {
    v: 1,
    kind: 'notice',
    act: 'hold',
    address: DOOR_ADDRESS,
    clause: 'C2',
  };
  const suspend: NoticeBody = {
    v: 1,
    kind: 'notice',
    act: 'suspend',
    address: DOOR_ADDRESS,
    clause: 'C3',
  };

  it('takes no Documents while a hold on its listing stands, however long it was listed', async () => {
    const shelf = await shelfAfter(43_200, { notices: [hold] });
    expect(await takesDocuments(shelf, DOOR_ADDRESS)).toBe(false);
    expect(await listingRemoved(shelf, DOOR_ADDRESS)).toBeNull();
  });

  it('takes no Documents once suspended, and names the clause its listing was removed under', async () => {
    const shelf = await shelfAfter(43_200, { notices: [suspend] });
    expect(await takesDocuments(shelf, DOOR_ADDRESS)).toBe(false);
    expect(await listingRemoved(shelf, DOOR_ADDRESS)).toBe('C3');
  });

  it('names no removal for a listing that stands, an unlisted door, or with no shelf', async () => {
    expect(await listingRemoved(await shelfAfter(43_200), DOOR_ADDRESS)).toBeNull();
    expect(await listingRemoved(await shelfAfter(0, { listed: false }), DOOR_ADDRESS)).toBeNull();
    expect(await listingRemoved(undefined, DOOR_ADDRESS)).toBeNull();
  });
});

describe('apply at a listed door (§5.3)', () => {
  it('refuses Documents a caller passes for a door listed 43,199 minutes ago: sends and keeps nothing', async () => {
    const services = await applicant(await shelfAfter(43_199));
    expect(await apply(services, ADDRESS, PAGE, WITH_DOCUMENTS)).toBe('failed');
    expect(services.fake.requests).toEqual([]);
    expect(await services.store.listSent()).toEqual([]);
    services.store.close();
  });

  it('sends them once the door was listed 43,200 minutes ago', async () => {
    const services = await applicant(await shelfAfter(43_200));
    expect(await apply(services, ADDRESS, PAGE, WITH_DOCUMENTS)).toBe('sent');
    expect(sentKeys(services.fake.requests)).toEqual(['name', 'message', 'reply', 'documents']);
    services.store.close();
  });

  it('sends an application without Documents to a newly listed door', async () => {
    const services = await applicant(await shelfAfter(0));
    expect(await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.' })).toBe('sent');
    expect(sentKeys(services.fake.requests)).toEqual(['name', 'message', 'reply']);
    services.store.close();
  });

  it('refuses Documents when the shelf can’t be read, since the door may be new', async () => {
    const offline: ShelfReader = { current: () => Promise.reject(new Error('offline')) };
    const services = await applicant(offline);
    expect(await apply(services, ADDRESS, PAGE, WITH_DOCUMENTS)).toBe('failed');
    expect(services.fake.requests).toEqual([]);
    services.store.close();
  });

  it('leaves an unlisted door unchanged: its Documents go, reached by a hand-given link', async () => {
    const services = await applicant(await shelfAfter(0, { listed: false }));
    expect(await apply(services, ADDRESS, PAGE, WITH_DOCUMENTS)).toBe('sent');
    expect(sentKeys(services.fake.requests)).toContain('documents');
    services.store.close();
  });
});
