/**
 * The steward's key in tests (#488): a fixed secret every test shares, and
 * the two public keys `test-setup.ts` pins in place of the app's
 * (`shelf/steward.ts`), so a test can sign the notices a device's fold takes.
 *
 * The secret is the SHA-256 of a label, made here and never pinned in the
 * app: anyone can derive it, so it must never be a real steward's.
 *
 * It imports nothing that imports `shelf/steward.ts`, since the mock of that
 * module reads this one.
 */
import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { newNoticeNonce } from '../crypto/shelf';
import { stewardKeysOf } from '../crypto/steward';
import type { ShelfRecord } from '../net/shelf';
import { type NoticeStamp, signShelfBody } from '../shelf/record';
import type { StewardPins } from '../shelf/steward';

/** The tests' steward secret. */
export const TEST_STEWARD_SECRET = sha256(new TextEncoder().encode('reconcile/test/steward'));

/** The tests' steward key pairs. */
export const TEST_STEWARD = stewardKeysOf(TEST_STEWARD_SECRET);

/** The tests' pins: what `test-setup.ts` puts in place of the app's. */
export const TEST_PINS: StewardPins = {
  sign: base64url(TEST_STEWARD.signing.publicKey),
  box: base64url(TEST_STEWARD.box.publicKey),
};

/**
 * The build settings that pin the tests' key (#505): what `scripts/e2e.sh`
 * builds the app with, through `scripts/stewardTestPins.mjs`, and what
 * `deploy/deploy.sh` refuses to ship. `plugins/stewardPins.ts` reads them.
 */
export const TEST_PIN_SETTINGS: Readonly<Record<string, string>> = {
  RECONCILE_STEWARD_PIN_SIGN: TEST_PINS.sign,
  RECONCILE_STEWARD_PIN_BOX: TEST_PINS.box,
};

/** The steward's address in tests: its signing key, in unpadded base64url. */
export const STEWARD_ADDRESS = TEST_PINS.sign;

/** Relay minutes in a UTC day. */
const DAY_MINUTES = 1440;

/** A stamp for a notice that arrives at relay minute `received`: that day, and a fresh nonce. */
export function stampAt(received: number): NoticeStamp {
  return { day: Math.floor(received / DAY_MINUTES), n: newNoticeNonce() };
}

/** A release of `address`, signed by the tests' steward on the day it arrives, as the relay serves it. */
export function releaseRecord(address: string, seq: number, received: number): ShelfRecord {
  const data = signShelfBody(TEST_STEWARD.signing, {
    v: 1,
    kind: 'notice',
    act: 'release',
    address,
    ...stampAt(received),
  });
  return { seq, received, address: STEWARD_ADDRESS, data };
}
