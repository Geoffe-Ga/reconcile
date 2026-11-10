/**
 * An in-memory relay with #62's contract (`reconcile/relay/app.py`), for tests.
 *
 * It is a `fetch` that answers the relay's routes: PUT and GET
 * `/v1/mailbox/{id}` and GET `/v1/health`, with the same status codes and
 * `{"error": code}` bodies. Seqs are shared by every mailbox, as in the real
 * relay's one table, so a mailbox's seqs have gaps. Each blob expires as the
 * real relay's does: `ttl_days` after the UTC day it arrived, plus one, by the
 * fake's minute clock.
 *
 * Beside it sits the one other place a device may send anything, a group's
 * Discord webhook (#119): `discord`, a fake endpoint test devices post to, so
 * a test sees all a device sends and none of it reaches the network.
 */

import type { Fetch } from '../net/relay';
import { createFakeDiscord, type FakeDiscord } from './fakeDiscord';

const MAILBOX_ID = /^[A-Za-z0-9_-]{43}$/;

/** A well-formed mailbox id for tests: 43 base64url characters. */
export const TEST_MAILBOX = 'test-mailbox-'.padEnd(43, '0');
const BLOB_SIZES = new Set([1024, 4096, 16384, 65536]);
const MAX_BLOB_BYTES = 65536;
const MAX_SEQ = 2 ** 53 - 1;
const ORIGIN = 'http://relay.test';

/** A request the fake relay received. */
export interface FakeRequest {
  /** The HTTP method. */
  method: string;
  /** The URL exactly as the client passed it. */
  url: string;
  /** The `Content-Type` header, or `null` when there was none. */
  contentType: string | null;
  /** The body's bytes, or `null` when there was no body. */
  body: Uint8Array | null;
}

/** A blob the fake relay stores. */
interface Stored {
  mailbox: string;
  seq: number;
  received: number;
  /** The UTC day it expires on: the day it arrived, plus `ttl_days`, plus 1. */
  expiry: number;
  blob: Uint8Array;
}

/** Minutes in a UTC day: a relay minute's day is ⌊minute / 1,440⌋. */
const DAY_MINUTES = 1440;

/** A whole-number query parameter with a default and inclusive bounds. */
interface IntParam {
  name: string;
  fallback: number;
  low: number;
  high: number;
  code: string;
}

const TTL_DAYS: IntParam = {
  name: 'ttl_days',
  fallback: 30,
  low: 1,
  high: 30,
  code: 'invalid_ttl',
};
const AFTER: IntParam = {
  name: 'after',
  fallback: 0,
  low: 0,
  high: MAX_SEQ,
  code: 'invalid_after',
};
const LIMIT: IntParam = { name: 'limit', fallback: 100, low: 1, high: 100, code: 'invalid_limit' };

/** A test's handle on the fake relay. */
export interface FakeRelay {
  /** The `fetch` to give `createRelay`. */
  readonly fetch: Fetch;
  /** The relay's clock in Unix minutes: each PUT's `received` and each GET's `now`. */
  minute: number;
  /** While true, every request fails the way `fetch` does with no network. */
  offline: boolean;
  /** The current database's random instance id. */
  readonly instance: string;
  /** Every request that reached the relay, oldest first. */
  readonly requests: FakeRequest[];
  /** The Discord webhook endpoint test devices post to (#119); its requests aren't in `requests`. */
  readonly discord: FakeDiscord;
  /** The unexpired blobs stored in `mailbox`, oldest first. */
  blobs(mailbox: string): Uint8Array[];
  /** Deletes the oldest `count` blobs of `mailbox`, as a purge of expired rows would. */
  drop(mailbox: string, count: number): void;
  /**
   * Replace the database: a new instance id and, like a fresh relay, no blobs
   * and seqs from 1 again, unless `keep` copies the blobs over with their seqs.
   */
  restart(options?: { keep?: boolean }): void;
}

/** Thrown inside the fake to answer with `{"error": code}`. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** A fake relay whose clock starts at `minute` (default: 29,000,000). */
export function createFakeRelay(options: { minute?: number } = {}): FakeRelay {
  let stored: Stored[] = [];
  let lastSeq = 0;
  let instance = randomInstance();

  const relay: FakeRelay = {
    minute: options.minute ?? 29_000_000,
    offline: false,
    requests: [],
    discord: createFakeDiscord(),
    get instance() {
      return instance;
    },
    blobs: (mailbox) => live(mailbox).map((row) => row.blob),
    drop: (mailbox, count) => {
      const doomed = new Set(live(mailbox).slice(0, count));
      stored = stored.filter((row) => !doomed.has(row));
    },
    restart: ({ keep = false } = {}) => {
      instance = randomInstance();
      if (!keep) {
        stored = [];
        lastSeq = 0;
      }
    },
    fetch: (input, init) => {
      if (relay.offline) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const request = recordRequest(input, init);
      relay.requests.push(request);
      return Promise.resolve(answer(request));
    },
  };

  /** The blobs of `mailbox` that haven't expired by the fake's clock, oldest first. */
  function live(mailbox: string): Stored[] {
    const today = Math.floor(relay.minute / DAY_MINUTES);
    return stored.filter((row) => row.mailbox === mailbox && row.expiry > today);
  }

  function answer(request: FakeRequest): Response {
    try {
      return route(request);
    } catch (error) {
      if (error instanceof Refusal) {
        return Response.json({ error: error.code }, { status: error.status });
      }
      throw error;
    }
  }

  function route(request: FakeRequest): Response {
    const url = new URL(request.url, ORIGIN);
    if (url.pathname === '/v1/health' && request.method === 'GET') {
      return Response.json({ status: 'ok' });
    }
    const match = /^\/v1\/mailbox\/([^/]*)$/.exec(url.pathname);
    if (match === null) {
      throw new Refusal(404, 'not_found');
    }
    const mailbox = checkMailbox(match[1] ?? '');
    if (request.method === 'PUT') {
      return put(mailbox, url.searchParams, request);
    }
    if (request.method === 'GET') {
      return get(mailbox, url.searchParams);
    }
    throw new Refusal(405, 'method_not_allowed');
  }

  function put(mailbox: string, query: URLSearchParams, request: FakeRequest): Response {
    const ttlDays = queryInt(query, TTL_DAYS);
    const mediaType = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/octet-stream') {
      throw new Refusal(415, 'unsupported_media_type');
    }
    const blob = request.body ?? new Uint8Array();
    if (blob.length > MAX_BLOB_BYTES) {
      throw new Refusal(413, 'too_large');
    }
    if (!BLOB_SIZES.has(blob.length)) {
      throw new Refusal(400, 'invalid_size');
    }
    lastSeq += 1;
    const expiry = Math.floor(relay.minute / DAY_MINUTES) + ttlDays + 1;
    stored.push({ mailbox, seq: lastSeq, received: relay.minute, expiry, blob });
    return Response.json({ seq: lastSeq }, { status: 201 });
  }

  function get(mailbox: string, query: URLSearchParams): Response {
    const after = queryInt(query, AFTER);
    const limit = queryInt(query, LIMIT);
    const records = live(mailbox)
      .filter((row) => row.seq > after)
      .slice(0, limit)
      .map((row) => ({ seq: row.seq, received: row.received, data: toBase64(row.blob) }));
    return Response.json({ records, now: relay.minute, instance });
  }

  return relay;
}

/** What the fake records of a request: the URL as given, and the body's bytes. */
function recordRequest(input: string | URL | Request, init: RequestInit | undefined): FakeRequest {
  const body = init?.body;
  return {
    method: init?.method ?? 'GET',
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    contentType: new Headers(init?.headers).get('content-type'),
    body: ArrayBuffer.isView(body)
      ? Uint8Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
      : null,
  };
}

function checkMailbox(mailbox: string): string {
  if (!MAILBOX_ID.test(mailbox)) {
    throw new Refusal(400, 'invalid_mailbox');
  }
  return mailbox;
}

function queryInt(query: URLSearchParams, param: IntParam): number {
  const raw = query.get(param.name);
  if (raw === null) {
    return param.fallback;
  }
  const value = /^[0-9]{1,19}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= param.low && value <= param.high)) {
    throw new Refusal(400, param.code);
  }
  return value;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function randomInstance(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
