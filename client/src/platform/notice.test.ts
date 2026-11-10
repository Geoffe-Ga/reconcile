import { afterEach, describe, expect, it } from 'vitest';

import { NOTICE_KEY, noticeRecord } from './notice';

afterEach(() => {
  window.localStorage.clear();
});

/** A storage that throws on every call, as a browser does when site data is blocked. */
const blocked = (): Storage => {
  throw new DOMException('Site data is blocked.', 'SecurityError');
};

describe('noticeRecord', () => {
  it('reads as not accepted on a new device', () => {
    expect(noticeRecord().accepted()).toBe(false);
  });

  it('remembers the acceptance on this device only, in its own storage', () => {
    noticeRecord().accept();
    expect(window.localStorage.getItem(NOTICE_KEY)).toBe('1');
    expect(window.localStorage).toHaveLength(1);
    expect(noticeRecord().accepted()).toBe(true);
  });

  it('asks again when the notice’s version changes', () => {
    window.localStorage.setItem(NOTICE_KEY, '0');
    expect(noticeRecord().accepted()).toBe(false);
  });

  it('never throws when storage is blocked: it asks again next launch', () => {
    const record = noticeRecord(blocked);
    expect(record.accepted()).toBe(false);
    expect(() => {
      record.accept();
    }).not.toThrow();
  });
});
