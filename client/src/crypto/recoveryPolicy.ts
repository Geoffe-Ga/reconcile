/**
 * How many recovery contacts a person picks, and how many of them it takes
 * to get back in (#109; ADR-0043 §1, ADR-0074).
 *
 * Each person chooses: from 2 of 3 up to 5 of 7, so 3 to 7 contacts, of whom
 * 2 to 5 are needed, and never more needed than picked. The picker starts at
 * 3 of 5. This file imports nothing, so the app can read the rule without
 * reaching any cryptography; `shares.ts` checks the same rule before it
 * splits a key.
 */

/** The fewest contacts: three. */
export const MIN_CONTACTS = 3;

/** The most contacts: seven. */
export const MAX_CONTACTS = 7;

/** The fewest contacts it takes to get back in: two, so no one contact can alone. */
export const MIN_NEEDED = 2;

/** The most contacts it can take to get back in: five. */
export const MAX_NEEDED = 5;

/** A threshold: `t` contacts needed of the `n` picked. */
export interface Threshold {
  readonly t: number;
  readonly n: number;
}

/** What the picker starts at: 3 of 5 (ADR-0043 §1). */
export const DEFAULT: Threshold = { t: 3, n: 5 };

/** Whether `value` is a whole number from `min` to `max`. */
function within(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Whether `t` of `n` is a threshold a person may choose: 3 ≤ n ≤ 7,
 * 2 ≤ t ≤ 5 and t ≤ n.
 */
export function isAllowedThreshold(t: number, n: number): boolean {
  return within(n, MIN_CONTACTS, MAX_CONTACTS) && within(t, MIN_NEEDED, MAX_NEEDED) && t <= n;
}

/** Every allowed threshold, by `n` and then `t`: the 17 pairs from 2 of 3 to 5 of 7. */
export const ALLOWED_THRESHOLDS: readonly Threshold[] = Array.from(
  { length: MAX_CONTACTS - MIN_CONTACTS + 1 },
  (_, i) => MIN_CONTACTS + i,
).flatMap((n) =>
  Array.from({ length: MAX_NEEDED - MIN_NEEDED + 1 }, (_, i) => ({ t: MIN_NEEDED + i, n })).filter(
    ({ t }) => isAllowedThreshold(t, n),
  ),
);
