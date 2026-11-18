/**
 * Time as the screens show it.
 *
 * Votes run on relay time: whole minutes since the Unix epoch (spec §4 and §6).
 * A device estimates the relay's minute from the last `now` it read plus the
 * device time since then, so a device clock set to the wrong date can't move a
 * deadline. Dates are formatted in the messages module's locale and the
 * device's time zone.
 */
import { messages } from './messages';

/** One minute in milliseconds. */
export const MINUTE_MS = 60_000;

const HOUR = 60;
const DAY = 24 * HOUR;

/** What a group's last sync recorded: the relay's minute, and the device's ms then. */
export interface SyncClock {
  readonly relayNow: number | null;
  readonly lastSyncAt: number | null;
}

/**
 * The relay's minute now, as best this device knows it: the last relay `now`
 * moved on by the device time since that sync, or the device clock before any
 * sync. The fold settles outcomes on relay time alone; this only decides what
 * the screens show, such as a countdown or a ballot that can no longer count.
 */
export function relayMinuteNow(sync: SyncClock, deviceMs: number): number {
  if (sync.relayNow === null || sync.lastSyncAt === null) {
    return Math.floor(deviceMs / MINUTE_MS);
  }
  const elapsed = Math.floor((deviceMs - sync.lastSyncAt) / MINUTE_MS);
  return sync.relayNow + Math.max(0, elapsed);
}

const relative = new Intl.RelativeTimeFormat(messages.app.locale, { numeric: 'always' });

/** How long until something `minutes` away, such as "in 7 days" or "in 3 hours". */
export function timeLeft(minutes: number): string {
  if (minutes < HOUR) return relative.format(minutes, 'minute');
  if (minutes < DAY) return relative.format(Math.round(minutes / HOUR), 'hour');
  return relative.format(Math.round(minutes / DAY), 'day');
}

const DATE: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' };
const DAY_OF: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };

function format(ms: number, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  const zone = timeZone === undefined ? {} : { timeZone };
  return new Intl.DateTimeFormat(messages.app.locale, { ...options, ...zone }).format(ms);
}

/** A relay minute as a date and time, such as "Mon 16 Nov, 2:05 pm". */
export function formatMinute(minute: number, timeZone?: string): string {
  return format(minute * MINUTE_MS, { ...DATE, ...TIME }, timeZone);
}

/** A device time in ms as a day, with no time of day, such as "Fri 21 Nov". */
export function formatDay(ms: number, timeZone?: string): string {
  return format(ms, DATE, timeZone);
}

const FULL_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };

/** A relay minute as a date with its year, such as "16 November 2026": for what stays on a device (#108). */
export function formatDate(minute: number, timeZone?: string): string {
  return format(minute * MINUTE_MS, FULL_DATE, timeZone);
}

const MONTH: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };

/** A relay minute as a month and year, such as "November 2026": a shelf listing's "Listed since" (#431). */
export function formatMonth(minute: number, timeZone?: string): string {
  return format(minute * MINUTE_MS, MONTH, timeZone);
}

/** A relay minute as an ISO 8601 date, for a `<time>` element's `dateTime`. */
export function minuteIso(minute: number): string {
  return new Date(minute * MINUTE_MS).toISOString();
}

/** When a sync happened: the time alone on the same day as `nowMs`, else the date as well. */
export function formatSyncedAt(syncedMs: number, nowMs: number, timeZone?: string): string {
  const sameDay = format(syncedMs, DAY_OF, timeZone) === format(nowMs, DAY_OF, timeZone);
  return format(syncedMs, sameDay ? TIME : { ...DATE, ...TIME }, timeZone);
}
