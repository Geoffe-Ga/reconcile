/**
 * The slow clock (#479; ADR-0080 §4): the dial turns one step outward for each
 * week in which the reader opens Bedfellows, never more than one step a week,
 * and never past {@link TOP}. The reader can set it to any step or reset it to
 * 0, and a mark nudges it one step (the history issue calls `nudge`).
 *
 * Nothing here reads a clock: weeks and days come from a calendar date the
 * caller passes in, and the caller keeps the dial and the week it last
 * stepped (the history issue stores them on the device).
 */
import { clampDial, TOP } from './mix';

/** Milliseconds in a day. */
const DAY = 86_400_000;

/** A calendar date written YYYY-MM-DD. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The dial after this week's opening: one step out when Bedfellows was opened
 * in `thisWeek` and the dial last stepped in an earlier week, else where it
 * was. However many weeks passed, it moves one step: the pace is one step per
 * week of use, not per week of time. The caller records `thisWeek` as the
 * last step's week when the dial moved.
 */
export function nextDial(
  dial: number,
  lastStepWeek: number,
  thisWeek: number,
  openedThisWeek: boolean,
): number {
  const step = clampDial(dial);
  if (!openedThisWeek || thisWeek <= lastStepWeek) return step;
  return Math.min(TOP, step + 1);
}

/** The reader sets the dial to `step`, kept within 0 and {@link TOP}. */
export function setDial(step: number): number {
  return clampDial(step);
}

/** The reader resets the dial to 0. */
export function resetDial(): number {
  return 0;
}

/** A mark's nudge: one step in or out, never past either end. */
export function nudge(dial: number, direction: 'in' | 'out'): number {
  return clampDial(clampDial(dial) + (direction === 'out' ? 1 : -1));
}

/**
 * Days from 1970-01-01 to `date`, a YYYY-MM-DD calendar date (the reader's
 * own, which the caller formats).
 *
 * @throws {RangeError} when `date` isn't a real YYYY-MM-DD date.
 */
export function dayOf(date: string): number {
  const [, year, month, day] = DATE.exec(date) ?? [];
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError('A calendar date is written YYYY-MM-DD.');
  }
  return ms / DAY;
}

/** The week of `date`, counted from the week of 1970-01-01, each starting on a Monday. */
export function weekOf(date: string): number {
  // 1970-01-01 was a Thursday: three days on, a week starts.
  return Math.floor((dayOf(date) + 3) / 7);
}
