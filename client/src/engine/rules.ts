/**
 * A group's founding rules (docs/spec/phase-1-spec.md §4, §5 and §11; ADR-0015,
 * ADR-0051, ADR-0067, ADR-0074).
 *
 * Genesis records the rules, and the fold keeps them in `state.rules`. The MVP
 * founds every group with ADR-0067's Fellowship defaults and changes none of
 * them by vote (ADR-0074), so a genesis can only restate a default: it can't
 * lower a bar. Every Proposal gets its class from {@link targetClass} when it
 * opens, and its class picks the bar its vote must clear and bounds the window
 * its proposer chooses ({@link validWindow}, #106).
 * Integers only, like the tally: a bar is an average of at least
 * `avgAtLeast` with under `zerosUnderPercent`% zeros, compared as products.
 */
import type { ProposalBody } from './event';

/** How hard a change is: the class whose bar and window a Proposal gets. #115 adds removal's. */
export type ProposalClass = 'ordinary' | 'entrenched';

/** The class a founding rule is in, which decides the bar a change to it would need (ADR-0051). */
export type RuleClass = 'ordinary' | 'entrenched';

/**
 * What a version must reach to pass, among those who scored it: `sum ≥ avgAtLeast · n`
 * and `100 · zeros < zerosUnderPercent · n`.
 */
export interface Bar {
  readonly avgAtLeast: number;
  readonly zerosUnderPercent: number;
}

/** How long a class's votes may run, in whole days, and how long they run when no one chooses (#106). */
export interface WindowBounds {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/**
 * A group's founding rules. Quorum per version is min(eligible, max(`min`,
 * ⌈`percent`% of eligible⌉)) scorers (ADR-0073). #101 reads `vouches` and
 * `waitDays`, and #111 reads `ballotExpiryDays`. #102 and #117 add their own
 * fields here, each with its class in {@link RULE_CLASS}.
 */
export interface Rules {
  readonly bars: Readonly<Record<ProposalClass, Bar>>;
  readonly windows: Readonly<Record<ProposalClass, WindowBounds>>;
  readonly quorum: { readonly min: number; readonly percent: number };
  readonly vouches: number;
  readonly waitDays: number;
  readonly ballotExpiryDays: number;
}

/**
 * The founding rules every MVP group has: ADR-0067's Fellowship defaults, the
 * consent floor (ADR-0002), the entrenched bar (ADR-0015 §2), ADR-0074's windows
 * and ADR-0073's quorum. Create group writes them into genesis as they are.
 */
export const DEFAULT_RULES = {
  bars: {
    ordinary: { avgAtLeast: 2, zerosUnderPercent: 10 },
    entrenched: { avgAtLeast: 3, zerosUnderPercent: 5 },
  },
  windows: {
    ordinary: { min: 3, max: 14, default: 7 },
    entrenched: { min: 14, max: 28, default: 14 },
  },
  quorum: { min: 3, percent: 30 },
  vouches: 2,
  waitDays: 14,
  ballotExpiryDays: 30,
} as const satisfies Rules;

/**
 * Each founding rule's class (ADR-0051). The pass rules and quorum are
 * entrenched; the windows, vouches, the wait before voting and ballot expiry
 * are ordinary. Changing a rule by vote stays deferred apart from #117's
 * opt-ins, which add their own class here.
 */
export const RULE_CLASS = {
  bars: 'entrenched',
  windows: 'ordinary',
  quorum: 'entrenched',
  vouches: 'ordinary',
  waitDays: 'ordinary',
  ballotExpiryDays: 'ordinary',
} as const satisfies Record<keyof Rules, RuleClass>;

/** Relay minutes in a day. */
export const DAY_MINUTES = 1_440;

/** A JSON object: a value that is an object, not null and not a list. */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `given` restates `defaults`: a missing field (`undefined`) at any
 * depth takes its default, every field that is present equals its default, and
 * fields the defaults don't name are left out. Only own fields count.
 */
function restates(defaults: unknown, given: unknown): boolean {
  if (given === undefined) return true;
  if (!isObject(defaults)) return given === defaults;
  if (!isObject(given)) return false;
  return Object.entries(defaults).every(([key, value]) =>
    restates(value, Object.hasOwn(given, key) ? given[key] : undefined),
  );
}

/**
 * The rules a genesis founds its group with: {@link DEFAULT_RULES}, or null
 * when its `rules` can't found a group. A genesis without `rules`, or without
 * some field of them, takes the default, so geneses from before #94 stay
 * valid. A field that differs from its default refuses the genesis, so a
 * hand-made one can't lower a bar. A field this engine doesn't know is left
 * out, so a newer device's genesis still founds the group here; the newer
 * engine checks that field itself. A later change to a default must keep
 * accepting the old value.
 */
export function foundingRules(rules: unknown): Rules | null {
  return restates(DEFAULT_RULES, rules) ? DEFAULT_RULES : null;
}

/** What {@link targetClass} may read of a group: its state at the Proposal's place in relay order. */
export interface ClassState {
  readonly rules: Rules;
}

/** How a Proposal's class is found, from the group's state when it opens and the Proposal's own body. */
export type TargetClassifier = (state: ClassState, proposal: ProposalBody) => ProposalClass;

/**
 * The class of the change a Proposal makes, computed from state when it opens
 * and never from a field the proposer writes, so nobody can understate a
 * change. The fold stores it as the Proposal's `class`. Every target is
 * ordinary today: entrenched sections (#116), removal (#115), widening an
 * opt-in (#117) and dissolution (#108) each add their case here.
 */
export const targetClass: TargetClassifier = () => 'ordinary';

/** How long a vote of class `cls` runs when the proposer names no window, in relay minutes. */
export function defaultWindowMinutes(rules: Rules, cls: ProposalClass): number {
  return rules.windows[cls].default * DAY_MINUTES;
}

/**
 * True when a proposer may choose `days` for a vote of class `cls` (#106,
 * ADR-0074): a whole number from `windows[cls].min` to `windows[cls].max`,
 * both included. The composer checks it as the proposer types; the fold
 * ignores a Proposal whose window fails it.
 */
export function validWindow(rules: Rules, cls: ProposalClass, days: number): boolean {
  const { min, max } = rules.windows[cls];
  return Number.isInteger(days) && days >= min && days <= max;
}

/**
 * How many whole days a Proposal of class `cls` runs: the `window` its
 * proposer chose, or the class default when it names none. Null when the
 * window it names fails {@link validWindow}, so the fold ignores the Proposal.
 */
export function chosenWindow(
  rules: Rules,
  cls: ProposalClass,
  window: number | undefined,
): number | null {
  if (window === undefined) return rules.windows[cls].default;
  return validWindow(rules, cls, window) ? window : null;
}
