// Test-only: name-derived, deterministic seeds. Never mirror them in production code.
/**
 * Fixed signing keys for tests. Each name has one key, from the seed
 * SHA-256("reconcile/test-key/" + name), so a test signs as "ana" and names
 * ana's author id with `authorOf('ana')`, run after run.
 *
 * Ed25519 signatures are deterministic, so `signedAs` keeps each record it
 * makes and hands back the same one for the same event: property tests that
 * rebuild a log many times sign each event once.
 */
import { sha256 } from '../crypto/hash';
import { publicKeyOf } from '../crypto/sign';
import { base64url, type EventDraft, signEvent, type SignedEvent } from '../engine/event';

/** One test member's keys. */
export interface TestKeys {
  /** The 32-byte secret key. */
  readonly secretKey: Uint8Array;
  /** The base64url public key: the member's `author`. */
  readonly author: string;
}

const known = new Map<string, TestKeys>();
const signed = new Map<string, SignedEvent>();

/** The fixed keys of the test member `name`. */
export function testKeys(name: string): TestKeys {
  let keys = known.get(name);
  if (keys === undefined) {
    const secretKey = sha256(new TextEncoder().encode(`reconcile/test-key/${name}`));
    keys = { secretKey, author: base64url(publicKeyOf(secretKey)) };
    known.set(name, keys);
  }
  return keys;
}

/** The `author` of the test member `name`. */
export function authorOf(name: string): string {
  return testKeys(name).author;
}

/** `draft`, signed by the test member `name`. */
export function signedAs(name: string, draft: EventDraft): SignedEvent {
  const key = JSON.stringify([name, draft]);
  let event = signed.get(key);
  if (event === undefined) {
    event = signEvent(testKeys(name).secretKey, draft);
    signed.set(key, event);
  }
  return event;
}
