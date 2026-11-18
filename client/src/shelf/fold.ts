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
 *    address it came under, or whose body isn't exactly a listing, entry,
 *    withdraw or notice (`record.ts`), is ignored. A notice counts only
 *    under the steward's address pinned in `steward.ts` (`notices.ts`, #488).
 * 2. **Listings.** Per address, the newest valid listing (highest seq)
 *    stands, and a final one outranks every later copy, as a door's page
 *    does (#486): once a door's listing is final, the address has none, and
 *    no open copy after it, replayed or forged with a key someone kept,
 *    reopens it.
 * 3. **Skeletons** (#487). The device recomputes a listing's skeleton from
 *    its name (`skeleton.ts`). A listing whose `skeleton` differs is ignored,
 *    as if it were never posted, so the copy before it stands.
 * 4. **Name ownership** (#487). Among standing listings that share a
 *    skeleton, the one with the lowest claim holds the name, and the others
 *    are shadowed: neither they nor their entries show. A door claims its
 *    skeleton from the first copy of its newest unbroken run of listings
 *    under it, so a refresh or a respelling with the same skeleton keeps the
 *    claim, while a door that renames into a name another door holds claims
 *    it only from the rename. A tie, which only a faulty relay serves, goes
 *    to the lower address, so no order of arrival changes who holds a name.
 *
 * 5. **Entries** (#431). An entry shows under its address's standing
 *    listing, with that listing's name, newest first, once per address and
 *    id (its first copy). Without a standing listing that holds its name it
 *    shows nowhere: an entry carries no name of its own. It stands only as
 *    one of its address's first {@link ENTRIES_SHOWN} unexpired entries in
 *    seq order, withdrawn ones left out, as the relay counts its live ones.
 *    An entry expires as the relay's does: on the relay day 31 days after
 *    the day it arrived ({@link ENTRY_KEEP_DAYS}).
 * 6. **The day's wait** (#431). An entry shows once relay minute `now` is
 *    {@link ENTRY_WAIT_MINUTES} past its `received`. On a device in its
 *    group (`own`, the addresses of the device's own listed doors) it shows
 *    at once, marked `early` until then: "Shows publicly tomorrow".
 * 7. **Withdrawals** (#431). A withdraw removes the entry it names under its
 *    own address only, whichever comes first in seq order, since a record's
 *    signature ties it to the address it came under. `withdrawn` lists each
 *    withdrawn entry that still verifies, so Group home can say a stray was
 *    taken down.
 *
 * 8. **Notices** (#488, #489; `notices.ts`). A listing stands only once a
 *    release the pinned steward key signed names its address: the relay
 *    holds every new listing until the steward releases it, and every
 *    device checks the release itself, so a relay that served an unreleased
 *    listing still couldn't show it. An unreleased listing claims no name
 *    and shows no entries. Then:
 *    - a **hold** hides its entry, or its listing and every entry under it,
 *      until {@link HOLD_MINUTES} relay minutes after the notice arrived;
 *      a held listing keeps its name, so no look-alike shows in its place
 *      meanwhile, and `holds` lists each hold that stands, for Group home;
 *    - an **uphold** hides its entry for good, and leaves a tombstone in its
 *      place until the entry's 30 days end, counted from the entry's own
 *      receipt when this device read it, else from the notice's (an entry
 *      always arrives before its uphold, so that can only end sooner);
 *    - a **suspend** ends its address's listing, with its name and entries,
 *      and, once its listing had been released, leaves a tombstone for 30
 *      relay days, as long as a listing that posts nothing more is kept;
 *    - a **pause** that is on sets `paused`, and every screen that shows
 *      the shelf to readers then shows one line in its place (Discover, an
 *      entry's page); the steward's console still lists what stands.
 *    A tombstone names a clause, never a reporter (ADR-0013).
 *
 * A device reads only what the relay serves, and a held relay serves no
 * record of a listing before its release: on an honest relay every listing
 * a reader sees came with its release. `doorListing`'s `held` is true only
 * for a listing a device sees without one (the steward's console reads
 * held records on purpose).
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { ShelfRecord } from '../net/shelf';
import {
  foldNotices,
  HOLD_MINUTES,
  holdOn,
  holdStands,
  isHeld,
  type NoticeHold,
  type NoticeState,
} from './notices';
import {
  type Clause,
  type EntryBody,
  type OpenListingBody,
  parseShelfBody,
  type ShelfBody,
} from './record';
import { nameSkeleton } from './skeleton';

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
  /** Whether it shows only to its own group yet: "Shows publicly tomorrow" (rule 6). */
  readonly early: boolean;
  /** The earliest relay minute this device read of its listing: "Listed since" (§5.2). */
  readonly listedSince: number;
}

/** An entry its own address withdrew (rule 7): what Group home names when its log didn't make it. */
export interface ShelfWithdrawn {
  readonly address: string;
  readonly id: string;
  readonly title: string;
}

/** What an upheld or suspended record leaves in its place (#489). */
export interface ShelfTombstone {
  readonly address: string;
  /** The entry it removed, or null for a whole listing. */
  readonly id: string | null;
  /** The covenant clause it names: `C1`, `C2` or `C3`. */
  readonly clause: Clause;
  /** Its place in the shelf's order: the entry's seq when this device read it, else the notice's. */
  readonly seq: number;
}

/** A hold that stands (#489): what it hides, why, and the relay minute it lapses. */
export type ShelfHold = NoticeHold;

/** The shelf as a device shows it. */
export interface ShelfState {
  /** The standing listings that hold their names, oldest standing copy first. */
  readonly listings: readonly ShelfListing[];
  /** The entries that show, newest first. */
  readonly entries: readonly ShelfEntry[];
  /** The entries their own addresses withdrew, in seq order (rule 7). */
  readonly withdrawn: readonly ShelfWithdrawn[];
  /** What the steward removed, in place of each, newest first (#489). */
  readonly tombstones: readonly ShelfTombstone[];
  /** Each hold that stands, in seq order (#489): Group home names its own. */
  readonly holds: readonly ShelfHold[];
  /** Whether a pause notice stands (#489): no screen shows a reader an entry or tombstone meanwhile. */
  readonly paused: boolean;
}

/** What a device adds to the fold of the shelf every device reads alike. */
export interface FoldShelfOptions {
  /** The addresses of the listed doors of groups this device is in: their entries show at once (rule 6). */
  readonly own?: ReadonlySet<string>;
  /** The earliest relay minute this device read of each address's listing (§5.2, `read.ts`). */
  readonly since?: ReadonlyMap<string, number>;
}

/**
 * Folds `records` as of relay minute `now`. Any order in which the relay
 * could have served them folds the same: they are taken in seq order.
 */
export type FoldShelf = (
  records: readonly ShelfRecord[],
  now: number,
  options?: FoldShelfOptions,
) => ShelfState;

/** The entries an address shows at most (rule 5), as the relay keeps at most 4 live. */
export const ENTRIES_SHOWN = 4;

/** Relay minutes before an entry shows publicly (rule 6): a relay day. */
export const ENTRY_WAIT_MINUTES = 1440;

/** Whole relay days an entry is kept after the day it arrived, as the relay's `SHELF_KEEP_DAYS`. */
export const ENTRY_KEEP_DAYS = 30;

/** Whether an entry received at `received` has expired by relay minute `now`, as the relay counts. */
export const entryExpired = (received: number, now: number): boolean =>
  Math.floor(now / ENTRY_WAIT_MINUTES) >=
  Math.floor(received / ENTRY_WAIT_MINUTES) + ENTRY_KEEP_DAYS + 1;

/** A record whose signature verified and whose body parsed. */
interface Verified {
  readonly record: ShelfRecord;
  readonly body: ShelfBody;
}

/** Whether `body` is an open listing whose skeleton isn't its name's (rule 3). */
const misnamed = (body: ShelfBody): boolean =>
  body.kind === 'listing' && body.open && body.skeleton !== nameSkeleton(body.name);

/**
 * Rules 1 and 3: the record's body, when its address signed it, it parses
 * and, for an open listing, its skeleton is its name's; else null.
 */
function verified(record: ShelfRecord): Verified | null {
  const message = verifyShelfRecord(record.data, record.address);
  const body = message === null ? null : parseShelfBody(message);
  return body === null || misnamed(body) ? null : { record, body };
}

/** An address's standing listing, its skeleton, and the seq its claim to that skeleton starts. */
interface Claim {
  readonly listing: ShelfListing;
  readonly skeleton: string;
  readonly since: number;
}

/**
 * Rule 2: each address's newest listing, unless any of its listings is
 * final, with the seq that started its run under that skeleton (rule 4).
 */
function standingClaims(records: readonly Verified[]): Map<string, Claim> {
  const standing = new Map<string, Claim>();
  const ended = new Set<string>();
  for (const { record, body } of records) {
    if (body.kind !== 'listing') continue;
    if (!body.open) {
      ended.add(record.address);
      continue;
    }
    const before = standing.get(record.address);
    const since = before?.skeleton === body.skeleton ? before.since : record.seq;
    standing.set(record.address, {
      listing: listingOf(record, body),
      skeleton: body.skeleton,
      since,
    });
  }
  for (const address of ended) standing.delete(address);
  return standing;
}

/** Whether `claim` comes before `other`: the lower seq, then the lower address. */
const earlier = (claim: Claim, other: Claim): boolean =>
  claim.since !== other.since
    ? claim.since < other.since
    : claim.listing.address < other.listing.address;

/** Rule 8: the claims of the addresses a release names and no suspend ends; the rest wait unseen. */
function releasedOnly(
  claims: ReadonlyMap<string, Claim>,
  notices: NoticeState,
): Map<string, Claim> {
  const suspended = new Set(notices.suspended.map(({ address }) => address));
  return new Map(
    [...claims].filter(([address]) => notices.released.has(address) && !suspended.has(address)),
  );
}

/** Rule 4: the listings that hold their skeletons, by address. */
function holders(claims: ReadonlyMap<string, Claim>): Map<string, ShelfListing> {
  const bySkeleton = new Map<string, Claim>();
  for (const claim of claims.values()) {
    const held = bySkeleton.get(claim.skeleton);
    if (held === undefined || earlier(claim, held)) bySkeleton.set(claim.skeleton, claim);
  }
  return new Map([...bySkeleton.values()].map(({ listing }) => [listing.address, listing]));
}

/** A standing listing from its record and open body. */
function listingOf(record: ShelfRecord, body: OpenListingBody): ShelfListing {
  const { address, seq, received } = record;
  return { address, name: body.name, covenant: body.covenant, seq, received };
}

/** An entry an address posted, and the relay minute it arrived. */
export interface PostedEntry {
  readonly body: EntryBody;
  readonly received: number;
}

/** An entry the fold reads: a verified entry record and its body. */
interface Posted {
  readonly record: ShelfRecord;
  readonly body: EntryBody;
}

/** The key of an address's entry: its address and id. */
const keyOf = (address: string, id: string): string => `${address} ${id}`;

/**
 * Rules 5 and 7: each address's first copy of each id, unexpired at `now`,
 * in seq order, split into those its address withdrew and those it didn't.
 */
function entriesAt(records: readonly Verified[], now: number) {
  const pulled = new Set<string>();
  for (const { record, body } of records) {
    if (body.kind === 'withdraw') pulled.add(keyOf(record.address, body.id));
  }
  const firsts = new Map<string, Posted>();
  for (const { record, body } of records) {
    if (body.kind !== 'entry' || entryExpired(record.received, now)) continue;
    const key = keyOf(record.address, body.id);
    if (!firsts.has(key)) firsts.set(key, { record, body });
  }
  const posted = [...firsts.entries()];
  return {
    live: posted.filter(([key]) => !pulled.has(key)).map(([, item]) => item),
    withdrawn: posted.filter(([key]) => pulled.has(key)).map(([, item]) => item),
  };
}

/** The first {@link ENTRIES_SHOWN} of each address's live entries, in seq order (rule 5). */
function firstFourEach(live: readonly Posted[]): Posted[] {
  const counts = new Map<string, number>();
  return live.filter(({ record }) => {
    const count = counts.get(record.address) ?? 0;
    counts.set(record.address, count + 1);
    return count < ENTRIES_SHOWN;
  });
}

/**
 * Each entry that shows at `now`, under its listing's name, newest first
 * (rules 5 and 6); a held one still counts toward its address's 4, as the
 * relay counts it, but doesn't show (rule 8).
 */
function entriesUnder(
  live: readonly Posted[],
  listings: ReadonlyMap<string, ShelfListing>,
  now: number,
  { own, since, notices }: FoldShelfOptions & { readonly notices: NoticeState },
): ShelfEntry[] {
  const shown: ShelfEntry[] = [];
  for (const { record, body } of firstFourEach(live)) {
    const listing = listings.get(record.address);
    const early = now - record.received < ENTRY_WAIT_MINUTES;
    if (listing === undefined || (early && own?.has(record.address) !== true)) continue;
    if (isHeld(notices, record.address, body.id, now)) continue;
    const { address, seq, received } = record;
    const first = Math.min(listing.received, since?.get(address) ?? Infinity);
    shown.push({
      address,
      id: body.id,
      title: body.title,
      text: body.text,
      name: listing.name,
      seq,
      received,
      early,
      listedSince: first,
    });
  }
  return shown.reverse();
}

/** The first copy of each address's entry among `valid`, by address and id. */
function firstEntries(valid: readonly Verified[]): Map<string, ShelfRecord> {
  const firsts = new Map<string, ShelfRecord>();
  for (const { record, body } of valid) {
    const key = body.kind === 'entry' ? keyOf(record.address, body.id) : null;
    if (key !== null && !firsts.has(key)) firsts.set(key, record);
  }
  return firsts;
}

/**
 * Rule 8's tombstones for upheld entries, under a listing that shows, until
 * each entry's 30 days end: from its own receipt when this device read it,
 * else from the uphold's.
 */
function upheldTombstones(
  notices: NoticeState,
  valid: readonly Verified[],
  listings: ReadonlyMap<string, ShelfListing>,
  now: number,
): ShelfTombstone[] {
  const firsts = firstEntries(valid);
  return notices.upheld.flatMap(({ address, id, clause, seq, received }) => {
    const entry = firsts.get(keyOf(address, id ?? ''));
    const since = entry?.received ?? received;
    if (!listings.has(address) || entryExpired(since, now)) return [];
    return [{ address, id, clause, seq: entry?.seq ?? seq }];
  });
}

/** Rule 8's tombstones for suspended listings a release had let show, for 30 relay days. */
function suspendedTombstones(notices: NoticeState, now: number): ShelfTombstone[] {
  return notices.suspended
    .filter(
      ({ address, received }) => notices.released.has(address) && !entryExpired(received, now),
    )
    .map(({ address, clause, seq }) => ({ address, id: null, clause, seq }));
}

/** Rule 8's tombstones, newest first. */
function tombstonesOf(
  notices: NoticeState,
  valid: readonly Verified[],
  listings: ReadonlyMap<string, ShelfListing>,
  now: number,
): ShelfTombstone[] {
  return [
    ...upheldTombstones(notices, valid, listings, now),
    ...suspendedTombstones(notices, now),
  ].sort((a, b) => b.seq - a.seq);
}

/** Rule 8: whether an entry is upheld, so gone for good, and no longer counts toward its address's 4. */
function upheldBy(notices: NoticeState): (posted: Posted) => boolean {
  const upheld = new Set(notices.upheld.map(({ address, id }) => keyOf(address, id ?? '')));
  return ({ record, body }) => upheld.has(keyOf(record.address, body.id));
}

/** The shelf as every device shows it, from the records the relay served (§4.3). */
export const foldShelf: FoldShelf = (records, now, options = {}) => {
  const inOrder = [...records].sort((a, b) => a.seq - b.seq);
  const valid = inOrder.map(verified).filter((item) => item !== null);
  const notices = foldNotices(inOrder);
  const named = holders(releasedOnly(standingClaims(valid), notices));
  const listings = new Map([...named].filter(([address]) => !isHeld(notices, address, null, now)));
  const { live, withdrawn } = entriesAt(valid, now);
  const upheld = upheldBy(notices);
  const shown = live.filter((posted) => !upheld(posted));
  return {
    listings: [...listings.values()].sort((a, b) => a.seq - b.seq),
    entries: entriesUnder(shown, listings, now, { ...options, notices }),
    withdrawn: withdrawn.map(({ record, body }) => ({
      address: record.address,
      id: body.id,
      title: body.title,
    })),
    tombstones: tombstonesOf(notices, valid, listings, now),
    holds: notices.holds.filter((hold) => holdStands(hold, now)),
    paused: notices.paused,
  };
};

/**
 * The entries `address` posted among `records`, unexpired at `now`, its
 * first copy of each id in seq order: those it didn't withdraw, and those it
 * did (rules 5 and 7), whatever its listing. The keeper reads them to post
 * what's missing and withdraw what its group's log didn't make (#431).
 */
export function entriesPostedAt(
  records: readonly ShelfRecord[],
  address: string,
  now: number,
): { readonly live: PostedEntry[]; readonly withdrawn: PostedEntry[] } {
  const mine = records.filter((record) => record.address === address);
  const valid = [...mine]
    .sort((a, b) => a.seq - b.seq)
    .map(verified)
    .filter((item) => item !== null);
  const { live, withdrawn } = entriesAt(valid, now);
  const posted = ({ record, body }: Posted): PostedEntry => ({ body, received: record.received });
  return { live: live.map(posted), withdrawn: withdrawn.map(posted) };
}

/**
 * The standing listing that holds `name`'s skeleton on `shelf`, other than
 * the one at `except`; else null. A listing under `name` would sit behind
 * it, shadowed (rule 4), so the listing composer warns before the vote.
 */
export function nameHolder(
  shelf: ShelfState,
  name: string,
  except: string | null,
): ShelfListing | null {
  const skeleton = nameSkeleton(name);
  const held = shelf.listings.find(
    (listing) => listing.address !== except && nameSkeleton(listing.name) === skeleton,
  );
  return held ?? null;
}

/**
 * Relay minutes a door counts as newly listed (§5.3, #432): 30 relay days.
 * Until then, and while it's held, its application form takes no personal
 * Documents (ADR-0081's one preventive rule).
 */
export const NEW_LISTING_MINUTES = 43_200;

/** What the shelf says of one door's listing, for its application form (§5.3). */
export interface DoorListing {
  /**
   * The earliest relay minute this device read at the address, or the
   * standing copy's receipt if earlier. Every record at an address arrives
   * after its first listing (an entry needs a live one, and the relay
   * renews a listing in place, stamping it anew), so this is never earlier
   * than the true first listing: a device that read late sees the door as
   * newer than it is, never older.
   */
  readonly listedSince: number;
  /**
   * Whether it waits for the steward: no release the pinned key signed
   * names it (rule 8, #488), a hold on its listing stands (#489), or it was
   * suspended. A held relay serves a listing only after its release, so a
   * reader sees an unreleased one only from a relay that misbehaves.
   */
  readonly held: boolean;
  /**
   * The clause a suspend of it names, once the steward removed it (#489):
   * the door's page says its listing was removed. Null while it stands.
   */
  readonly removed: Clause | null;
}

/** A suspend of `address` among `notices`, if any. */
const suspendOf = (notices: NoticeState, address: string) =>
  notices.suspended.find((removal) => removal.address === address);

/**
 * The listing of the door at `address` among `records` at relay minute
 * `now`, or null while it has none: its newest open listing that verifies
 * (rules 1 to 3), unless a final one ended it, held unless a release names
 * it and no hold on it stands (rule 8). A hold that stands lists the door
 * even when the relay withholds its listing, as an honest relay does. A
 * suspended door's listing is
 * removed, whatever the relay still serves: the relay deletes its records,
 * so it counts from the suspend. A listing shadowed by a look-alike name
 * still counts, so a shadowed door is held to the same rule.
 */
export function doorListing(
  records: readonly ShelfRecord[],
  address: string,
  now: number,
  since?: ReadonlyMap<string, number>,
): DoorListing | null {
  const notices = foldNotices(records);
  const suspended = suspendOf(notices, address);
  if (suspended !== undefined) {
    return { listedSince: suspended.received, held: true, removed: suspended.clause };
  }
  const valid = records
    .filter((record) => record.address === address)
    .sort((a, b) => a.seq - b.seq)
    .map(verified)
    .filter((item) => item !== null);
  const claim = standingClaims(valid).get(address);
  const hold = holdOn(notices, address, null, now);
  // The relay withholds a held listing, so a hold that stands lists the door itself.
  const first = claim?.listing.received ?? (hold === null ? undefined : hold.until - HOLD_MINUTES);
  if (first === undefined) return null;
  const listedSince = Math.min(first, since?.get(address) ?? Infinity);
  const held = hold !== null || !notices.released.has(address);
  return { listedSince, held, removed: null };
}

/**
 * Whether a door's form must offer no personal Documents at relay minute
 * `now` (§5.3): it is listed, and either held or listed under
 * {@link NEW_LISTING_MINUTES} ago. An unlisted door (null) is unchanged.
 */
export function newlyListed(listing: DoorListing | null, now: number): boolean {
  if (listing === null) return false;
  return listing.held || now - listing.listedSince < NEW_LISTING_MINUTES;
}

/** A listing waiting for the steward's release, as the console shows it (§6.4). */
export interface WaitingListing {
  /** The listing that waits: its address, name and covenant, and when its copy arrived. */
  readonly listing: ShelfListing;
  /** The live listing that holds the same skeleton, if any: what a release would sit behind. */
  readonly holder: ShelfListing | null;
}

/**
 * The listings among `held`, the records `GET /v1/shelf/held` served, each
 * address's newest open listing that verifies (rules 1 to 3) unless a final
 * one ended it, oldest first, each beside the listing on `live` that holds
 * its name (rule 4), if another does. A listing whose address `released`
 * holds is left out: it waits for a hold to lapse (#489), not for a release.
 * The steward sees only what readers will: a name and a covenant hash.
 */
export function waitingListings(
  held: readonly ShelfRecord[],
  live: ShelfState,
  released: ReadonlySet<string> = new Set(),
): WaitingListing[] {
  const valid = [...held]
    .sort((a, b) => a.seq - b.seq)
    .map(verified)
    .filter((item) => item !== null);
  return [...standingClaims(valid).values()]
    .map(({ listing }) => listing)
    .filter(({ address }) => !released.has(address))
    .sort((a, b) => a.seq - b.seq)
    .map((listing) => ({ listing, holder: nameHolder(live, listing.name, listing.address) }));
}

/** A hold that stands, as the steward's console lists it (§6.4, #489). */
export interface StandingHold {
  readonly hold: ShelfHold;
  /** The held listing's name, when a record this device read names it. */
  readonly name: string | null;
  /** The held entry's title, for a hold of one entry this device read. */
  readonly title: string | null;
}

/**
 * Each hold that stands at relay minute `now` among `live`, the records
 * `GET /v1/shelf` served, with the name and title it hides, read from
 * `held`, the records `GET /v1/shelf/held` served, or `live`: what the
 * steward upholds, suspends or lets lapse.
 */
export function standingHolds(
  live: readonly ShelfRecord[],
  held: readonly ShelfRecord[],
  now: number,
): StandingHold[] {
  const valid = [...live, ...held]
    .sort((a, b) => a.seq - b.seq)
    .map(verified)
    .filter((item) => item !== null);
  const claims = standingClaims(valid);
  const titles = new Map<string, string>();
  for (const { record, body } of valid) {
    if (body.kind === 'entry') titles.set(keyOf(record.address, body.id), body.title);
  }
  return foldNotices(live)
    .holds.filter((hold) => holdStands(hold, now))
    .map((hold) => ({
      hold,
      name: claims.get(hold.address)?.listing.name ?? null,
      title: hold.id === null ? null : (titles.get(keyOf(hold.address, hold.id)) ?? null),
    }));
}
