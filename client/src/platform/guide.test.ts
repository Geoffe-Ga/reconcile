import { afterEach, describe, expect, it } from 'vitest';

import { GUIDE_KEY, guideRecord } from './guide';
import { NOTICE_KEY } from './notice';

afterEach(() => {
  window.localStorage.clear();
});

/** A storage that throws on every call, as a browser does when site data is blocked. */
const blocked = (): Storage => {
  throw new DOMException('Site data is blocked.', 'SecurityError');
};

describe('guideRecord', () => {
  it('reads as not seen on a new device', () => {
    expect(guideRecord().seen()).toBe(false);
  });

  it('remembers the guide was seen on this device only, beside the pilot notice’s flag', () => {
    guideRecord().see();
    expect(window.localStorage.getItem(GUIDE_KEY)).toBe('1');
    expect(window.localStorage).toHaveLength(1);
    expect(guideRecord().seen()).toBe(true);
    expect(GUIDE_KEY).not.toBe(NOTICE_KEY);
    // Both device flags share the app's prefix, so Erase (#78) finds them together.
    expect(GUIDE_KEY.split('.')[0]).toBe(NOTICE_KEY.split('.')[0]);
  });

  it('reads any other value as not seen', () => {
    window.localStorage.setItem(GUIDE_KEY, '0');
    expect(guideRecord().seen()).toBe(false);
  });

  it('reads as not seen once Erase clears the device’s storage', () => {
    guideRecord().see();
    window.localStorage.clear();
    expect(guideRecord().seen()).toBe(false);
  });

  it('never throws when storage is blocked: the guide can show again', () => {
    const record = guideRecord(blocked);
    expect(record.seen()).toBe(false);
    expect(() => {
      record.see();
    }).not.toThrow();
  });
});
