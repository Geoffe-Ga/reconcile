/**
 * An in-memory public shelf with #484's contract (`reconcile/relay/app.py`'s
 * `_Shelf`), for tests: `PUT /v1/shelf/{address}` stores a record its address
 * signed and `GET /v1/shelf` pages every record in seq order, with the same
 * status codes and `{"error": code}` bodies. Unavailable, as a relay without
 * the steward's key is, both answer 404 `shelf_unavailable`.
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { Fetch } from '../net/relay';

/** A record the fake shelf keeps. */
export interface FakeShelfRecord {
  readonly seq: number;
  readonly received: number;
  readonly address: string;
  readonly data: Uint8Array;
}

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

  async function put(address: string, init: RequestInit | undefined): Promise<Response> {
    const data = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    if (verifyShelfRecord(data, address) === null) return refuse(403, 'bad_signature');
    const seq = shelf.records.length + 1;
    shelf.records.push({ seq, received: shelf.minute, address, data });
    return Response.json({ seq }, { status: 201 });
  }

  function get(url: URL): Response {
    const after = Number(url.searchParams.get('after') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const page = shelf.records.filter((record) => record.seq > after).slice(0, limit);
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
