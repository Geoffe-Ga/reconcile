/**
 * Numbers and dates as the consent meter and the result show them (#74;
 * docs/spec/phase-1-spec.md §5 and §8).
 *
 * Every number a person reads is worked out in whole numbers, so a shown
 * value can never cross a line the exact one doesn't: an average floors to
 * one decimal, a share of zeros floors to a whole percent, and a shortfall
 * rounds up and never reads "0.0". So an exact average of 1.96 reads "1.9 ·
 * Short by 0.1", never the line itself. The lines come from the bar the engine tallied
 * against, so nothing here holds a threshold of its own.
 */
import { SCORE_MAX } from '../engine/event';
import type { Bar } from '../engine/rules';
import type { VersionTotals } from '../engine/tally';
import { messages } from './messages';
import { MINUTE_MS } from './time';

/** A version's scorer count and score total. */
type SumOf = Pick<VersionTotals, 'sum' | 'scorers'>;
/** A version's scorer count and zero count. */
type ZerosOf = Pick<VersionTotals, 'zeros' | 'scorers'>;

/** ⌊a / b⌋ for a ≥ 0 and b > 0, exactly: the remainder comes off before dividing. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/** ⌈a / b⌉ for a ≥ 0 and b > 0, exactly. */
function ceilDiv(a: number, b: number): number {
  return floorDiv(a + b - 1, b);
}

/** A count of tenths as a decimal, such as 19 → "1.9". */
function tenths(count: number): string {
  return `${String(floorDiv(count, 10))}.${String(count % 10)}`;
}

/** The average score, floored to one decimal: "1.9" for an exact 1.96. "0.0" before anyone scores. */
export function formatAverage({ sum, scorers }: SumOf): string {
  return scorers === 0 ? tenths(0) : tenths(floorDiv(10 * sum, scorers));
}

/**
 * How far the average falls short of the bar, rounded up to one decimal, so
 * it is never "0.0": "0.1" for an exact 1.96 against a line of 2. Null once it meets
 * the bar. `bar` is the one the engine tallied against.
 */
export function formatShortfall({ sum, scorers }: SumOf, bar: Bar): string | null {
  const missing = 10 * (bar.avgAtLeast * scorers - sum);
  return missing <= 0 || scorers === 0 ? null : tenths(ceilDiv(missing, scorers));
}

/** The share of scorers who gave a 0, floored to a whole percent: "9%" for 1 in 11. */
export function formatZeroShare({ zeros, scorers }: ZerosOf): string {
  const percent = scorers === 0 ? 0 : floorDiv(100 * zeros, scorers);
  return messages.meter.percent(percent);
}

/** The average a version must reach, to one decimal: the bar's `avgAtLeast`. */
export function formatAverageLine(bar: Bar): string {
  return tenths(10 * bar.avgAtLeast);
}

/** The share of zeros a version must stay under, as a percent: the bar's `zerosUnderPercent`. */
export function formatZeroLine(bar: Bar): string {
  return messages.meter.percent(bar.zerosUnderPercent);
}

/**
 * Where each bar's line sits, as a share of the bar's width: the average's
 * line on the 0–4 scale, and the zeros' line on 0–100%.
 */
export function lineShare(bar: Bar): { readonly average: number; readonly zeros: number } {
  return { average: bar.avgAtLeast / SCORE_MAX, zeros: bar.zerosUnderPercent / 100 };
}

/** How full the average's bar is, from 0 to 1. Only its width; the words carry the value. */
export function averageShare({ sum, scorers }: SumOf): number {
  return scorers === 0 ? 0 : sum / (scorers * SCORE_MAX);
}

/** How full the zeros' bar is, from 0 to 1. */
export function zeroShare({ zeros, scorers }: ZerosOf): number {
  return scorers === 0 ? 0 : zeros / scorers;
}

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };

/** A relay minute as a short date in the device's time zone, such as "Mon 16 Nov". */
export function formatDay(minute: number, timeZone?: string): string {
  const zone = timeZone === undefined ? {} : { timeZone };
  return new Intl.DateTimeFormat(messages.app.locale, { ...DAY, ...zone }).format(
    minute * MINUTE_MS,
  );
}
