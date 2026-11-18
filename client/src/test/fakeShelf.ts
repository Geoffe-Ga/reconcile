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
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { Fetch } from '../net/relay';
import { parseShelfBody, type ShelfBody } from '../shelf/record';

/** A record the fake shelf keeps. */
export interface FakeShelfRecord {
  readonly seq: number;
  readonly received: number;
  readonly address: string;
  readonly data: Uint8Array;
  /** The relay day it expires on: 30 whole days after the day it arrived. */
  readonly expiry: number;
}

/** Minutes in a relay day. */
const DAY_MINUTES = 1440;

/** Whole days a record is kept after the day it arrived, as the relay's `SHELF_KEEP_DAYS`. */
const KEEP_DAYS = 30;

/** The fake, its records, and the URLs of the requests it answered. */
export interface FakeShelf {
  readonly fetch: Fetch;
  readonly records: FakeShelfRecord[];
  readonly urls: string[];
  /** The relay minute it stamps and reports. */
  minute: number;
  /** Whether the shelf is on: off answers 404 `shelf_unavailable`. */
  available: boolean;
}

const ORIGIN = 'http://relay.test';
const PUT_PATH = /^\/v1\/shelf\/([A-Za-z0-9_-]{43})$/;

/** `{"error": code}` with `status`. */
const refuse = (status: number, code: string): Response =>
  Response.json({ error: code }, { status });

/** A shelf at relay minute `minute`, on unless told otherwise. */
export function createFakeShelf({ minute = 29_000_000, available = true } = {}): FakeShelf {
  const shelf: FakeShelf = { fetch: answer, records: [], urls: [], minute, available };

  let lastSeq = 0;
  const today = (): number => Math.floor(shelf.minute / DAY_MINUTES);

  /** `address`'s listing in place of its earlier one, or a refusal after a final one. */
  function list(address: string, data: Uint8Array, final: boolean): Response {
    const at = shelf.records.findIndex((r) => r.address === address && isListing(r.data, address));
    const standing = shelf.records[at];
    if (standing !== undefined && isFinal(standing.data, address) && !final) {
      return refuse(409, 'listing_final');
    }
    const seq = standing?.seq ?? (lastSeq += 1);
    const record = { seq, received: shelf.minute, address, data, expiry: today() + KEEP_DAYS + 1 };
    if (standing === undefined) shelf.records.push(record);
    else shelf.records[at] = record;
    if (final) {
      const kept = shelf.records.filter((r) => r.address !== address || r.seq === seq);
      shelf.records.splice(0, shelf.records.length, ...kept);
    }
    return Response.json({ seq }, { status: 201 });
  }

  async function put(address: string, init: RequestInit | undefined): Promise<Response> {
    const data = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    if (verifyShelfRecord(data, address) === null) return refuse(403, 'bad_signature');
    if (isListing(data, address)) return list(address, data, isFinal(data, address));
    lastSeq += 1;
    const expiry = today() + KEEP_DAYS + 1;
    shelf.records.push({ seq: lastSeq, received: shelf.minute, address, data, expiry });
    return Response.json({ seq: lastSeq }, { status: 201 });
  }

  function get(url: URL): Response {
    const after = Number(url.searchParams.get('after') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const page = shelf.records
      .filter((record) => record.seq > after && record.expiry > today())
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
    if (init?.method === 'GET' && url.pathname === '/v1/shelf') return get(url);
    return refuse(404, 'not_found');
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
