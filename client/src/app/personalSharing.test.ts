/**
 * What a personal Document's editor reads of its share (#105), on a device
 * whose keys may be locked with a passkey (#255): the link while it can be
 * read, the share as on with no link while it can't.
 */
import { describe, expect, it } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { type Group, VaultLocked } from '../store/db';
import type { PersonalDocument, PersonalEntry } from '../store/personal';
import { createFakeRelay } from '../test/fakeRelay';
import { personalSharing, type SharingServices } from './personalSharing';

const ID = 'U2hhcmVkIHN0YXRlbWVudA';
const ENTRY: PersonalEntry = {
  id: ID,
  title: 'Me',
  text: 'Real.\n',
  createdAt: 1,
  updatedAt: 1,
  share: { n: 2, postedAt: 29_000_003, pending: true },
};

/** Thirty days in relay minutes: a share last posted that long ago is idle (#339, #347). */
const TTL_MINUTES = 30 * 1440;

/** Sharing on a store whose whole read fails with `failure`, and whose entries are `entries`. */
function sharingWith(failure: Error, entries: readonly PersonalEntry[]) {
  const store = {
    getPersonal: () => Promise.reject(failure),
    listPersonal: () => Promise.reject(failure),
    updateShare: () => Promise.reject(failure),
    requireUnlocked: () => Promise.reject(failure),
    listPersonalEntries: () => Promise.resolve([...entries]),
    listGroups: () => Promise.reject(failure),
  };
  const services: SharingServices = {
    store,
    relay: createRelay({ fetch: createFakeRelay().fetch }),
    seal: xchachaSeal,
    now: () => 0,
    origin: 'https://reconcile.test',
    share: undefined,
    copyText: () => Promise.resolve(),
  };
  return personalSharing(services);
}

describe('personalSharing.read', () => {
  it('reads a share as on, pending as its mark says, with no link, while the keys are locked', async () => {
    const sharing = sharingWith(new VaultLocked(), [ENTRY]);

    expect(await sharing.read(ID)).toEqual({ link: null, pending: true, paused: null });
  });

  it('reads a share a restore paused as paused while the keys are locked, so no choice is offered (#328)', async () => {
    const paused: PersonalEntry = {
      ...ENTRY,
      share: { n: 2, postedAt: 29_000_003, pending: false, paused: true },
    };

    expect(await sharingWith(new VaultLocked(), [paused]).read(ID)).toEqual({
      link: null,
      pending: false,
      paused: 'restored',
    });
  });

  it('reads a share idle while the keys are locked from its own last read of the relay’s clock (#347)', async () => {
    const read: PersonalEntry = {
      ...ENTRY,
      share: { n: 2, postedAt: 29_000_003, pending: false, seenAt: 29_000_003 + TTL_MINUTES },
    };

    expect(await sharingWith(new VaultLocked(), [read]).read(ID)).toEqual({
      link: null,
      pending: false,
      paused: 'idle',
    });
  });

  it('measures an open share by the relay minute its groups last heard, never the device clock (#347)', async () => {
    const document: PersonalDocument = {
      ...ENTRY,
      share: {
        seed: new Uint8Array(32).fill(1),
        secretKey: new Uint8Array(32).fill(2),
        publicKey: new Uint8Array(32).fill(3),
        n: 2,
        postedAt: 29_000_003,
        pending: false,
      },
    };
    const heardAt = (relayNow: number) =>
      personalSharing({
        store: {
          getPersonal: () => Promise.resolve(document),
          listPersonal: () => Promise.resolve([document]),
          updateShare: () => Promise.resolve(undefined),
          requireUnlocked: () => Promise.resolve(),
          listPersonalEntries: () => Promise.resolve([ENTRY]),
          listGroups: () => Promise.resolve([{ relayNow } as Group]),
        },
        relay: createRelay({ fetch: createFakeRelay().fetch }),
        seal: xchachaSeal,
        // The device clock says a year later: it plays no part.
        now: () => 1_800_000_000_000,
        origin: 'https://reconcile.test',
        share: undefined,
        copyText: () => Promise.resolve(),
      });

    expect((await heardAt(29_000_003 + TTL_MINUTES - 1).read(ID))?.paused).toBeNull();
    expect((await heardAt(29_000_003 + TTL_MINUTES).read(ID))?.paused).toBe('idle');
  });

  it('reads none when the Document has no share by the time it looks', async () => {
    const unshared: PersonalEntry = {
      id: ID,
      title: ENTRY.title,
      text: ENTRY.text,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(await sharingWith(new VaultLocked(), [unshared]).read(ID)).toBeNull();
    expect(await sharingWith(new VaultLocked(), []).read(ID)).toBeNull();
  });

  it('fails with any other error, so the editor offers Share link as it does when it can’t tell', async () => {
    const broken = new Error('IndexedDB refused.');

    await expect(sharingWith(broken, [ENTRY]).read(ID)).rejects.toBe(broken);
  });
});

describe('personalSharing.keep', () => {
  it('says locked, keeping and sending nothing, when the keys are locked (#328, #255)', async () => {
    const sharing = sharingWith(new VaultLocked(), [ENTRY]);

    expect(await sharing.keep(ID)).toBe('locked');
  });
});
