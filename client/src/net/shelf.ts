/**
 * The public shelf's client (#484; docs/spec/listed-doors.md §4.2): the only
 * caller of the relay's `/v1/shelf` routes.
 *
 * Every request goes to `/v1` on the app's own origin, as `relay.ts`'s do,
 * with no cookies, referrer or HTTP cache. A read takes the whole shelf, 100
 * records a page, so every device asks for exactly the same thing and a read
 * says nothing about its reader (ADR-0077 §4). A relay without the steward's
 * key has no shelf: its 404 `shelf_unavailable` reads as null, never an error.
 */
import {
  browserFetch,
  fromBase64,
  isObject,
  isWhole,
  PAGE_LIMIT,
  PRIVATE,
  readJson,
  RelayError,
  type RelayOptions,
} from './relay';

/** One record on the shelf, as the relay returns it. */
export interface ShelfRecord {
  /** Its place in the shelf's order. */
  readonly seq: number;
  /** The relay minute it arrived. */
  readonly received: number;
  /** The key it was PUT under, in unpadded base64url: a listed door's, or the steward's. */
  readonly address: string;
  /** Its signed bytes, as PUT. */
  readonly data: Uint8Array<ArrayBuffer>;
}

/** The whole shelf, with the relay's minute and instance. */
export interface ShelfPage {
  readonly records: readonly ShelfRecord[];
  readonly now: number;
  readonly instance: string;
}

/** The calls the app makes to the shelf. */
export interface Shelf {
  /** Every record the relay serves, in seq order; null while the relay has no shelf. */
  read(): Promise<ShelfPage | null>;
  /** PUT one signed record under `address`, and return its seq. */
  put(address: string, record: Uint8Array<ArrayBuffer>): Promise<number>;
}

/** A shelf address: a key in unpadded base64url, 43 characters, as a mailbox id is spelled. */
const ADDRESS = /^[A-Za-z0-9_-]{43}$/;

/** The code a relay without the steward's key answers with. */
export const SHELF_UNAVAILABLE = 'shelf_unavailable';

/** A client for the shelf at `baseUrl`. */
export function createShelf({
  baseUrl = '/v1',
  fetch: send = browserFetch,
}: RelayOptions = {}): Shelf {
  async function put(address: string, record: Uint8Array<ArrayBuffer>): Promise<number> {
    const url = `${baseUrl}/shelf/${checkAddress(address)}`;
    const response = await send(url, {
      ...PRIVATE,
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: record,
    });
    const body = await readJson(response);
    if (!isObject(body) || !isWhole(body.seq))
      throw new RelayError(response.status, 'bad_response');
    return body.seq;
  }

  async function page(after: number): Promise<ShelfPage> {
    const url = `${baseUrl}/shelf?after=${String(after)}&limit=${String(PAGE_LIMIT)}`;
    const response = await send(url, { ...PRIVATE, method: 'GET' });
    const parsed = parsePage(await readJson(response), after);
    if (parsed === null) throw new RelayError(response.status, 'bad_response');
    return parsed;
  }

  async function readAll(): Promise<ShelfPage> {
    let next = await page(0);
    const { instance } = next;
    const records = [...next.records];
    while (next.records.length >= PAGE_LIMIT) {
      next = await page(records.at(-1)?.seq ?? 0);
      if (next.instance !== instance) throw new RelayError(200, 'instance_changed');
      records.push(...next.records);
    }
    return { records, now: next.now, instance };
  }

  async function read(): Promise<ShelfPage | null> {
    try {
      return await readAll();
    } catch (error) {
      if (error instanceof RelayError && error.status === 404 && error.code === SHELF_UNAVAILABLE) {
        return null;
      }
      throw error;
    }
  }

  return { read, put };
}

/** `address`, if it is 43 base64url characters; anything else could rewrite the URL. */
function checkAddress(address: string): string {
  if (!ADDRESS.test(address)) throw new RangeError('A shelf address is 43 base64url characters.');
  return address;
}

/** A GET answer, or null unless its records come in ascending seq order after `after`. */
function parsePage(body: unknown, after: number): ShelfPage | null {
  if (!isObject(body) || !isWhole(body.now) || typeof body.instance !== 'string') return null;
  if (!Array.isArray(body.records)) return null;
  const records: ShelfRecord[] = [];
  let previous = after;
  for (const item of body.records) {
    const record = parseRecord(item);
    if (record === null || record.seq <= previous) return null;
    records.push(record);
    previous = record.seq;
  }
  return { records, now: body.now, instance: body.instance };
}

/** One record of a GET answer, or null. */
function parseRecord(item: unknown): ShelfRecord | null {
  if (!isObject(item) || !isWhole(item.seq) || !isWhole(item.received)) return null;
  const { address, data } = item;
  if (typeof address !== 'string' || !ADDRESS.test(address)) return null;
  const bytes = typeof data === 'string' ? fromBase64(data) : null;
  return bytes && { seq: item.seq, received: item.received, address, data: bytes };
}
