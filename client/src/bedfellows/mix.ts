/**
 * The mix (#479; ADR-0080 §4, §6): how many entries of each tier a view shows
 * at a dial position, and in what order a tier's entries take their turn.
 *
 * - **The dial** is a whole step from 0 to {@link TOP}. {@link SHARES} gives
 *   each step's share of `close`, `middle` and `strange`, in whole percent:
 *   mostly close kin at 0, mostly strange at the top.
 * - **Floors and ceilings:** every step keeps at least {@link FLOORS} of close
 *   kin and of strange entries and at most {@link CEILING} of any one tier.
 *   In a view of `size` entries a floor is `floorCount` entries (rounded down:
 *   a view too small to hold a share can't keep it) and a ceiling
 *   `ceilingCount` (rounded up, so a view of one can show one).
 * - **Filling:** a tier with too few entries leaves room the others fill, the
 *   tier furthest under its share first, but never past the ceiling: a view
 *   comes up short rather than turn into one tier. {@link mix} names each
 *   floor it couldn't keep.
 * - **Order without memory:** {@link turn} hashes a day, a seed and a salt
 *   into a number, and {@link rotate} turns a tier's list by it, so the same
 *   entries don't lead every day and no one has to remember what led.
 *
 * The values are first values (ADR-0080's open question on the clock's pace
 * and the floors): the simulation tests them and the pilot corrects them.
 * Everything here is pure.
 */
import type { Tier } from './types';

/** One step of the dial: each tier's share of a view, in whole percent, summing to 100. */
export type Shares = Readonly<Record<Tier, number>>;

/** A pick of a view and the floors it couldn't keep. */
export interface Mixed<T> {
  /** Close kin first, then middle, then strange, each tier in the order it came in. */
  readonly shown: T[];
  /** `close` and `strange`, as named, when the view holds fewer than their floor. */
  readonly unkept: Tier[];
}

/**
 * The dial's top step. Eight steps at one a week (`clock.ts`) take a reader
 * who opens Bedfellows weekly about two months from mostly close kin to
 * mostly strange: slow enough that each week's view is a small stretch.
 */
export const TOP = 8;

/**
 * The share of each tier at each step, in whole percent. At 0, 70% close kin,
 * so a new reader meets mostly familiar ground and still a few strange
 * entries; strange gains a little more each step (2, 3, 5, 5, 7, 8, 10, 10
 * points), slow at first, while close falls to its floor at the top; middle
 * stays near a quarter to a third throughout as the bridge between them.
 */
export const SHARES: readonly Shares[] = [
  { close: 70, middle: 20, strange: 10 },
  { close: 65, middle: 23, strange: 12 },
  { close: 58, middle: 27, strange: 15 },
  { close: 50, middle: 30, strange: 20 },
  { close: 42, middle: 33, strange: 25 },
  { close: 35, middle: 33, strange: 32 },
  { close: 27, middle: 33, strange: 40 },
  { close: 20, middle: 30, strange: 50 },
  { close: 15, middle: 25, strange: 60 },
];

/**
 * The floors, in whole percent. Close kin at least 15%, so even the top step
 * keeps some familiar ground to read the strange against; strange at least
 * 10%, so the view is never only the reader's own echo (ADR-0080 §6).
 */
export const FLOORS: Readonly<Record<'close' | 'strange', number>> = { close: 15, strange: 10 };

/** The ceiling, in whole percent: no tier above 70%, so no view is all one tier (ADR-0080 §6). */
export const CEILING = 70;

/** The order tiers are shown in. */
const TIER_ORDER: readonly Tier[] = ['close', 'middle', 'strange'];

/** `dial` as a step of the table: rounded, and kept within 0 and {@link TOP}; 0 for NaN. */
export function clampDial(dial: number): number {
  if (Number.isNaN(dial)) return 0;
  return Math.min(TOP, Math.max(0, Math.round(dial)));
}

/** Each tier's share of a view at `dial`, as a fraction of the whole. */
export function sharesAt(dial: number): Readonly<Record<Tier, number>> {
  const row = shareRow(dial);
  return { close: row.close / 100, middle: row.middle / 100, strange: row.strange / 100 };
}

/** The table's row at `dial`, in percent. */
function shareRow(dial: number): Shares {
  return SHARES[clampDial(dial)] ?? { close: 100, middle: 0, strange: 0 };
}

/** The fewest entries of `tier` a view of `size` keeps: its floor, rounded down; 0 for middle. */
export function floorCount(tier: Tier, size: number): number {
  const floor = tier === 'middle' ? 0 : FLOORS[tier];
  return Math.floor((floor * size) / 100);
}

/** The most entries of any one tier a view of `size` shows: the ceiling, rounded up. */
export function ceilingCount(size: number): number {
  return Math.ceil((CEILING * size) / 100);
}

/**
 * Each tier's count in a view of `size` at `row` when every tier has enough:
 * strange and close each rounded to the nearest whole entry (so strange's
 * count never falls as the dial turns out), and middle the rest.
 */
function targets(row: Shares, size: number): Record<Tier, number> {
  const strange = Math.round((row.strange * size) / 100);
  const close = Math.min(Math.round((row.close * size) / 100), size - strange);
  return { close, middle: size - strange - close, strange };
}

/** The tier furthest under its share that still has an entry to give and room under the ceiling. */
function nextToFill(
  counts: Readonly<Record<Tier, number>>,
  available: Readonly<Record<Tier, number>>,
  row: Shares,
  size: number,
): Tier | undefined {
  const cap = ceilingCount(size);
  const open = TIER_ORDER.filter((t) => counts[t] < available[t] && counts[t] < cap);
  const deficit = (t: Tier): number => row[t] * size - 100 * counts[t];
  return open.reduce<Tier | undefined>(
    (best, t) => (best === undefined || deficit(t) > deficit(best) ? t : best),
    undefined,
  );
}

/** How many of each tier a view of `size` at `row` shows, given how many each has. */
function counts(
  available: Readonly<Record<Tier, number>>,
  row: Shares,
  size: number,
): Record<Tier, number> {
  const goal = targets(row, size);
  const taken: Record<Tier, number> = {
    close: Math.min(goal.close, available.close),
    middle: Math.min(goal.middle, available.middle),
    strange: Math.min(goal.strange, available.strange),
  };
  let room = size - taken.close - taken.middle - taken.strange;
  for (let tier = nextToFill(taken, available, row, size); room > 0 && tier;) {
    taken[tier] += 1;
    room -= 1;
    tier = nextToFill(taken, available, row, size);
  }
  return taken;
}

/**
 * The view of at most `size` entries at `dial`, from each tier's entries in
 * the order the caller wants them taken: each tier its share, a short tier's
 * room filled by the others up to the ceiling, close kin first. It never
 * shows more than `size`, nor an entry twice unless the caller listed it twice.
 */
export function mix<T>(
  byTier: Readonly<Record<Tier, readonly T[]>>,
  dial: number,
  size: number,
): Mixed<T> {
  const whole = Math.max(0, Math.floor(size));
  if (whole === 0) return { shown: [], unkept: [] };
  const available = {
    close: byTier.close.length,
    middle: byTier.middle.length,
    strange: byTier.strange.length,
  };
  const taken = counts(available, shareRow(dial), whole);
  return {
    shown: TIER_ORDER.flatMap((tier) => byTier[tier].slice(0, taken[tier])),
    unkept: TIER_ORDER.filter((tier) => taken[tier] < floorCount(tier, whole)),
  };
}

/**
 * A whole number from `day`, `seed` and `salt` (FNV-1a over their text): the
 * same for the same three, and scattered across days, so a tier's lead moves.
 */
export function turn(day: number, seed: number, salt: string): number {
  let hash = 2_166_136_261;
  for (const char of `${String(day)}|${String(seed)}|${salt}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619) >>> 0;
  }
  return hash;
}

/** `items` turned left by `by`: the item at `by` (modulo the length) leads. */
export function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const start = by % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}
