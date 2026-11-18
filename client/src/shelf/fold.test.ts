/**
 * The shelf's fold (#484, #486, #487; docs/spec/listed-doors.md §4.3): rule
 * 1, the signature; rule 2, the newest listing per address, which a final
 * one outranks; rule 3, the skeleton; and rule 4, name ownership, with its
 * golden vectors in `vectors/ownership.json`. Every other rule is a named
 * `it.todo` in the issue that builds it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { signShelfRecord } from '../crypto/shelf';
import { newSigningKeys, publicKeyOf, type SigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { foldShelf, nameHolder, type ShelfState } from './fold';
import { type ShelfBody, signShelfBody } from './record';
import { nameSkeleton } from './skeleton';

const NOW = 29_000_000;
const COVENANT = base64url(new Uint8Array(32).fill(9));
const OAK = newSigningKeys();
const BIRCH = newSigningKeys();

/** A Dispatch id from a short label, so tests can name them. */
const idOf = (label: string): string => base64url(new Uint8Array(32).fill(label.charCodeAt(1)));

let nextSeq = 0;

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

/** A record as a vector writes it: an open listing, an entry's id label, or a final listing. */
interface VectorRecord {
  readonly seq: number;
  readonly door: string;
  readonly listing?: string;
  readonly skeleton?: string;
  readonly entry?: string;
  readonly final?: true;
}

const [OWNERSHIP] = Object.values(
  import.meta.glob<OwnershipFile>('./vectors/ownership.json', { import: 'default', eager: true }),
);
if (OWNERSHIP === undefined) throw new Error('vectors/ownership.json is missing.');

/** A vector door's keys, from its label: the secret is the label's SHA-256. */
function doorKeys(label: string): SigningKeys {
  const secretKey = sha256(new TextEncoder().encode(`reconcile/vector/ownership/${label}`));
  return { secretKey, publicKey: publicKeyOf(secretKey) };
}

/** A vector's record, signed by its door. */
function recordFrom(vector: VectorRecord): ShelfRecord {
  const keys = doorKeys(vector.door);
  const body: ShelfBody =
    vector.listing !== undefined
      ? {
          v: 1,
          kind: 'listing',
          open: true,
          name: vector.listing,
          skeleton: vector.skeleton ?? nameSkeleton(vector.listing),
          covenant: COVENANT,
        }
      : vector.entry !== undefined
        ? { v: 1, kind: 'entry', id: idOf(vector.entry), title: vector.entry, text: '' }
        : { v: 1, kind: 'listing', open: false, final: true };
  const address = base64url(keys.publicKey);
  return { seq: vector.seq, received: NOW - 100, address, data: signShelfBody(keys, body) };
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

  it('starts empty, with no tombstone and no pause', () => {
    expect(foldShelf([], NOW)).toEqual({
      listings: [],
      entries: [],
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

    it('ignores a signed record that isn’t one of this slice’s kinds', () => {
      const notice = new TextEncoder().encode('{"v":1,"kind":"notice","act":"pause"}');
      const record = { ...listing('Oak St Tenants'), data: signShelfRecord(OAK, notice) };

      expect(foldShelf([record], NOW)).toEqual(foldShelf([], NOW));
    });

    it.todo('ignores a notice the steward key pinned in shelf/steward.ts didn’t sign (#488)');
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

  describe('rules to come', () => {
    it.todo('shows only an address’s first 4 unexpired entries in seq order (#431)');
    it.todo('waits until the relay clock is 1,440 minutes past an entry’s receipt (#431)');
    it.todo('removes an entry its own address withdrew, and no other address’s (#431)');
    it.todo('applies a release notice (#488), and hold, uphold, suspend and pause (#489)');
  });
});
