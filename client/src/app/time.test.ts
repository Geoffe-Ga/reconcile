import { describe, expect, it } from 'vitest';

import {
  formatDay,
  formatMinute,
  formatSyncedAt,
  MINUTE_MS,
  minuteIso,
  relayMinuteNow,
  timeLeft,
} from './time';

/** 2026-11-16 14:05 UTC, in whole minutes since the Unix epoch. */
const MON_1405 = Date.UTC(2026, 10, 16, 14, 5) / MINUTE_MS;

describe('relayMinuteNow', () => {
  it('reads the device clock before the first sync', () => {
    expect(relayMinuteNow({ relayNow: null, lastSyncAt: null }, 120 * MINUTE_MS + 59_999)).toBe(
      120,
    );
  });

  it('is the last relay now, moved on by the device time since that sync', () => {
    const lastSyncAt = 5_000_000_000;
    const sync = { relayNow: 29_000_000, lastSyncAt };
    expect(relayMinuteNow(sync, lastSyncAt)).toBe(29_000_000);
    expect(relayMinuteNow(sync, lastSyncAt + 59_999)).toBe(29_000_000);
    expect(relayMinuteNow(sync, lastSyncAt + 3 * MINUTE_MS)).toBe(29_000_003);
  });

  it('ignores a device clock that runs far ahead of the relay', () => {
    // Only the time elapsed since the sync counts, never the device's own date.
    const sync = { relayNow: 29_000_000, lastSyncAt: 1_762_650_000_000 };
    expect(relayMinuteNow(sync, 1_762_650_000_000)).toBe(29_000_000);
  });

  it('never runs behind the last relay now when the device clock steps back', () => {
    const sync = { relayNow: 29_000_000, lastSyncAt: 5_000_000_000 };
    expect(relayMinuteNow(sync, 4_000_000_000)).toBe(29_000_000);
  });
});

describe('timeLeft', () => {
  it.each([
    [1, 'in 1 minute'],
    [59, 'in 59 minutes'],
    [60, 'in 1 hour'],
    [89, 'in 1 hour'],
    [90, 'in 2 hours'],
    [1439, 'in 24 hours'],
    [1440, 'in 1 day'],
    [10_080, 'in 7 days'],
    [10_079, 'in 7 days'],
    [7 * 1440 - 721, 'in 6 days'],
  ])('reads %i minutes as %j', (minutes, text) => {
    expect(timeLeft(minutes)).toBe(text);
  });
});

describe('formatMinute', () => {
  it('shows the weekday, date and time on a 12-hour clock', () => {
    expect(formatMinute(MON_1405, 'UTC')).toBe('Mon 16 Nov, 2:05 pm');
    expect(formatMinute(MON_1405, 'America/New_York')).toBe('Mon 16 Nov, 9:05 am');
  });
});

describe('formatDay', () => {
  it('shows a device time as its weekday and date, with no time of day', () => {
    const ms = MON_1405 * MINUTE_MS;
    expect(formatDay(ms, 'UTC')).toBe('Mon 16 Nov');
    expect(formatDay(ms, 'Pacific/Kiritimati')).toBe('Tue 17 Nov');
  });
});

describe('minuteIso', () => {
  it('writes a relay minute as a machine-readable UTC date', () => {
    expect(minuteIso(MON_1405)).toBe('2026-11-16T14:05:00.000Z');
  });
});

describe('formatSyncedAt', () => {
  const synced = MON_1405 * MINUTE_MS;

  it('shows only the time for a sync earlier the same day', () => {
    expect(formatSyncedAt(synced, synced + 3 * 60 * MINUTE_MS, 'UTC')).toBe('2:05 pm');
  });

  it('adds the date for a sync on an earlier day', () => {
    expect(formatSyncedAt(synced, synced + 10 * 60 * MINUTE_MS, 'UTC')).toBe('Mon 16 Nov, 2:05 pm');
  });

  it('adds the date for a sync on the same day of an earlier year', () => {
    const yearLater = Date.UTC(2027, 10, 16, 15, 0);
    expect(formatSyncedAt(synced, yearLater, 'UTC')).toBe('Mon 16 Nov, 2:05 pm');
  });
});
