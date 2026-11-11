/**
 * The relay's push routes (#89, ADR-0012), for the app's opt-in push (#99).
 *
 * Push carries no content: these calls give the relay a device's push
 * endpoint under a group's mailbox, take it back, and schedule a wake at a
 * relay minute. Every body is JSON holding exactly one key, `endpoint` or
 * `not_before`, and nothing about the group, the person or the device beyond
 * the endpoint itself. Like `relay.ts`, every request goes to `/v1` on the
 * app's own origin, sends no cookies or referrer, and skips the HTTP cache.
 */
import {
  browserFetch,
  checkMailbox,
  errorCode,
  PRIVATE,
  RelayError,
  type RelayOptions,
} from './relay';

/** The calls push makes to the relay. */
export interface PushRelay {
  /**
   * The relay's VAPID public key: 87 base64url characters, an uncompressed
   * P-256 point. Read from the relay each time, never built in, so a rebuilt
   * relay's new key is the one a device subscribes with.
   *
   * @throws {RelayError} `push_unavailable` (404) when the relay has push off.
   */
  key(): Promise<string>;
  /** Register `endpoint` under `mailbox` for 30 days, or refresh it. */
  register(mailbox: string, endpoint: string): Promise<void>;
  /**
   * Forget `endpoint` under `mailbox`. With `keepalive`, the request carries
   * on if the page closes, as it may just after Leave.
   */
  unregister(mailbox: string, endpoint: string, options?: { keepalive?: boolean }): Promise<void>;
  /** Wake `mailbox`'s endpoints at relay minute `notBefore`, or now if it has passed. */
  nudge(mailbox: string, notBefore: number): Promise<void>;
}

const VAPID_KEY = /^[A-Za-z0-9_-]{87}$/;
const JSON_TYPE = { 'Content-Type': 'application/json' };

/** A client for the relay's push routes at `baseUrl`. */
export function createPushRelay({
  baseUrl = '/v1',
  fetch: send = browserFetch,
}: RelayOptions = {}): PushRelay {
  const pushUrl = (mailbox: string): string => `${baseUrl}/push/${checkMailbox(mailbox)}`;

  /** Sends one push write; anything but a 2xx becomes a RelayError. */
  async function write(url: string, init: RequestInit): Promise<void> {
    const response = await send(url, { ...PRIVATE, ...init, headers: JSON_TYPE });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      throw new RelayError(response.status, errorCode(body, response.status));
    }
  }

  return {
    async key() {
      const response = await send(`${baseUrl}/push/key`, { ...PRIVATE, method: 'GET' });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new RelayError(response.status, errorCode(body, response.status));
      const key = (body as { vapid_public_key?: unknown } | null)?.vapid_public_key;
      if (typeof key !== 'string' || !VAPID_KEY.test(key)) {
        throw new RelayError(response.status, 'bad_response');
      }
      return key;
    },
    register: async (mailbox, endpoint) => {
      await write(pushUrl(mailbox), { method: 'PUT', body: JSON.stringify({ endpoint }) });
    },
    unregister: async (mailbox, endpoint, { keepalive = false } = {}) => {
      const body = JSON.stringify({ endpoint });
      await write(pushUrl(mailbox), {
        method: 'DELETE',
        body,
        ...(keepalive ? { keepalive } : {}),
      });
    },
    nudge: async (mailbox, notBefore) => {
      const body = JSON.stringify({ not_before: notBefore });
      await write(`${pushUrl(mailbox)}/nudge`, { method: 'POST', body });
    },
  };
}
