/**
 * The shelf's fold (#484, #486, #487; docs/spec/listed-doors.md §4.3): rule
 * 1, the signature; rule 2, the newest listing per address, which a final
 * one outranks; rule 3, the skeleton; and rule 4, name ownership, with its
 * golden vectors in `vectors/ownership.json`; and rules 5 to 7 (#431), an
 * address's first 4 unexpired entries, the day's wait and withdrawals, with
 * theirs in `vectors/entries.json`; and rule 8's release (#488), with its
 * vectors in `vectors/notices.json`. Every other rule is a named `it.todo` in
 * the issue that builds it.
 *
 * A held relay serves a listing only beside the release that let it show, so
 * rules 1 to 7 fold here through {@link foldShelf} and {@link doorListing},
 * which release every address their records name, as that relay would have.
 * Rule 8's tests fold what they're given ({@link foldAsServed}).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { signShelfRecord } from '../crypto/shelf';
import { newSigningKeys, publicKeyOf, type SigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { releaseRecord, STEWARD_ADDRESS, TEST_STEWARD } from '../test/steward';
import {
  doorListing as doorListingAsServed,
  type FoldShelfOptions,
  foldShelf as foldAsServed,
  nameHolder,
  NEW_LISTING_MINUTES,
  newlyListed,
  type ShelfState,
  waitingListings,
} from './fold';
import { type ShelfBody, signShelfBody } from './record';
import { nameSkeleton } from './skeleton';

const NOW = 29_000_000;
const COVENANT = base64url(new Uint8Array(32).fill(9));
const OAK = newSigningKeys();
const BIRCH = newSigningKeys();
const ELM = newSigningKeys();

/** A Dispatch id from a short label, so tests can name them. */
const idOf = (label: string): string => base64url(new Uint8Array(32).fill(label.charCodeAt(1)));

let nextSeq = 0;

/** The seq the tests' releases take: after every record a test makes. */
const RELEASE_SEQ = 1_000_000;

/** A release of each address `records` came under, but the steward's, as a held relay serves them. */
function releasesOf(records: readonly ShelfRecord[]): ShelfRecord[] {
  const addresses = [...new Set(records.map((record) => record.address))];
  return addresses
    .filter((address) => address !== STEWARD_ADDRESS)
    .map((address, at) => releaseRecord(address, RELEASE_SEQ + at, NOW - 1));
}

/** `records` folded once every address they name is released (rules 1 to 7). */
function foldShelf(records: readonly ShelfRecord[], now: number, options?: FoldShelfOptions) {
  return foldAsServed([...records, ...releasesOf(records)], now, options);
}

/** `address`'s listing among `records`, once every address they name is released. */
function doorListing(
  records: readonly ShelfRecord[],
  address: string,
  since?: ReadonlyMap<string, number>,
) {
  return doorListingAsServed([...records, ...releasesOf(records)], address, since);
}

/** `body` signed by `keys` and stored under `address` (the signer's own, unless given). */
function recordOf(
  keys: SigningKeys,
  body: ShelfBody,
  address = base64url(keys.publicKey),
): ShelfRecord {
  nextSeq += 1;
  return { seq: nextSeq, received: NOW - 2000 + nextSeq, address, data: signShelfBody(keys, body) };
}

/** An open listing under `name` and its skeleton (unless given), from the Oak St door unless told otherwise. */
function listing(name: string, keys = OAK, skeleton = nameSkeleton(name)): ShelfRecord {
  return recordOf(keys, { v: 1, kind: 'listing', open: true, name, skeleton, covenant: COVENANT });
}

/** An entry with `label`'s id and `title`, from the Oak St door unless told otherwise. */
function entry(label: string, title: string, keys = OAK): ShelfRecord {
  return recordOf(keys, { v: 1, kind: 'entry', id: idOf(label), title, text: `About ${title}.` });
}

/** A withdraw of `label`'s id, from the Oak St door unless told otherwise. */
function withdrawal(label: string, keys = OAK): ShelfRecord {
  return recordOf(keys, { v: 1, kind: 'withdraw', id: idOf(label) });
}

/** The final listing of a door that closed. */
function final(keys = OAK): ShelfRecord {
  return recordOf(keys, { v: 1, kind: 'listing', open: false, final: true });
}

/** `vectors/ownership.json`: which listings hold a name, and whose entries show. */
interface OwnershipFile {
  readonly kind: 'ownership';
  readonly cases: readonly {
    readonly about: string;
    readonly records: readonly VectorRecord[];
    readonly listings: readonly (readonly [string, string])[];
    readonly entries: readonly (readonly [string, string])[];
  }[];
}

/**
 * A record as a vector writes it: an open listing, an entry's id label, a
 * withdraw's, or a final listing, received at `received` (else a day and a
 * minute before {@link NOW}).
 */
interface VectorRecord {
  readonly seq: number;
  /** The door that signs it; a notice's signer is the steward, unless `signer` names a door. */
  readonly door?: string;
  readonly received?: number;
  readonly listing?: string;
  readonly skeleton?: string;
  readonly entry?: string;
  readonly withdraw?: string;
  readonly final?: true;
  /** A release naming this door (`vectors/notices.json`). */
  readonly release?: string;
  /** A later notice naming this door, which #489 folds. */
  readonly later?: string;
  /** The door that signs a release in the steward's place, under its own address. */
  readonly signer?: string;
}

/** `vectors/notices.json`: which listings and entries show, and which are held, under rule 8 (#488). */
interface NoticesFile {
  readonly kind: 'notices';
  readonly cases: readonly {
    readonly about: string;
    readonly records: readonly VectorRecord[];
    readonly listings: readonly (readonly [string, string])[];
    readonly entries: readonly (readonly [string, string])[];
    readonly held: readonly string[];
  }[];
}

/** `vectors/entries.json`: which entries show, under rules 5 to 7 (#431). */
interface EntriesFile {
  readonly kind: 'entries';
  readonly cases: readonly {
    readonly about: string;
    readonly now: number;
    /** The doors whose group this device is in. */
    readonly own: readonly string[];
    readonly records: readonly VectorRecord[];
    /** The door, the entry's label and whether it shows early, newest first. */
    readonly entries: readonly (readonly [string, string, boolean])[];
  }[];
}

const [OWNERSHIP] = Object.values(
  import.meta.glob<OwnershipFile>('./vectors/ownership.json', { import: 'default', eager: true }),
);
if (OWNERSHIP === undefined) throw new Error('vectors/ownership.json is missing.');

const [ENTRIES] = Object.values(
  import.meta.glob<EntriesFile>('./vectors/entries.json', { import: 'default', eager: true }),
);
if (ENTRIES === undefined) throw new Error('vectors/entries.json is missing.');

const [NOTICES] = Object.values(
  import.meta.glob<NoticesFile>('./vectors/notices.json', { import: 'default', eager: true }),
);
if (NOTICES === undefined) throw new Error('vectors/notices.json is missing.');

/** A vector door's keys, from its label: the secret is the label's SHA-256. */
function doorKeys(label: string): SigningKeys {
  const secretKey = sha256(new TextEncoder().encode(`reconcile/vector/ownership/${label}`));
  return { secretKey, publicKey: publicKeyOf(secretKey) };
}

/** A vector record's body. */
function bodyFrom(vector: VectorRecord): ShelfBody {
  if (vector.listing !== undefined) {
    const skeleton = vector.skeleton ?? nameSkeleton(vector.listing);
    return {
      v: 1,
      kind: 'listing',
      open: true,
      name: vector.listing,
      skeleton,
      covenant: COVENANT,
    };
  }
  if (vector.entry !== undefined) {
    return { v: 1, kind: 'entry', id: idOf(vector.entry), title: vector.entry, text: '' };
  }
  if (vector.withdraw !== undefined) return { v: 1, kind: 'withdraw', id: idOf(vector.withdraw) };
  return { v: 1, kind: 'listing', open: false, final: true };
}

/** A vector door's address. */
const addressOf = (label: string): string => base64url(doorKeys(label).publicKey);

/** A vector notice's record: signed by the steward under its address, or by `signer` under its own. */
function noticeFrom(vector: VectorRecord, body: ShelfBody): ShelfRecord {
  const keys = vector.signer === undefined ? TEST_STEWARD.signing : doorKeys(vector.signer);
  const address = base64url(keys.publicKey);
  return { seq: vector.seq, received: NOW - 1441, address, data: signShelfBody(keys, body) };
}

/** A vector's record, signed by its door, or a notice signed by the steward. */
function recordFrom(vector: VectorRecord): ShelfRecord {
  if (vector.release !== undefined) {
    const address = addressOf(vector.release);
    return noticeFrom(vector, { v: 1, kind: 'notice', act: 'release', address });
  }
  if (vector.later !== undefined) {
    const address = addressOf(vector.later);
    return noticeFrom(vector, { v: 1, kind: 'notice', act: 'hold', address });
  }
  const keys = doorKeys(vector.door ?? '');
  const address = base64url(keys.publicKey);
  const received = vector.received ?? NOW - 1441;
  return { seq: vector.seq, received, address, data: signShelfBody(keys, bodyFrom(vector)) };
}

/** What `state` shows, by the vectors' door labels and entry titles. */
function shown(state: ShelfState) {
  const labels = new Map(
    ['oak', 'birch', 'elm', 'ash'].map((label) => [base64url(doorKeys(label).publicKey), label]),
  );
  return {
    listings: state.listings.map((l) => [labels.get(l.address), l.name]),
    entries: state.entries.map((e) => [labels.get(e.address), e.title]),
  };
}

describe('foldShelf', () => {
  it('shows an entry under its listing’s name', () => {
    const state = foldShelf([listing('Oak St Tenants'), entry('d1', 'Rent strike vote')], NOW);
    expect(state.entries[0]).toMatchObject({
      id: idOf('d1'),
      name: 'Oak St Tenants',
      title: 'Rent strike vote',
      text: 'About Rent strike vote.',
      address: base64url(OAK.publicKey),
    });
  });

  it('starts empty, with no withdrawal, no tombstone and no pause', () => {
    expect(foldShelf([], NOW)).toEqual({
      listings: [],
      entries: [],
      withdrawn: [],
      tombstones: [],
      paused: false,
    });
  });

  it('lists each live listing once: its name, covenant, and the seq and receipt of that copy', () => {
    const records = [listing('Oak St Tenants'), listing('Birch Ave', BIRCH)];
    const [oak, birch] = records;

    expect(foldShelf(records, NOW).listings).toEqual([
      {
        address: base64url(OAK.publicKey),
        name: 'Oak St Tenants',
        covenant: COVENANT,
        seq: oak?.seq,
        received: oak?.received,
      },
      {
        address: base64url(BIRCH.publicKey),
        name: 'Birch Ave',
        covenant: COVENANT,
        seq: birch?.seq,
        received: birch?.received,
      },
    ]);
  });

  describe('rule 1: signature', () => {
    it('ignores a listing or entry posted under an address that didn’t sign it', () => {
      const oak = base64url(OAK.publicKey);
      const state = foldShelf(
        [
          listing('Oak St Tenants'),
          recordOf(
            BIRCH,
            {
              v: 1,
              kind: 'listing',
              open: true,
              name: 'Oak St Tenants Real',
              skeleton: 'x',
              covenant: COVENANT,
            },
            oak,
          ),
          recordOf(BIRCH, { v: 1, kind: 'entry', id: idOf('f1'), title: 'Forged', text: '' }, oak),
        ],
        NOW,
      );

      expect(state.listings.map((l) => l.name)).toEqual(['Oak St Tenants']);
      expect(state.entries).toEqual([]);
    });

    it('ignores a record with a byte changed', () => {
      const damaged = entry('d1', 'Rent strike vote');
      const data = damaged.data.slice();
      data[data.length - 3] = (data[data.length - 3] ?? 0) ^ 1;

      expect(foldShelf([listing('Oak St Tenants'), { ...damaged, data }], NOW).entries).toEqual([]);
    });

    it('ignores a notice a door signed, as it ignores any record that isn’t its kind', () => {
      const notice = new TextEncoder().encode('{"v":1,"kind":"notice","act":"pause"}');
      const record = { ...listing('Oak St Tenants'), data: signShelfRecord(OAK, notice) };

      expect(foldShelf([record], NOW)).toEqual(foldShelf([], NOW));
    });

    it('ignores a release the steward key pinned in shelf/steward.ts didn’t sign (#488)', () => {
      const oak = base64url(OAK.publicKey);
      const body = { v: 1, kind: 'notice', act: 'release', address: oak } as const;
      const forged = [
        recordOf(OAK, body),
        recordOf(BIRCH, body, STEWARD_ADDRESS),
        { ...releaseRecord(oak, 900, NOW), address: base64url(BIRCH.publicKey) },
      ];

      expect(foldAsServed([listing('Oak St Tenants'), ...forged], NOW).listings).toEqual([]);
      expect(doorListingAsServed([listing('Oak St Tenants'), ...forged], oak)?.held).toBe(true);
    });
  });

  describe('rule 2: listings', () => {
    it('takes the newest listing per address, so its entries show under the new name', () => {
      const state = foldShelf(
        [
          listing('Oak St Tenants'),
          entry('d1', 'Rent strike vote'),
          listing('Oak Street Tenants Union'),
        ],
        NOW,
      );

      expect(state.listings.map((l) => l.name)).toEqual(['Oak Street Tenants Union']);
      expect(state.entries.map((e) => e.name)).toEqual(['Oak Street Tenants Union']);
    });

    it('shows nothing of a door whose newest listing is final', () => {
      const state = foldShelf(
        [listing('Oak St Tenants'), entry('d1', 'Rent strike vote'), final()],
        NOW,
      );

      expect(state.listings).toEqual([]);
      expect(state.entries).toEqual([]);
    });

    it('shows no entry from an address with no listing', () => {
      expect(
        foldShelf([entry('d1', 'Rent strike vote', BIRCH), listing('Oak St Tenants')], NOW).entries,
      ).toEqual([]);
    });

    it('never reopens a listing after its final copy (#486)', () => {
      const state = foldShelf(
        [listing('Oak St Tenants'), final(), listing('Oak St Tenants'), entry('d1', 'Back again')],
        NOW,
      );

      expect(state.listings).toEqual([]);
      expect(state.entries).toEqual([]);
    });

    it('keeps another address listed when one door’s listing is final (#486)', () => {
      const state = foldShelf([final(), listing('Birch Ave', BIRCH), listing('Oak St')], NOW);

      expect(state.listings.map((l) => l.name)).toEqual(['Birch Ave']);
    });
  });

  it('shows entries newest first, each once per address and id', () => {
    const state = foldShelf(
      [
        listing('Oak St Tenants'),
        listing('Birch Ave', BIRCH),
        entry('d1', 'Rent strike vote'),
        entry('d2', 'Garden day', BIRCH),
        entry('d1', 'Rent strike vote'),
        entry('d1', 'Same id, another door', BIRCH),
      ],
      NOW,
    );

    expect(state.entries.map((e) => [e.title, e.name])).toEqual([
      ['Same id, another door', 'Birch Ave'],
      ['Garden day', 'Birch Ave'],
      ['Rent strike vote', 'Oak St Tenants'],
    ]);
  });

  it('folds the same shelf whatever order its records arrive in (fast-check)', () => {
    const records = [
      listing('Oak St Tenants'),
      entry('d1', 'Rent strike vote'),
      listing('Birch Ave', BIRCH),
      entry('d2', 'Garden day', BIRCH),
      listing('Oak Street Tenants Union'),
      final(BIRCH),
    ];
    const folded = foldShelf(records, NOW);
    fc.assert(
      fc.property(fc.shuffledSubarray(records, { minLength: records.length }), (shuffled) => {
        expect(foldShelf(shuffled, NOW)).toEqual(folded);
      }),
    );
  });

  describe('rule 3: skeletons (#487)', () => {
    it('ignores a listing whose skeleton isn’t the one its name makes', () => {
      const state = foldShelf(
        [listing('Oak St Tenants', OAK, 'Oak St Tenants'), entry('d1', 'Rent strike vote')],
        NOW,
      );

      expect(state).toEqual(foldShelf([], NOW));
    });

    it('keeps the copy before one whose skeleton is wrong', () => {
      const state = foldShelf(
        [listing('Oak St Tenants'), listing('Oak Street Tenants', OAK, 'oakstreettenant')],
        NOW,
      );

      expect(state.listings.map((l) => l.name)).toEqual(['Oak St Tenants']);
    });
  });

  describe('rule 4: name ownership (#487)', () => {
    it('shadows a later listing that shares a skeleton, and its entries', () => {
      const state = foldShelf(
        [
          listing('Eastside Tenants Union'),
          listing('EASTSIDE TENANTS UNI0N', BIRCH),
          entry('d2', 'Look at us', BIRCH),
        ],
        NOW,
      );

      expect(state.listings.map((l) => l.address)).toEqual([base64url(OAK.publicKey)]);
      expect(state.entries).toEqual([]);
    });

    it('gives a name tied on seq, as only a faulty relay serves, to the lower address', () => {
      const [oak, birch] = [listing('Oak St Tenants'), listing('0ak St Tenants', BIRCH)];
      const tied = [oak, { ...birch, seq: oak.seq }] as ShelfRecord[];
      const [lower] = [base64url(OAK.publicKey), base64url(BIRCH.publicKey)].sort();

      expect(foldShelf(tied, NOW).listings.map((l) => l.address)).toEqual([lower]);
      expect(foldShelf([...tied].reverse(), NOW).listings.map((l) => l.address)).toEqual([lower]);
    });

    it('gives a name to the same listing whatever order the records arrive in (fast-check)', () => {
      const records = [
        listing('Eastside Tenants Union'),
        listing('Еastside Tenants Union', BIRCH),
        entry('d2', 'Look at us', BIRCH),
        listing('EASTSIDE TENANTS UNION'),
        entry('d1', 'Rent strike vote'),
        listing('Birch Ave', BIRCH),
        listing('Eastside Tenants-Union', BIRCH),
      ];
      const folded = foldShelf(records, NOW);
      expect(folded.listings.map((l) => l.name)).toEqual(['EASTSIDE TENANTS UNION']);
      fc.assert(
        fc.property(fc.shuffledSubarray(records, { minLength: records.length }), (shuffled) => {
          expect(foldShelf(shuffled, NOW)).toEqual(folded);
        }),
      );
    });
  });

  describe('nameHolder: the listing a new listing under a name would sit behind', () => {
    const shelf = foldShelf([listing('Eastside Tenants Union'), listing('Birch Ave', BIRCH)], NOW);
    const oak = base64url(OAK.publicKey);

    it('finds the listing that holds a name like it', () => {
      expect(nameHolder(shelf, 'EASTSIDE TENANTS UNI0N', null)?.address).toBe(oak);
    });

    it('finds none for a name no listing holds', () => {
      expect(nameHolder(shelf, 'Westside Tenants Union', null)).toBeNull();
    });

    it('passes over the address it is asked about, so a door never sits behind itself', () => {
      expect(nameHolder(shelf, 'Eastside Tenants Union', oak)).toBeNull();
    });
  });

  describe('vectors/ownership.json', () => {
    it.each(OWNERSHIP.cases.map((vector) => [vector.about, vector] as const))('%s', (_, vector) => {
      const state = foldShelf(vector.records.map(recordFrom), NOW);
      expect(shown(state)).toEqual({ listings: vector.listings, entries: vector.entries });
    });
  });

  describe('rule 5: an address’s first 4 unexpired entries (#431)', () => {
    it('shows only an address’s first 4 entries in seq order', () => {
      const records = [
        listing('Oak St Tenants'),
        ...['d1', 'd2', 'd3', 'd4', 'd5'].map((label) => entry(label, label)),
        listing('Birch Ave', BIRCH),
        entry('d6', 'd6', BIRCH),
      ];

      expect(foldShelf(records, NOW).entries.map((e) => e.title)).toEqual([
        'd6',
        'd4',
        'd3',
        'd2',
        'd1',
      ]);
    });

    it('counts a repeated id once, at its first copy', () => {
      const records = [
        listing('Oak St Tenants'),
        entry('d1', 'd1'),
        entry('d1', 'd1'),
        entry('d2', 'd2'),
        entry('d3', 'd3'),
        entry('d4', 'd4'),
      ];

      expect(foldShelf(records, NOW).entries.map((e) => e.title)).toEqual(['d4', 'd3', 'd2', 'd1']);
    });

    it('drops an entry on the relay day its 30 days end, and lets the fifth take its place', () => {
      const today = Math.floor(NOW / 1440);
      // The last minute of the day 30 days back: it is kept through today, and gone tomorrow.
      const first = { ...entry('d1', 'd1'), received: (today - 30) * 1440 + 1439 };
      const records = [
        listing('Oak St Tenants'),
        first,
        ...['d2', 'd3', 'd4', 'd5'].map((label) => entry(label, label)),
      ];
      const lastDay = (today + 1) * 1440 - 1;

      expect(foldShelf(records, lastDay).entries.map((e) => e.title)).toEqual([
        'd4',
        'd3',
        'd2',
        'd1',
      ]);
      expect(foldShelf(records, lastDay + 1).entries.map((e) => e.title)).toEqual([
        'd5',
        'd4',
        'd3',
        'd2',
      ]);
    });

    it('shows no entry of a shadowed listing, and counts none of them against another', () => {
      const records = [
        listing('Eastside Tenants Union'),
        listing('EASTSIDE TENANTS UNI0N', BIRCH),
        ...['d1', 'd2', 'd3', 'd4'].map((label) => entry(label, label, BIRCH)),
        entry('d5', 'd5'),
      ];

      expect(foldShelf(records, NOW).entries.map((e) => e.title)).toEqual(['d5']);
    });

    it('keeps the cap whatever order the records arrive in (fast-check)', () => {
      const records = [
        listing('Oak St Tenants'),
        ...['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((label) => entry(label, label)),
        withdrawal('d2'),
        entry('d1', 'again'),
      ];
      const folded = foldShelf(records, NOW);
      expect(folded.entries.map((e) => e.title)).toEqual(['d5', 'd4', 'd3', 'd1']);
      fc.assert(
        fc.property(fc.shuffledSubarray(records, { minLength: records.length }), (shuffled) => {
          expect(foldShelf(shuffled, NOW)).toEqual(folded);
        }),
      );
    });

    it('never shows more than 4 entries an address posted, whichever it posted (fast-check)', () => {
      const posted = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((label) => entry(label, label));
      fc.assert(
        fc.property(fc.subarray(posted), (some) => {
          const shown = foldShelf([listing('Oak St Tenants'), ...some], NOW).entries;
          expect(shown.map((e) => e.seq)).toEqual(
            some
              .map((r) => r.seq)
              .slice(0, 4)
              .reverse(),
          );
        }),
      );
    });
  });

  describe('rule 6: the day’s wait (#431)', () => {
    it('holds a new entry back until a relay day has passed', () => {
      const records = [listing('Oak St'), { ...entry('d1', 'Rent strike vote'), received: 1000 }];
      expect(foldShelf(records, 1000 + 1439).entries).toEqual([]);
      expect(foldShelf(records, 1000 + 1440).entries.map(({ id }) => id)).toEqual([idOf('d1')]);
    });

    it('shows its own group’s entry at once, marked early, until the day has passed', () => {
      const records = [listing('Oak St'), { ...entry('d1', 'Rent strike vote'), received: 1000 }];
      const own = new Set([base64url(OAK.publicKey)]);

      expect(foldShelf(records, 1000, { own }).entries.map((e) => e.early)).toEqual([true]);
      expect(foldShelf(records, 1000 + 1439, { own }).entries.map((e) => e.early)).toEqual([true]);
      expect(foldShelf(records, 1000 + 1440, { own }).entries.map((e) => e.early)).toEqual([false]);
      expect(
        foldShelf(records, 1000, { own: new Set([base64url(BIRCH.publicKey)]) }).entries,
      ).toEqual([]);
    });

    it('counts an entry still waiting against its address’s 4', () => {
      const records = [
        listing('Oak St Tenants'),
        ...['d1', 'd2', 'd3'].map((label) => entry(label, label)),
        { ...entry('d4', 'd4'), received: NOW },
        entry('d5', 'd5'),
      ];

      expect(foldShelf(records, NOW).entries.map((e) => e.title)).toEqual(['d3', 'd2', 'd1']);
    });
  });

  describe('rule 7: withdrawals (#431)', () => {
    it('removes an entry its own address withdrew, wherever the withdraw falls', () => {
      const before = [listing('Oak St Tenants'), withdrawal('d1'), entry('d1', 'Stray')];
      const after = [listing('Oak St Tenants'), entry('d1', 'Stray'), withdrawal('d1')];

      expect(foldShelf(before, NOW).entries).toEqual([]);
      expect(foldShelf(after, NOW).entries).toEqual([]);
    });

    it('removes no other address’s entry', () => {
      const records = [
        listing('Oak St Tenants'),
        listing('Birch Ave', BIRCH),
        entry('d1', 'Oak’s'),
        entry('d1', 'Birch’s', BIRCH),
        withdrawal('d1', BIRCH),
        recordOf(BIRCH, { v: 1, kind: 'withdraw', id: idOf('d1') }, base64url(OAK.publicKey)),
      ];

      expect(foldShelf(records, NOW).entries.map((e) => e.title)).toEqual(['Oak’s']);
    });

    it('lists what each address withdrew, with the withdrawn entry’s title', () => {
      const records = [
        listing('Oak St Tenants'),
        entry('d1', 'Stray'),
        withdrawal('d1'),
        withdrawal('d9'),
      ];

      expect(foldShelf(records, NOW).withdrawn).toEqual([
        { address: base64url(OAK.publicKey), id: idOf('d1'), title: 'Stray' },
      ]);
    });

    it('frees the withdrawn entry’s place among the first 4', () => {
      const records = [
        listing('Oak St Tenants'),
        ...['d1', 'd2', 'd3', 'd4', 'd5'].map((label) => entry(label, label)),
        withdrawal('d1'),
      ];

      expect(foldShelf(records, NOW).entries.map((e) => e.title)).toEqual(['d5', 'd4', 'd3', 'd2']);
    });
  });

  describe('Listed since (§5.2)', () => {
    it('is the earliest receipt this device read of the listing, or the standing copy’s', () => {
      const records = [listing('Oak St Tenants'), entry('d1', 'Rent strike vote')];
      const oak = base64url(OAK.publicKey);
      const standing = records[0]?.received ?? 0;

      expect(foldShelf(records, NOW).entries[0]?.listedSince).toBe(standing);
      const since = new Map([[oak, standing - 50_000]]);
      expect(foldShelf(records, NOW, { since }).entries[0]?.listedSince).toBe(standing - 50_000);
      const later = new Map([[oak, standing + 5]]);
      expect(foldShelf(records, NOW, { since: later }).entries[0]?.listedSince).toBe(standing);
    });
  });

  describe('a door’s listing, for its application form (§5.3, #432)', () => {
    const oak = base64url(OAK.publicKey);

    it('is null for an address with no standing listing: an unlisted door', () => {
      expect(doorListing([], oak)).toBeNull();
      expect(doorListing([listing('Birch Ave', BIRCH)], oak)).toBeNull();
    });

    it('is null once the door’s listing is final', () => {
      expect(doorListing([listing('Oak St Tenants'), final()], oak)).toBeNull();
    });

    it('ignores a listing its address didn’t sign', () => {
      const forged = recordOf(
        BIRCH,
        { v: 1, kind: 'listing', open: true, name: 'Oak', skeleton: 'oak', covenant: COVENANT },
        oak,
      );
      expect(doorListing([forged], oak)).toBeNull();
    });

    it('counts a shadowed listing as listed: it stands, though its name is another’s', () => {
      const records = [listing('Oak St Tenants', BIRCH), listing('Oak St Tenants')];
      expect(foldShelf(records, NOW).listings.map((l) => l.address)).not.toContain(oak);
      expect(doorListing(records, oak)).not.toBeNull();
    });

    it('is listed since the earliest receipt this device read there, or the standing copy’s', () => {
      const records = [listing('Oak St Tenants')];
      const standing = records[0]?.received ?? 0;

      expect(doorListing(records, oak)).toEqual({ listedSince: standing, held: false });
      const since = new Map([[oak, standing - 50_000]]);
      expect(doorListing(records, oak, since)?.listedSince).toBe(standing - 50_000);
      const later = new Map([[oak, standing + 5]]);
      expect(doorListing(records, oak, later)?.listedSince).toBe(standing);
    });

    it('is new for 43,200 relay minutes: new at 43,199, no longer at 43,200', () => {
      expect(NEW_LISTING_MINUTES).toBe(43_200);
      const listed = { listedSince: NOW, held: false };
      expect(newlyListed(listed, NOW)).toBe(true);
      expect(newlyListed(listed, NOW + 43_199)).toBe(true);
      expect(newlyListed(listed, NOW + 43_200)).toBe(false);
    });

    it('is new while held, however old, and never for an unlisted door', () => {
      expect(newlyListed({ listedSince: 0, held: true }, NOW)).toBe(true);
      expect(newlyListed(null, NOW)).toBe(false);
    });

    it('is held until a release the pinned key signed names it (#488)', () => {
      const oak = base64url(OAK.publicKey);
      const records = [listing('Oak St Tenants')];

      expect(doorListingAsServed(records, oak)?.held).toBe(true);
      expect(newlyListed(doorListingAsServed(records, oak), NOW + 99_999)).toBe(true);
      const released = [...records, releaseRecord(oak, 900, NOW)];
      expect(doorListingAsServed(released, oak)?.held).toBe(false);
      const other = [...records, releaseRecord(base64url(BIRCH.publicKey), 900, NOW)];
      expect(doorListingAsServed(other, oak)?.held).toBe(true);
    });

    it.todo('is held while a hold notice stands on its address (#489: holds aren’t folded yet)');
  });

  describe('vectors/entries.json', () => {
    it.each(ENTRIES.cases.map((vector) => [vector.about, vector] as const))('%s', (_, vector) => {
      const own = new Set(vector.own.map((label) => base64url(doorKeys(label).publicKey)));
      const state = foldShelf(vector.records.map(recordFrom), vector.now, { own });
      expect(shown(state).entries).toEqual(vector.entries.map(([door, id]) => [door, id]));
      expect(state.entries.map((e) => e.early)).toEqual(vector.entries.map(([, , early]) => early));
    });
  });

  describe('vectors/notices.json', () => {
    it.each(NOTICES.cases.map((vector) => [vector.about, vector] as const))('%s', (_, vector) => {
      const records = vector.records.map(recordFrom);
      const state = foldAsServed(records, NOW);
      const held = ['oak', 'birch'].filter(
        (label) => doorListingAsServed(records, addressOf(label))?.held === true,
      );
      expect(shown(state)).toEqual({ listings: vector.listings, entries: vector.entries });
      expect(held).toEqual(vector.held);
    });

    it('folds any order the relay could serve the same', () => {
      const [richest] = NOTICES.cases.filter((vector) => vector.records.length >= 6);
      const records = (richest?.records ?? []).map(recordFrom);
      const folded = foldAsServed(records, NOW);
      fc.assert(
        fc.property(fc.shuffledSubarray(records, { minLength: records.length }), (shuffled) => {
          expect(foldAsServed(shuffled, NOW)).toEqual(folded);
        }),
      );
    });
  });

  describe('waitingListings: the steward’s console (#488, §6.4)', () => {
    const oak = base64url(OAK.publicKey);
    const birch = base64url(BIRCH.publicKey);

    it('lists each held address’s newest listing in seq order, beside the live holder of its name', () => {
      const live = foldShelf([listing('Eastside Tenants Union', BIRCH)], NOW);
      const held = [
        listing('Oak St Tenants'),
        listing('Elm Co-op', ELM),
        listing('EASTSIDE TENANTS UNI0N'),
        entry('d1', 'Rent strike vote'),
      ];

      const waiting = waitingListings(held, live);

      expect(waiting.map(({ listing: l }) => [l.address, l.name])).toEqual([
        [base64url(ELM.publicKey), 'Elm Co-op'],
        [oak, 'EASTSIDE TENANTS UNI0N'],
      ]);
      expect(waiting[0]?.holder).toBeNull();
      expect(waiting[1]?.holder?.address).toBe(birch);
    });

    it('leaves out a forged, misnamed or ended listing', () => {
      const forged = recordOf(
        BIRCH,
        { v: 1, kind: 'listing', open: true, name: 'Oak', skeleton: 'oak', covenant: COVENANT },
        oak,
      );
      const held = [forged, listing('Birch Ave', BIRCH, 'other'), listing('Elm', ELM), final(ELM)];

      expect(waitingListings(held, foldShelf([], NOW))).toEqual([]);
    });
  });

  describe('rules to come', () => {
    it.todo('applies hold, uphold, suspend and pause notices (#489)');
  });
});
