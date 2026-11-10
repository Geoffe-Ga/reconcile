/**
 * An in-memory relay with #62's contract (`reconcile/relay/app.py`), for tests.
 *
 * It is a `fetch` that answers the relay's routes: PUT and GET
 * `/v1/mailbox/{id}` and GET `/v1/health`, with the same status codes and
 * `{"error": code}` bodies, and #89's push routes (`/v1/push/...`, #99),
 * which keep each mailbox's endpoints and nudges for a test to read. A blob
 * PUT takes `wake=1` as the real relay does. No push is ever sent. Seqs are shared by every mailbox, as in the real
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
  /** Present, and true, only for a request sent with `keepalive` (#99). */
  keepalive?: true;
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

/** The relay's VAPID public key in tests: 87 base64url characters, as `GET /v1/push/key` serves one. */
export const TEST_PUSH_KEY = `B${'A'.repeat(86)}`;
/** The push services' hosts the relay accepts endpoints on (#89). */
const PUSH_HOSTS =
  /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|.+\.push\.apple\.com|.+\.notify\.windows\.com)$/;
const MAX_JSON_BYTES = 2048;
/** A nudge is at most 30 days ahead, and a mailbox holds at most 50 (#89). */
const NUDGE_HORIZON = 43_200;
const MAX_NUDGES = 50;

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
  /** The VAPID public key `GET /v1/push/key` serves, or null for a relay with push off (#99). */
  pushKey: string | null;
  /** The endpoints registered under `mailbox`, oldest first. */
  endpoints(mailbox: string): string[];
  /**
   * The `not_before` of every nudge `mailbox` took, as asked, in the order they
   * came. A repeat is kept too, so a test sees a nudge posted twice.
   */
  nudges(mailbox: string): number[];
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
  const subs = new Map<string, string[]>();
  const nudged = new Map<string, number[]>();

  const relay: FakeRelay = {
    minute: options.minute ?? 29_000_000,
    offline: false,
    requests: [],
    discord: createFakeDiscord(),
    pushKey: TEST_PUSH_KEY,
    endpoints: (mailbox) => [...(subs.get(mailbox) ?? [])],
    nudges: (mailbox) => [...(nudged.get(mailbox) ?? [])],
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
        subs.clear();
        nudged.clear();
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
    if (url.pathname.startsWith('/v1/push/')) {
      return pushRoute(url.pathname, request);
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
    const wake = query.get('wake');
    if (wake !== null && wake !== '1') {
      throw new Refusal(400, 'invalid_wake');
    }
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

  /** #89's push routes: the key, registering and forgetting an endpoint, and nudges. */
  function pushRoute(path: string, request: FakeRequest): Response {
    if (relay.pushKey === null) {
      throw new Refusal(404, 'push_unavailable');
    }
    if (path === '/v1/push/key' && request.method === 'GET') {
      return Response.json({ vapid_public_key: relay.pushKey });
    }
    const match = /^\/v1\/push\/([^/]*)(\/nudge)?$/.exec(path);
    if (match === null) {
      throw new Refusal(404, 'not_found');
    }
    const mailbox = checkMailbox(match[1] ?? '');
    const isNudge = match[2] !== undefined;
    const allowed = isNudge ? ['POST'] : ['PUT', 'DELETE'];
    if (!allowed.includes(request.method)) {
      throw new Refusal(405, 'method_not_allowed');
    }
    return isNudge
      ? nudge(mailbox, jsonField(request, 'not_before'))
      : endpoint(mailbox, request.method, jsonField(request, 'endpoint'));
  }

  function endpoint(mailbox: string, method: string, value: unknown): Response {
    if (typeof value !== 'string') {
      throw new Refusal(400, 'invalid_request');
    }
    const held = (subs.get(mailbox) ?? []).filter((kept) => kept !== value);
    if (method === 'PUT') {
      if (!isPushEndpoint(value)) {
        throw new Refusal(422, 'push_endpoint_rejected');
      }
      held.push(value);
    }
    subs.set(mailbox, held);
    return new Response(null, { status: 204 });
  }

  function nudge(mailbox: string, value: unknown): Response {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Refusal(400, 'invalid_request');
    }
    if (value < 0 || value > relay.minute + NUDGE_HORIZON) {
      throw new Refusal(400, 'invalid_not_before');
    }
    const held = nudged.get(mailbox) ?? [];
    if (held.length >= MAX_NUDGES) {
      throw new Refusal(429, 'too_many_nudges');
    }
    nudged.set(mailbox, [...held, value]);
    return new Response(null, { status: 204 });
  }

  return relay;
}

/** True for an `https` URL on one of the push services' hosts, as the relay checks (#89). */
function isPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The one field of a push route's body: JSON, at most 2,048 bytes, an object
 * holding exactly `name` and nothing else, as the relay requires (#89).
 */
function jsonField(request: FakeRequest, name: string): unknown {
  const mediaType = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new Refusal(415, 'unsupported_media_type');
  }
  const bytes = request.body ?? new Uint8Array();
  if (bytes.length > MAX_JSON_BYTES) {
    throw new Refusal(413, 'too_large');
  }
  const body = parseJson(bytes);
  if (!isObject(body) || Object.keys(body).join() !== name) {
    throw new Refusal(400, 'invalid_request');
  }
  return body[name];
}

/** `bytes` read as JSON, or undefined when they aren't. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the fake records of a request: the URL as given, and the body's bytes. */
function recordRequest(input: string | URL | Request, init: RequestInit | undefined): FakeRequest {
  return {
    method: init?.method ?? 'GET',
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    contentType: new Headers(init?.headers).get('content-type'),
    body: bodyBytes(init?.body),
    ...(init?.keepalive === true ? { keepalive: true as const } : {}),
  };
}

/** A request body's bytes: a typed array's, or a string's as UTF-8; null for none. */
function bodyBytes(body: RequestInit['body']): Uint8Array | null {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return ArrayBuffer.isView(body)
    ? Uint8Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    : null;
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
