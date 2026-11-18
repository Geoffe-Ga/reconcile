/**
 * Keeping a listed group's listing on the public shelf, after each sync of
 * the group (#486; ADR-0081; docs/spec/listed-doors.md §4.2, §4.5).
 *
 * No server holds a door's keys, so the members' devices post its listing,
 * as they keep its page (`door/keeper.ts`). After each sync of a group,
 * while this device is a member, no removal of it has passed (#115) and the
 * group isn't leaving, the device keeps one listing for each door the group
 * ever listed ({@link listingsDue}):
 *
 * - **Open.** While that door is open in effect and listed, the listing says
 *   the group's name and the covenant it accepted. The device posts it when
 *   none stands, when the copy that stands says something else, or when that
 *   copy is {@link REFRESH_MINUTES} old in relay time. The relay keeps it 30
 *   days after its last post, so a listing nobody keeps lapses.
 * - **Final.** Once that door closes in effect, for any reason a door closes
 *   (a vote, unlisting, a rotation, a steward's narrowing, a membership's end
 *   (#288) or a dissolve (#108)), the device posts the final listing, and
 *   again whenever it is {@link REFRESH_MINUTES} old, so one stays while the
 *   group goes on. The relay drops the door's entries, and no device shows
 *   any copy after it (`fold.ts`), so a final listing is never followed by
 *   an open one: the device posts none over it, and relisting takes a new
 *   opening Proposal, with a new door (§3.3).
 *
 * While the door is open and listed, the device also keeps its entries
 * (#431):
 *
 * - **An entry** for each Dispatch the group published ({@link entriesDue}):
 *   its id, title and text and nothing else, posted when it isn't on the
 *   shelf yet, in the order the votes closed. Every member's device may post
 *   it; the relay keeps one per address and id. A Dispatch is kept for
 *   {@link ENTRY_KEEP_DAYS} days after its vote closed, never longer, so an
 *   entry the relay let go after its 30 days is never posted again. While
 *   the relay answers `429 too_many_entries` (4 live, or 1 new today) or
 *   `409 not_listed`, the device waits {@link UNAVAILABLE_MINUTES} before it
 *   tries again.
 * - **A stray**: an entry under the door's address that the group's log
 *   didn't publish, signed with a door key someone kept. The first member's
 *   device that sees one, once it reached the relay before the minute this
 *   device last read the group's log (so no vote that closed since can have
 *   published it), posts a `withdraw` naming it, and every fold then
 *   drops it; Group home says so (`ShelfState.withdrawn`). The device looks
 *   at most once each {@link UNAVAILABLE_MINUTES}.
 *
 * Before posting, the device reads the whole shelf, as every reader does
 * (ADR-0077 §4), to see the copy that stands. It remembers in memory what it
 * found current, so it reads the shelf once a launch, again only when a
 * listing changes or its copy comes due, when an entry is due, and once an
 * hour to look for strays while the door is listed. While the relay has no
 * shelf (no steward key), it posts nothing and asks again after
 * {@link UNAVAILABLE_MINUTES}. Nothing the keeper does, or fails to do,
 * fails a sync pass.
 *
 * A member's device posts the listing from the same IP address as its group
 * syncs, so a live observer of the relay can tie the listed name to the
 * group's sealed mailboxes. The pilot notice says so; it is an accepted
 * pilot risk (§7).
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf } from '../crypto/door';
import { verifyShelfRecord } from '../crypto/shelf';
import { openDoor } from '../door/keeper';
import { addressOf, REFRESH_MINUTES } from '../door/page';
import { can, isOusted } from '../engine/capabilities';
import { publishedBy } from '../engine/dispatches';
import type { GroupState } from '../engine/fold';
import { type FrontDoor, isFrontDoor, listedUnder, rulesChangeOf } from '../engine/optIns';
import { codePointLength } from '../engine/text';
import { clip } from '../invite/envelope';
import { RelayError } from '../net/relay';
import { type Shelf, type ShelfPage, type ShelfRecord } from '../net/shelf';
import type { Group } from '../store/db';
import { foldGroup } from '../store/expiry';
import { ENTRY_KEEP_DAYS, entriesPostedAt, type PostedEntry, type ShelfWithdrawn } from './fold';
import {
  encodeShelfBody,
  type EntryBody,
  type FinalListingBody,
  type OpenListingBody,
  LISTING_NAME_MAX,
  parseShelfBody,
  SHELF_VERSION,
  type ShelfBody,
  signShelfBody,
} from './record';
import { nameSkeleton } from './skeleton';

/** Relay minutes to wait before asking a relay with no shelf again: an hour, as Discover does. */
export const UNAVAILABLE_MINUTES = 60;

/** The code a relay answers with for an open listing after a final one. */
export const LISTING_FINAL = 'listing_final';

/** The code a relay answers with for an entry past an address's caps (#431). */
export const TOO_MANY_ENTRIES = 'too_many_entries';

/** The code a relay answers with for an entry or withdraw with no live listing (#431). */
export const NOT_LISTED = 'not_listed';

/** The final listing: its door has closed for good. */
export const FINAL_LISTING: FinalListingBody = {
  v: SHELF_VERSION,
  kind: 'listing',
  open: false,
  final: true,
};

/** A listing, open or final. */
export type ListingBody = OpenListingBody | FinalListingBody;

/** What the keeper reads of a group's copy on this device. */
export type KeptGroup = Pick<Group, 'log' | 'relayNow' | 'cleared' | 'leaving'> & {
  readonly me: Pick<Group['me'], 'author'>;
};

/** What the keeper reaches. */
export interface ShelfKeeperOptions {
  readonly store: { getGroup(groupId: string): Promise<KeptGroup | undefined> };
  readonly shelf: Pick<Shelf, 'read' | 'put'>;
}

/** The keeper, which the sync loop runs after each group it syncs. */
export interface ShelfKeeper {
  /** Keeps `groupId`'s listings on the shelf. */
  run(groupId: string): Promise<void>;
}

/** Every door the group ever listed, by its key, oldest first: each passed front door change that listed it. */
function listedDoors(state: GroupState): FrontDoor[] {
  const doors = new Map<string, FrontDoor>();
  for (const proposal of state.proposals) {
    const change = rulesChangeOf(proposal);
    const passed = proposal.final && proposal.outcome.kind === 'pass';
    if (change?.optIn !== 'frontDoor' || !passed || !isFrontDoor(change.value)) continue;
    if (listedUnder(change.value) !== null && !doors.has(change.value.sign)) {
      doors.set(change.value.sign, change.value);
    }
  }
  return [...doors.values()];
}

/**
 * The listings to keep now: for each door the group ever listed, the open
 * listing while that door is open in effect and listed, else the final one.
 * The open listing names the group (cut to 120 code points) and the covenant
 * the door is listed under, with the name's skeleton (#487), which every
 * reader's fold checks.
 */
export function listingsDue(state: GroupState): (readonly [FrontDoor, ListingBody])[] {
  const open = openDoor(state);
  const covenant = listedUnder(open);
  return listedDoors(state).map((door) => {
    if (open === null || covenant === null || open.sign !== door.sign) {
      return [door, FINAL_LISTING] as const;
    }
    const name = listedName(state.name);
    const body: OpenListingBody = {
      v: SHELF_VERSION,
      kind: 'listing',
      open: true,
      name,
      skeleton: nameSkeleton(name),
      covenant,
    };
    return [open, body] as const;
  });
}

/** `name`, or its first 119 code points and "…", so a listing holds at most 120. */
export function listedName(name: string): string {
  return codePointLength(name) <= LISTING_NAME_MAX ? name : clip(name, LISTING_NAME_MAX - 1);
}

/** The copy of an address's listing that stands: its text and when it arrived. */
interface Standing {
  readonly text: string;
  readonly final: boolean;
  readonly received: number;
}

/** `body` as the text a copy of it carries. */
const textOf = (body: ShelfBody): string => new TextDecoder().decode(encodeShelfBody(body));

/** The listing body of `record`, when `address` signed it and it is one; else null. */
function listingIn(record: ShelfRecord, address: string): ListingBody | null {
  if (record.address !== address) return null;
  const message = verifyShelfRecord(record.data, address);
  const body = message === null ? null : parseShelfBody(message);
  return body?.kind === 'listing' ? body : null;
}

/**
 * The copy of `address`'s listing that stands among `records`, as every
 * device folds it: a final copy outranks every other, else the newest.
 */
export function standingListing(records: readonly ShelfRecord[], address: string): Standing | null {
  let standing: Standing | null = null;
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const body = listingIn(record, address);
    if (body === null || (standing?.final === true && body.open)) continue;
    standing = { text: textOf(body), final: !body.open, received: record.received };
  }
  return standing;
}

/** Relay minutes a published Dispatch stays due on the shelf after its vote closed: its entry's 30 days. */
const ENTRY_DUE_MINUTES = ENTRY_KEEP_DAYS * 1440;

/**
 * The entries a group keeps on the shelf at `state.at` (§4.5): one for each
 * Dispatch it published (`publishedBy`, #430) whose vote closed less than
 * {@link ENTRY_KEEP_DAYS} days ago, in the order the votes closed.
 */
export function entriesDue(state: GroupState): EntryBody[] {
  const due: EntryBody[] = [];
  for (const id of publishedBy(state)) {
    const dispatch = state.dispatches.find((d) => d.id === id);
    if (dispatch === undefined || state.at - dispatch.received >= ENTRY_DUE_MINUTES) continue;
    due.push({ v: SHELF_VERSION, kind: 'entry', id, title: dispatch.title, text: dispatch.text });
  }
  return due;
}

/**
 * The address of the door `state` lists now, while it is open in effect and
 * listed; else null. Discover shows its entries at once on this device, and
 * Group home reads what it withdrew (#431).
 */
export function listedAddress(state: GroupState): string | null {
  const open = openDoor(state);
  return open === null || listedUnder(open) === null ? null : base64url(addressOf(open));
}

/**
 * The entries `address` withdrew, among `withdrawn`, that `published`
 * doesn't hold: strays a member's device took down, which Group home names.
 */
export function straysOf(
  withdrawn: readonly ShelfWithdrawn[],
  address: string,
  published: readonly string[],
): ShelfWithdrawn[] {
  const ours = new Set(published);
  return withdrawn.filter((item) => item.address === address && !ours.has(item.id));
}

/** The relay's answers that mean "not now" to an entry: the caps, or no live listing yet. */
const WAIT_CODES: ReadonlySet<string> = new Set([TOO_MANY_ENTRIES, NOT_LISTED]);

/** Whether `error` is one of the relay's "not now" answers to an entry. */
const waitAnswer = (error: unknown): boolean =>
  error instanceof RelayError && WAIT_CODES.has(error.code);

/** A keeper over `options.store`, posting to `options.shelf`. */
export function createShelfKeeper(options: ShelfKeeperOptions): ShelfKeeper {
  const { store, shelf } = options;
  /** Each address's listing as last found current, and the relay minute it next comes due. */
  const current = new Map<string, { readonly text: string; readonly until: number }>();
  /** Each address's entries this device found on the shelf or posted, by `address id`. */
  const posted = new Set<string>();
  /** The relay minute each address's entries are next looked at: strays, or a wait the relay asked for. */
  const looked = new Map<string, { readonly strays: number; readonly entries: number }>();

  /** Signs `body` with `door`'s key and posts it under its address. */
  async function sign(door: FrontDoor, body: ShelfBody): Promise<void> {
    const keys = doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box)).signing;
    await shelf.put(base64url(keys.publicKey), signShelfBody(keys, body));
  }

  /** Posts `body` under `door`'s address; the minute it next comes due. */
  async function post(door: FrontDoor, body: ShelfBody, at: number): Promise<number> {
    try {
      await sign(door, body);
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 409 || error.code !== LISTING_FINAL) {
        throw error;
      }
      return Infinity;
    }
    return at + REFRESH_MINUTES;
  }

  /** The minute `body` next comes due at `address`, posting it first when it is due now. */
  async function due(
    door: FrontDoor,
    body: ListingBody,
    at: number,
    page: ShelfPage,
  ): Promise<number> {
    const standing = standingListing(page.records, base64url(addressOf(door)));
    // A final copy stands: no open copy goes over it (§3.3).
    if (standing?.final === true && body.open) return Infinity;
    const fresh = standing !== null && at - standing.received < REFRESH_MINUTES;
    if (fresh && standing.text === textOf(body)) return standing.received + REFRESH_MINUTES;
    return post(door, body, at);
  }

  /**
   * Posts each due entry `page` doesn't hold yet, in order; true unless the
   * relay asked it to wait, when it stops there.
   */
  async function postEntries(
    door: FrontDoor,
    due: readonly EntryBody[],
    held: ReadonlySet<string>,
  ): Promise<boolean> {
    const address = base64url(addressOf(door));
    for (const body of due) {
      if (!held.has(body.id)) {
        try {
          await sign(door, body);
        } catch (error) {
          if (waitAnswer(error)) return false;
          throw error;
        }
      }
      posted.add(`${address} ${body.id}`);
    }
    return true;
  }

  /**
   * Withdraws each entry at `door`'s address that the group never published.
   * Only one that reached the relay before the minute this device last read
   * the group's log counts: a later one may come from a vote that closed
   * since, which this device's log doesn't show yet.
   */
  async function withdrawStrays(
    door: FrontDoor,
    state: GroupState,
    live: readonly PostedEntry[],
  ): Promise<void> {
    const published = new Set(publishedBy(state));
    for (const { body, received } of live) {
      const { id } = body;
      if (published.has(id) || received >= state.at) continue;
      try {
        await sign(door, { v: SHELF_VERSION, kind: 'withdraw', id });
      } catch (error) {
        // Gone already: the listing ended, or the entry's 30 days did.
        if (!(error instanceof RelayError && error.status === 409)) throw error;
      }
    }
  }

  /** Keeps the entries of the door `state` lists now, reading `read` only when something is due. */
  async function keepEntries(
    state: GroupState,
    read: () => Promise<ShelfPage | null>,
  ): Promise<void> {
    const door = openDoor(state);
    const address = listedAddress(state);
    if (door === null || address === null) return;
    const due = entriesDue(state).filter(({ id }) => !posted.has(`${address} ${id}`));
    const next = looked.get(address) ?? { strays: -Infinity, entries: -Infinity };
    const posting = due.length > 0 && state.at >= next.entries;
    if (!posting && state.at < next.strays) return;
    const page = await read();
    const later = state.at + UNAVAILABLE_MINUTES;
    if (page === null) {
      looked.set(address, { strays: later, entries: later });
      return;
    }
    const { live, withdrawn } = entriesPostedAt(page.records, address, page.now);
    const held = new Set([...live, ...withdrawn].map(({ body }) => body.id));
    const kept = !posting || (await postEntries(door, due, held));
    looked.set(address, { strays: later, entries: kept ? -Infinity : later });
    await withdrawStrays(door, state, live);
  }

  return {
    async run(groupId) {
      const state = await keptState(store, groupId);
      if (state === null) return;
      // The shelf is read at most once a run, and only when a listing or an entry is due.
      let page: Promise<ShelfPage | null> | undefined;
      const read = (): Promise<ShelfPage | null> => (page ??= shelf.read());
      for (const [door, body] of listingsDue(state)) {
        const address = base64url(addressOf(door));
        const text = textOf(body);
        const held = current.get(address);
        if (held?.text === text && state.at < held.until) continue;
        const shelved = await read();
        const until =
          shelved === null
            ? state.at + UNAVAILABLE_MINUTES
            : await due(door, body, state.at, shelved);
        current.set(address, { text, until });
      }
      await keepEntries(state, read);
    },
  };
}

/**
 * `groupId` as this device keeps its listings, or null when it keeps none:
 * no copy, a group it is leaving, one that never synced, or one in which its
 * member can't read or a removal of them has passed (#115).
 */
async function keptState(
  store: ShelfKeeperOptions['store'],
  groupId: string,
): Promise<GroupState | null> {
  const group = await store.getGroup(groupId);
  if (group === undefined || group.leaving !== undefined || group.relayNow === null) return null;
  const state = foldGroup(group);
  const me = group.me.author;
  return state.group === null || !can(state, me, 'read') || isOusted(state, me) ? null : state;
}
