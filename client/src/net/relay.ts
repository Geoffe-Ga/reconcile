/**
 * The relay client (spec §6 and §7): the app's only caller of `fetch`.
 *
 * Every request goes to `/v1` on the app's own origin, sends no cookies or
 * referrer, and skips the HTTP cache. The mailbox id, or a backup's id
 * (#97), is the only identifier a request carries, and neither ever appears
 * in an error.
 */

/** The shape of `fetch`, so tests can hand in an in-memory relay. */
export type Fetch = typeof fetch;

/** One stored blob, as the relay returns it. */
export interface RelayRecord {
  /** Its place in the relay's order. Seqs only grow, with gaps between mailboxes. */
  seq: number;
  /** The relay minute it arrived: ⌊Unix seconds / 60⌋. */
  received: number;
  /** The blob's bytes. */
  data: Uint8Array<ArrayBuffer>;
}

/** Every record after a seq, with the relay's time and instance. */
export interface RelayPage {
  /** The records in ascending seq order. */
  records: RelayRecord[];
  /** The relay minute of the last page; every record left out arrived at or after it. */
  now: number;
  /** The relay database's random id; a new one means a fresh relay. */
  instance: string;
}

/** The calls the app makes to a mailbox, and to the relay backup (#97). */
export interface Relay {
  /** Store `blob` in `mailbox`, kept `ttlDays` (the relay's default is 30), and return its seq. */
  putBlob(mailbox: string, blob: Uint8Array<ArrayBuffer>, ttlDays?: number): Promise<number>;
  /** Every record in `mailbox` after seq `after`, paging until a page comes back short. */
  getBlobs(mailbox: string, after: number): Promise<RelayPage>;
  /** Keep `blob` as the backup `backup`, replacing any earlier one; resolves on the relay's 204. */
  putBackup(backup: string, blob: Uint8Array<ArrayBuffer>): Promise<void>;
  /** The backup `backup`'s bytes, or null when the relay holds none (its 404). */
  getBackup(backup: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** Where the relay is, and how to reach it. */
export interface RelayOptions {
  /** The API's base URL (default: `/v1` on the same origin). */
  baseUrl?: string;
  /** The `fetch` to call (default: the browser's). */
  fetch?: Fetch;
}

/** The relay refused a request, or answered with something it never sends. */
export class RelayError extends Error {
  /** Raise for an answer with `status` and the relay's error `code`. */
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`The relay answered ${String(status)} (${code}).`);
    this.name = 'RelayError';
  }
}

/** The most records the relay returns per page. */
export const PAGE_LIMIT = 100;

const MAILBOX_ID = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CODE = /^[a-z_]{1,40}$/;
const OCTET_STREAM = 'application/octet-stream';

/** What every request sends: no cookies, no referrer, and no HTTP cache. */
const PRIVATE: RequestInit = {
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  cache: 'no-store',
};

/** The browser's `fetch`, called unbound so it never sees a foreign `this`. */
const browserFetch: Fetch = (input, init) => fetch(input, init);

/** A client for the relay at `baseUrl`. */
export function createRelay({
  baseUrl = '/v1',
  fetch: send = browserFetch,
}: RelayOptions = {}): Relay {
  const mailboxUrl = (mailbox: string): string => `${baseUrl}/mailbox/${checkMailbox(mailbox)}`;
  const backupUrl = (backup: string): string => `${baseUrl}/backup/${checkBackup(backup)}`;

  async function putBlob(
    mailbox: string,
    blob: Uint8Array<ArrayBuffer>,
    ttlDays?: number,
  ): Promise<number> {
    const query = ttlDays === undefined ? '' : `?ttl_days=${String(ttlDays)}`;
    const response = await send(mailboxUrl(mailbox) + query, {
      ...PRIVATE,
      method: 'PUT',
      headers: { 'Content-Type': OCTET_STREAM },
      body: blob,
    });
    const body = await readJson(response);
    if (!isObject(body) || !isWhole(body.seq)) {
      throw new RelayError(response.status, 'bad_response');
    }
    return body.seq;
  }

  async function getPage(mailbox: string, after: number): Promise<RelayPage> {
    const url = `${mailboxUrl(mailbox)}?after=${String(after)}&limit=${String(PAGE_LIMIT)}`;
    const response = await send(url, { ...PRIVATE, method: 'GET' });
    const page = parsePage(await readJson(response), after);
    if (page === null) {
      throw new RelayError(response.status, 'bad_response');
    }
    return page;
  }

  async function getBlobs(mailbox: string, after: number): Promise<RelayPage> {
    let page = await getPage(mailbox, after);
    const { instance } = page;
    const records = [...page.records];
    while (page.records.length >= PAGE_LIMIT) {
      page = await getPage(mailbox, page.records[page.records.length - 1]?.seq ?? after);
      if (page.instance !== instance) {
        throw new RelayError(200, 'instance_changed');
      }
      records.push(...page.records);
    }
    return { records, now: page.now, instance };
  }

  async function putBackup(backup: string, blob: Uint8Array<ArrayBuffer>): Promise<void> {
    const response = await send(backupUrl(backup), {
      ...PRIVATE,
      method: 'PUT',
      headers: { 'Content-Type': OCTET_STREAM },
      body: blob,
    });
    if (response.status !== 204) throw await refusal(response);
  }

  async function getBackup(backup: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const response = await send(backupUrl(backup), { ...PRIVATE, method: 'GET' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw await refusal(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  return { putBlob, getBlobs, putBackup, getBackup };
}

/** `mailbox`, if it is 43 base64url characters; anything else could rewrite the URL. */
function checkMailbox(mailbox: string): string {
  if (!MAILBOX_ID.test(mailbox)) {
    throw new RangeError('A mailbox id is 43 base64url characters.');
  }
  return mailbox;
}

/** `backup`, if it is 43 base64url characters, as a mailbox id is. */
function checkBackup(backup: string): string {
  if (!MAILBOX_ID.test(backup)) {
    throw new RangeError('A backup id is 43 base64url characters.');
  }
  return backup;
}

/** The RelayError for an answer the call doesn't take: its code, or `bad_response` for a 2xx. */
async function refusal(response: Response): Promise<RelayError> {
  const body: unknown = await response.json().catch(() => undefined);
  return new RelayError(
    response.status,
    response.ok ? 'bad_response' : errorCode(body, response.status),
  );
}

/** The JSON body of a 2xx answer; any other answer becomes a RelayError. */
async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new RelayError(response.status, errorCode(body, response.status));
  }
  if (body === undefined) {
    throw new RelayError(response.status, 'bad_response');
  }
  return body;
}

/** The relay's `{"error": code}`, or `http_<status>` when the body has none. */
function errorCode(body: unknown, status: number): string {
  if (isObject(body) && typeof body.error === 'string' && ERROR_CODE.test(body.error)) {
    return body.error;
  }
  return `http_${String(status)}`;
}

/** A GET answer, or `null` unless its records come in ascending seq order after `after`. */
function parsePage(body: unknown, after: number): RelayPage | null {
  if (!isObject(body) || !isWhole(body.now) || typeof body.instance !== 'string') {
    return null;
  }
  const records = parseRecords(body.records, after);
  return records && { records, now: body.now, instance: body.instance };
}

function parseRecords(raw: unknown, after: number): RelayRecord[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const records: RelayRecord[] = [];
  let previous = after;
  for (const item of raw) {
    const record = parseRecord(item);
    if (record === null || record.seq <= previous) {
      return null;
    }
    records.push(record);
    previous = record.seq;
  }
  return records;
}

function parseRecord(item: unknown): RelayRecord | null {
  if (!isObject(item) || !isWhole(item.seq) || !isWhole(item.received)) {
    return null;
  }
  const data = typeof item.data === 'string' ? fromBase64(item.data) : null;
  return data && { seq: item.seq, received: item.received, data };
}

/** Standard base64 decoded, or `null` when it isn't base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
