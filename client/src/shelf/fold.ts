/**
 * The public shelf's fold (#484; ADR-0081; docs/spec/listed-doors.md §4.3).
 *
 * Every device reads the same shelf from the relay and folds it with this
 * pure function, as it folds a group's log, so a seized or faulty relay can
 * withhold records but can't make a device show a forged one. It imports no
 * React and reaches no network.
 *
 * Built here:
 *
 * 1. **Signature.** A record whose signature doesn't verify against the
 *    address it came under, or whose body isn't exactly a listing, entry or
 *    withdraw (`record.ts`), is ignored.
 * 2. **Listings.** Per address, the newest valid listing (highest seq)
 *    stands, and a final one outranks every later copy, as a door's page
 *    does (#486): once a door's listing is final, the address has none, and
 *    no open copy after it, replayed or forged with a key someone kept,
 *    reopens it.
 *
 * An entry shows under its address's standing listing, with that listing's
 * name, newest first, once per address and id. Without a standing listing
 * it shows nowhere: an entry carries no name of its own.
 *
 * Still to come, each with the issue that builds it: skeletons and name
 * ownership (#487); the
 * caps, the day's wait and withdrawals (#431); and the steward's notices,
 * which fill `tombstones` and `paused` (#488, #489). Until then those two
 * stay empty and false, and `now`, the relay minute those rules read, is
 * taken but not read.
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { ShelfRecord } from '../net/shelf';
import { type EntryBody, type OpenListingBody, parseShelfBody, type ShelfBody } from './record';

/** A listing that stands: a listed door's name, as readers see it. */
export interface ShelfListing {
  /** The door's address: its public key in unpadded base64url. */
  readonly address: string;
  readonly name: string;
  /** The hash of the covenant the group accepted. */
  readonly covenant: string;
  /** The seq of the copy that stands. */
  readonly seq: number;
  /** The relay minute that copy arrived. */
  readonly received: number;
}

/** An entry as readers see it: a Dispatch, under its listing's current name. */
export interface ShelfEntry {
  /** The listing's address. */
  readonly address: string;
  /** The Dispatch's id. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** The listing's name. */
  readonly name: string;
  readonly seq: number;
  readonly received: number;
}

/** What an upheld or suspended record leaves in its place (#489). */
export interface ShelfTombstone {
  readonly address: string;
  /** The entry it removed, or null for a whole listing. */
  readonly id: string | null;
  /** The covenant clause it names: `C1`, `C2` or `C3`. */
  readonly clause: string;
}

/** The shelf as a device shows it. */
export interface ShelfState {
  /** The standing listings, oldest standing copy first. */
  readonly listings: readonly ShelfListing[];
  /** The entries that show, newest first. */
  readonly entries: readonly ShelfEntry[];
  /** What the steward removed, in place of each (#489): none yet. */
  readonly tombstones: readonly ShelfTombstone[];
  /** Whether a pause notice stands (#489): never yet. */
  readonly paused: boolean;
}

/**
 * Folds `records` as of relay minute `now`. Any order in which the relay
 * could have served them folds the same: they are taken in seq order.
 */
export type FoldShelf = (records: readonly ShelfRecord[], now: number) => ShelfState;

/** A record whose signature verified and whose body parsed. */
interface Verified {
  readonly record: ShelfRecord;
  readonly body: ShelfBody;
}

/** Rule 1: the record's body, when its address signed it and it parses; else null. */
function verified(record: ShelfRecord): Verified | null {
  const message = verifyShelfRecord(record.data, record.address);
  const body = message === null ? null : parseShelfBody(message);
  return body === null ? null : { record, body };
}

/** Rule 2: each address's newest listing, unless any of its listings is final. */
function standingListings(records: readonly Verified[]): Map<string, ShelfListing> {
  const standing = new Map<string, ShelfListing>();
  const ended = new Set<string>();
  for (const { record, body } of records) {
    if (body.kind !== 'listing') continue;
    if (body.open) standing.set(record.address, listingOf(record, body));
    else ended.add(record.address);
  }
  for (const address of ended) standing.delete(address);
  return standing;
}

/** A standing listing from its record and open body. */
function listingOf(record: ShelfRecord, body: OpenListingBody): ShelfListing {
  const { address, seq, received } = record;
  return { address, name: body.name, covenant: body.covenant, seq, received };
}

/** An entry under `listing`'s name. */
function entryOf(record: ShelfRecord, body: EntryBody, listing: ShelfListing): ShelfEntry {
  const { address, seq, received } = record;
  return {
    address,
    id: body.id,
    title: body.title,
    text: body.text,
    name: listing.name,
    seq,
    received,
  };
}

/** Each entry under a standing listing, the first copy of each address and id, newest first. */
function entriesUnder(
  records: readonly Verified[],
  listings: ReadonlyMap<string, ShelfListing>,
): ShelfEntry[] {
  const shown = new Map<string, ShelfEntry>();
  for (const { record, body } of records) {
    const listing = listings.get(record.address);
    const key = `${record.address} ${body.kind === 'entry' ? body.id : ''}`;
    if (body.kind !== 'entry' || listing === undefined || shown.has(key)) continue;
    shown.set(key, entryOf(record, body, listing));
  }
  return [...shown.values()].reverse();
}

/** The shelf as every device shows it, from the records the relay served (§4.3). */
export const foldShelf: FoldShelf = (records) => {
  const inOrder = [...records].sort((a, b) => a.seq - b.seq);
  const valid = inOrder.map(verified).filter((item) => item !== null);
  const listings = standingListings(valid);
  return {
    listings: [...listings.values()].sort((a, b) => a.seq - b.seq),
    entries: entriesUnder(valid, listings),
    tombstones: [],
    paused: false,
  };
};
