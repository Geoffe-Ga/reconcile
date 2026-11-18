/**
 * An in-memory public shelf with #484's contract (`reconcile/relay/app.py`'s
 * `_Shelf`), for tests: `PUT /v1/shelf/{address}` stores a record its address
 * signed and `GET /v1/shelf` pages every record in seq order, with the same
 * status codes and `{"error": code}` bodies. Unavailable, as a relay without
 * the steward's key is, both answer 404 `shelf_unavailable`.
 *
 * It keeps #486's listing rules, on its own minute clock: an address has one
 * listing, which a later copy replaces in its place (keeping its seq) and
 * which lapses 30 days after its last post; an open copy after a final one
 * gets 409 `listing_final`; and a final copy deletes the address's other
 * records.
 *
 * It keeps #431's entry rules too: an entry or withdraw needs a live open
 * listing (409 `not_listed`); a repeat with the same address and id returns
 * the first copy's seq with 200; a withdraw names one of the address's
 * entries (409 `no_entry`); and an address has at most 4 live entries and 1
 * new one a relay day (429 `too_many_entries`).
 *
 * And #488's held mode: an address's first listing, and whatever comes under
 * it before a release, is held, which `GET /v1/shelf` leaves out and
 * `GET /v1/shelf/held` returns alone. A `release` notice PUT under the
 * steward's address (the tests' pins, `test/steward.ts`) and signed by it
 * clears its address's hold; a notice under any other address gets 403
 * `bad_signature`. {@link release} PUTs the tests' steward's release, for a
 * test about a door the steward already let show.
 *
 * And #489's later notices: a `hold` holds an address's records, or one
 * entry, for 10,080 relay minutes (and whatever comes under a held address
 * meanwhile), which a release leaves standing; an `uphold` deletes its entry
 * (409 `no_entry` without one) and refuses it again with 403 `upheld` while
 * the notice stands, which is as long as the entry would have; a `suspend`
 * deletes an address's records and refuses its PUTs with 403 `suspended`;
 * and a `pause` is only stored.
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { Fetch } from '../net/relay';
import type { Shelf } from '../net/shelf';
import {
  type EntryBody,
  type NoticeBody,
  parseShelfBody,
  type ShelfBody,
  signShelfBody,
  type UpholdNoticeBody,
  type WithdrawBody,
} from '../shelf/record';
import { STEWARD_ADDRESS, TEST_STEWARD } from './steward';

/** A record the fake shelf keeps. */
export interface FakeShelfRecord {
  readonly seq: number;
  readonly received: number;
  readonly address: string;
  readonly data: Uint8Array;
  /** The relay day it expires on: 30 whole days after the day it arrived. */
  readonly expiry: number;
  /** The relay minute it is held until: 0 for none, Infinity while it waits for a release (#488, #489). */
  heldUntil: number;
  /** What a notice acts on, `kind:address[:id]`, as the relay files it; else empty. */
  readonly ref: string;
}

/** Minutes in a relay day. */
const DAY_MINUTES = 1440;

/** Whole days a record is kept after the day it arrived, as the relay's `SHELF_KEEP_DAYS`. */
const KEEP_DAYS = 30;

/** Whole days a notice is kept after the day it arrived, as the relay's `NOTICE_KEEP_DAYS`. */
const NOTICE_KEEP_DAYS = 180;

/** Relay minutes a hold lasts, as the relay's `HOLD_MINUTES`. */
const HOLD_MINUTES = 10_080;

/** The fake, its records, and the URLs of the requests it answered. */
export interface FakeShelf {
  readonly fetch: Fetch;
  readonly records: FakeShelfRecord[];
  readonly urls: string[];
  /** The relay minute it stamps and reports. */
  minute: number;
  /** Whether the shelf is on: off answers 404 `shelf_unavailable`. */
  available: boolean;
  /** Whether a first listing waits for a release (#488); false as if the steward released each at once. */
  holds: boolean;
}

const ORIGIN = 'http://relay.test';
const PUT_PATH = /^\/v1\/shelf\/([A-Za-z0-9_-]{43})$/;

/** The two GET routes, by whether each serves held records (#488). */
const GET_PATHS: ReadonlyMap<string, boolean> = new Map([
  ['/v1/shelf', false],
  ['/v1/shelf/held', true],
]);

/** `{"error": code}` with `status`. */
const refuse = (status: number, code: string): Response =>
  Response.json({ error: code }, { status });

/** A shelf at relay minute `minute`, on unless told otherwise. */
export function createFakeShelf({
  minute = 29_000_000,
  available = true,
  holds = true,
} = {}): FakeShelf {
  const shelf: FakeShelf = { fetch: answer, records: [], urls: [], minute, available, holds };

  let lastSeq = 0;
  const today = (): number => Math.floor(shelf.minute / DAY_MINUTES);

  /** What a first listing waits until: a release, in held mode; else nothing. */
  const firstHold = (): number => (shelf.holds ? Infinity : 0);

  /** `address`'s listing in place of its earlier one, or a refusal after a final one. */
  function list(address: string, data: Uint8Array, final: boolean): Response {
    const at = shelf.records.findIndex((r) => r.address === address && isListing(r.data, address));
    const standing = shelf.records[at];
    if (standing !== undefined && isFinal(standing.data, address) && !final) {
      return refuse(409, 'listing_final');
    }
    const seq = standing?.seq ?? (lastSeq += 1);
    const expiry = today() + KEEP_DAYS + 1;
    const record = {
      seq,
      received: shelf.minute,
      address,
      data,
      expiry,
      heldUntil: standing?.heldUntil ?? firstHold(),
      ref: '',
    };
    if (standing === undefined) shelf.records.push(record);
    else shelf.records[at] = record;
    if (final) {
      const kept = shelf.records.filter((r) => r.address !== address || r.seq === seq);
      shelf.records.splice(0, shelf.records.length, ...kept);
    }
    return Response.json({ seq }, { status: 201 });
  }

  /** `address`'s unexpired records whose body is `kind` naming `id`. */
  function named(address: string, kind: 'entry' | 'withdraw', id: string): FakeShelfRecord[] {
    return shelf.records.filter((r) => {
      const body = r.address === address && r.expiry > today() ? bodyOf(r.data, address) : null;
      return body?.kind === kind && body.id === id;
    });
  }

  /** Whether `address` has a live entry with `id`: unexpired and not withdrawn. */
  const live = (address: string, id: string): boolean =>
    named(address, 'entry', id).length > 0 && named(address, 'withdraw', id).length === 0;

  /** The refusal or repeat an entry or withdraw meets (#431), or null for a new one to store. */
  function check(address: string, body: EntryBody | WithdrawBody): Response | null {
    const standing = shelf.records.find(
      (r) => r.address === address && r.expiry > today() && isListing(r.data, address),
    );
    if (standing === undefined || isFinal(standing.data, address)) {
      return refuse(409, 'not_listed');
    }
    const [first] = named(address, body.kind, body.id);
    if (first !== undefined) return Response.json({ seq: first.seq }, { status: 200 });
    if (body.kind === 'withdraw') {
      return named(address, 'entry', body.id).length === 0 ? refuse(409, 'no_entry') : null;
    }
    const entries = shelf.records.filter(
      (r) =>
        r.address === address && r.expiry > today() && bodyOf(r.data, address)?.kind === 'entry',
    );
    const liveCount = entries.filter((r) => {
      const entry = bodyOf(r.data, address);
      return entry?.kind === 'entry' && live(address, entry.id);
    }).length;
    const todays = entries.filter((r) => Math.floor(r.received / DAY_MINUTES) === today()).length;
    return liveCount >= 4 || todays >= 1 ? refuse(429, 'too_many_entries') : null;
  }

  /** The minute `address`'s listing is held until, if it still is at this minute; else 0. */
  const listingHeld = (address: string): number => {
    const until =
      shelf.records.find((r) => r.address === address && isListing(r.data, address))?.heldUntil ??
      0;
    return until > shelf.minute ? until : 0;
  };

  /** The newest unexpired notice filed under `ref`, if any. */
  const standingNotice = (ref: string): FakeShelfRecord | undefined =>
    shelf.records.filter((r) => r.ref === ref && r.expiry > today()).at(-1);

  /** Holds each record under `address`, or its entry `id`, until `until`, never shortening a wait. */
  function hold(address: string, id: string | undefined, until: number): void {
    for (const record of shelf.records) {
      const body = record.address === address ? bodyOf(record.data, address) : null;
      if (body === null || (id !== undefined && (body.kind !== 'entry' || body.id !== id))) {
        continue;
      }
      record.heldUntil = Math.max(record.heldUntil, until);
    }
  }

  /** Clears the wait for a release under `address`, leaving a hold that still stands. */
  function releaseAddress(address: string): void {
    const held = standingNotice(`hold:${address}`);
    const until = held === undefined ? 0 : held.received + HOLD_MINUTES;
    for (const record of shelf.records) {
      if (record.address === address && record.heldUntil === Infinity) {
        record.heldUntil = until > shelf.minute ? until : 0;
      }
    }
  }

  /** Deletes the records `keep` refuses. */
  function drop(keep: (record: FakeShelfRecord) => boolean): void {
    const kept = shelf.records.filter(keep);
    shelf.records.splice(0, shelf.records.length, ...kept);
  }

  /** Stores the steward's notice under its address and acts on it (#488, #489). */
  function noticed(address: string, data: Uint8Array, body: NoticeBody): Response {
    if (address !== STEWARD_ADDRESS) return refuse(403, 'bad_signature');
    switch (body.act) {
      case 'release':
        releaseAddress(body.address);
        return stored(address, data, 0, body.address);
      case 'hold': {
        const ref = ['hold', body.address, body.id].filter(Boolean).join(':');
        hold(body.address, body.id, shelf.minute + HOLD_MINUTES);
        return stored(address, data, 0, ref);
      }
      case 'uphold':
        return upheld(address, data, body);
      case 'suspend':
        drop((r) => r.address !== body.address);
        return stored(address, data, 0, `suspend:${body.address}`);
      case 'pause':
        return stored(address, data, 0, 'pause');
    }
  }

  /** Deletes an upheld entry and keeps its notice as long as the entry would have been. */
  function upheld(address: string, data: Uint8Array, body: UpholdNoticeBody): Response {
    const [entry] = named(body.address, 'entry', body.id);
    if (entry === undefined) return refuse(409, 'no_entry');
    drop((r) => {
      const named = r.address === body.address ? bodyOf(r.data, body.address) : null;
      return !(named?.kind === 'entry' || named?.kind === 'withdraw') || named.id !== body.id;
    });
    const ref = `uphold:${body.address}:${body.id}`;
    return stored(address, data, 0, ref, entry.expiry);
  }

  /** Stores `data` under `address` as a new record. */
  function stored(
    address: string,
    data: Uint8Array,
    heldUntil: number,
    ref = '',
    expiry = today() + (ref === '' ? KEEP_DAYS : NOTICE_KEEP_DAYS) + 1,
  ): Response {
    lastSeq += 1;
    shelf.records.push({
      seq: lastSeq,
      received: shelf.minute,
      address,
      data,
      expiry,
      heldUntil,
      ref,
    });
    return Response.json({ seq: lastSeq }, { status: 201 });
  }

  /** Files a record whose signature verified, by its kind. */
  function file(address: string, data: Uint8Array, body: ShelfBody | null): Response {
    if (body?.kind === 'notice') return noticed(address, data, body);
    if (body?.kind === 'listing') return list(address, data, !body.open);
    if (body?.kind === 'entry' && standingNotice(`uphold:${address}:${body.id}`)) {
      return refuse(403, 'upheld');
    }
    const answered = body === null ? null : check(address, body);
    return answered ?? stored(address, data, listingHeld(address));
  }

  async function put(address: string, init: RequestInit | undefined): Promise<Response> {
    if (standingNotice(`suspend:${address}`)) return refuse(403, 'suspended');
    const data = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    if (verifyShelfRecord(data, address) === null) return refuse(403, 'bad_signature');
    return file(address, data, bodyOf(data, address));
  }

  function get(url: URL, held: boolean): Response {
    const after = Number(url.searchParams.get('after') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const page = shelf.records
      .filter(
        (record) =>
          record.seq > after && record.expiry > today() && record.heldUntil > shelf.minute === held,
      )
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
    return Response.json({
      records: page.map(({ seq, received, address, data }) => ({
        seq,
        received,
        address,
        data: btoa(String.fromCharCode(...data)),
      })),
      now: shelf.minute,
      instance: 'fake-shelf-instance',
    });
  }

  async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = input instanceof Request ? input.url : String(input);
    shelf.urls.push(raw);
    const url = new URL(raw, ORIGIN);
    if (!shelf.available) return refuse(404, 'shelf_unavailable');
    const address = PUT_PATH.exec(url.pathname)?.[1];
    if (init?.method === 'PUT' && address !== undefined) return put(address, init);
    const held = GET_PATHS.get(url.pathname);
    return init?.method === 'GET' && held !== undefined ? get(url, held) : refuse(404, 'not_found');
  }

  return shelf;
}

/** The body of a record `address` signed, or null. */
function bodyOf(data: Uint8Array, address: string): ShelfBody | null {
  const message = verifyShelfRecord(data, address);
  return message === null ? null : parseShelfBody(message);
}

/** Whether `data` is a listing, open or final. */
function isListing(data: Uint8Array, address: string): boolean {
  return bodyOf(data, address)?.kind === 'listing';
}

/** Whether `data` is a final listing. */
function isFinal(data: Uint8Array, address: string): boolean {
  const body = bodyOf(data, address);
  return body?.kind === 'listing' && !body.open;
}

/** PUTs the tests' steward's release of `address` to `shelf`, as the steward's console does (#488). */
export async function release(shelf: Pick<Shelf, 'put'>, address: string): Promise<void> {
  await notify(shelf, { v: 1, kind: 'notice', act: 'release', address });
}

/** PUTs the tests' steward's `notice` to `shelf`, as the steward's console does (#488, #489). */
export async function notify(shelf: Pick<Shelf, 'put'>, notice: NoticeBody): Promise<void> {
  await shelf.put(STEWARD_ADDRESS, signShelfBody(TEST_STEWARD.signing, notice));
}
