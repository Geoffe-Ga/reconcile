import { afterEach, describe, expect, it } from 'vitest';

import { GUIDE_KEY } from './guide';
import { NOTICE_KEY } from './notice';
import { PASSKEY_OFFER_KEY, passkeyOfferRecord } from './passkeyOffer';

afterEach(() => {
  window.localStorage.clear();
});

/** A storage that throws on every call, as a browser does when site data is blocked. */
const blocked = (): Storage => {
  throw new DOMException('Site data is blocked.', 'SecurityError');
};

describe('passkeyOfferRecord', () => {
  it('reads as not answered on a new device', () => {
    expect(passkeyOfferRecord().answered()).toBe(false);
  });

  it('remembers the answer on this device only, beside the other first-run flags', () => {
    passkeyOfferRecord().answer();
    expect(window.localStorage.getItem(PASSKEY_OFFER_KEY)).toBe('1');
    expect(window.localStorage).toHaveLength(1);
    expect(passkeyOfferRecord().answered()).toBe(true);
    expect(new Set([PASSKEY_OFFER_KEY, NOTICE_KEY, GUIDE_KEY]).size).toBe(3);
    // Every device flag shares the app's prefix, so Erase (#78) finds them together.
    expect(PASSKEY_OFFER_KEY.split('.')[0]).toBe(NOTICE_KEY.split('.')[0]);
  });

  it('reads any other value as not answered', () => {
    window.localStorage.setItem(PASSKEY_OFFER_KEY, '0');
    expect(passkeyOfferRecord().answered()).toBe(false);
  });

  it('offers again once Erase clears the device’s storage', () => {
    passkeyOfferRecord().answer();
    window.localStorage.clear();
    expect(passkeyOfferRecord().answered()).toBe(false);
  });

  it('never throws when storage is blocked: the offer shows again next launch', () => {
    const record = passkeyOfferRecord(blocked);
    expect(record.answered()).toBe(false);
    expect(() => {
      record.answer();
    }).not.toThrow();
  });
});
