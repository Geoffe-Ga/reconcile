/**
 * The shelf's fold (#484, #486; docs/spec/listed-doors.md §4.3): rule 1, the
 * signature, and rule 2, the newest listing per address, which a final one
 * outranks. Every other rule is a named `it.todo` in the issue that builds it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { signShelfRecord } from '../crypto/shelf';
import { newSigningKeys, type SigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { foldShelf } from './fold';
import { type ShelfBody, signShelfBody } from './record';

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

/** An open listing under `name`, from the Oak St door unless told otherwise. */
function listing(name: string, keys = OAK): ShelfRecord {
  return recordOf(keys, {
    v: 1,
    kind: 'listing',
    open: true,
    name,
    skeleton: name,
    covenant: COVENANT,
  });
}

/** An entry with `label`'s id and `title`, from the Oak St door unless told otherwise. */
function entry(label: string, title: string, keys = OAK): ShelfRecord {
  return recordOf(keys, { v: 1, kind: 'entry', id: idOf(label), title, text: `About ${title}.` });
}

/** The final listing of a door that closed. */
function final(keys = OAK): ShelfRecord {
  return recordOf(keys, { v: 1, kind: 'listing', open: false, final: true });
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

  describe('rules to come', () => {
    it.todo('ignores a listing whose skeleton isn’t the one its name makes (#487)');
    it.todo('shadows a later listing that shares a skeleton, and its entries (#487)');
    it.todo('shows only an address’s first 4 unexpired entries in seq order (#431)');
    it.todo('waits until the relay clock is 1,440 minutes past an entry’s receipt (#431)');
    it.todo('removes an entry its own address withdrew, and no other address’s (#431)');
    it.todo('applies a release notice (#488), and hold, uphold, suspend and pause (#489)');
  });
});
