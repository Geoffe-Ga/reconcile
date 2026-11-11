/**
 * A group's founding rules (docs/spec/phase-1-spec.md §4, §5 and §11; ADR-0015,
 * ADR-0040, ADR-0051, ADR-0067, ADR-0074).
 *
 * Genesis records the rules, and the fold keeps them in `state.rules`. The MVP
 * founds every group with ADR-0067's Fellowship defaults (ADR-0074), so a
 * genesis can only restate a default: it can't lower a bar or open an opt-in.
 * The opt-ins are the one exception to "no rule changes by vote": a rules
 * Proposal sets them (optIns.ts, #117), and the fold keeps each one's
 * standing value in `state.rules.optIns`. Every Proposal gets its class from
 * {@link targetClass} when it opens, and its class picks the bar its vote
 * must clear and bounds the window its proposer chooses ({@link validWindow},
 * #106).
 * Integers only, like the tally: a bar is an average of at least
 * `avgAtLeast` with under `zerosUnderPercent`% zeros, compared as products.
 */
import {
  isClassProposal,
  isDissolveProposal,
  isMoveProposal,
  isRulesProposal,
  type ProposalEventBody,
} from './event';
import { isOptIn, isWider, type OptIns } from './optIns';

/** How hard a change is: the class whose bar and window a Proposal gets. #115 adds removal's. */
export type ProposalClass = 'ordinary' | 'entrenched';

/**
 * The class a founding rule is in, which decides the bar a change to it would
 * need (ADR-0051). `opt-in` is the opt-ins' own: widening one is entrenched
 * and narrowing it ordinary (ADR-0040, {@link targetClass}).
 */
export type RuleClass = 'ordinary' | 'entrenched' | 'opt-in';

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
 * When a group's steward seats open and how long a term runs (ADR-0049,
 * ADR-0075 §3): the first election at `firstElectionAt` voting members, the
 * second seat at `secondSeatAt`, and terms of `termDays`.
 */
export interface StewardRules {
  readonly firstElectionAt: number;
  readonly secondSeatAt: number;
  readonly termDays: number;
}

/**
 * A group's founding rules. Quorum per version is min(eligible, max(`min`,
 * ⌈`percent`% of eligible⌉)) scorers (ADR-0073). #101 reads `vouches` and
 * `waitDays`, #111 reads `ballotExpiryDays`, #102 reads `stewards` and
 * `suspensionDays`, and #117 keeps each opt-in's standing value in `optIns`.
 * Each field has its class in {@link RULE_CLASS}.
 */
export interface Rules {
  readonly bars: Readonly<Record<ProposalClass, Bar>>;
  readonly windows: Readonly<Record<ProposalClass, WindowBounds>>;
  readonly quorum: { readonly min: number; readonly percent: number };
  readonly vouches: number;
  readonly waitDays: number;
  readonly ballotExpiryDays: number;
  readonly stewards: StewardRules;
  readonly suspensionDays: number;
  readonly optIns: OptIns;
}

/**
 * The founding rules every MVP group has: ADR-0067's Fellowship defaults, the
 * consent floor (ADR-0002), the entrenched bar (ADR-0015 §2), ADR-0074's windows,
 * ADR-0073's quorum, ADR-0049's steward seats, ADR-0016's 7-day suspension,
 * and both opt-ins off (ADR-0038, ADR-0039). Create group writes them into
 * genesis as they are.
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
  stewards: { firstElectionAt: 3, secondSeatAt: 6, termDays: 182 },
  suspensionDays: 7,
  optIns: { chatBot: null, frontDoor: false },
} as const satisfies Rules;

/**
 * Each founding rule's class (ADR-0051). The pass rules, quorum, the steward
 * seats and the suspension's length are entrenched; the windows, vouches, the
 * wait before voting and ballot expiry are ordinary. Changing a rule by vote
 * stays deferred apart from the opt-ins (#117), whose class is their own.
 */
export const RULE_CLASS = {
  bars: 'entrenched',
  windows: 'ordinary',
  quorum: 'entrenched',
  vouches: 'ordinary',
  waitDays: 'ordinary',
  ballotExpiryDays: 'ordinary',
  stewards: 'entrenched',
  suspensionDays: 'entrenched',
  optIns: 'opt-in',
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

/**
 * A section's class (#116; ADR-0015 §2–3): ordinary; entrenched, so a change,
 * removal or move of it needs the entrenched bar and window; or eternal, so no
 * vote changes, moves or removes it. Every section starts ordinary, and only a
 * class Proposal's pass changes it.
 */
export type AtomClass = 'ordinary' | 'entrenched' | 'eternal';

/** The three section classes, the weakest first. */
export const ATOM_CLASSES: readonly AtomClass[] = ['ordinary', 'entrenched', 'eternal'];

/**
 * A class Proposal's target as the fold keeps it (#116): the section, and the
 * class its pass gives it, which {@link classChangeIsValid} allowed when it
 * opened.
 */
export interface ClassChange {
  readonly kind: 'class';
  readonly atom: string;
  readonly to: AtomClass;
}

/** What the class rules read of a section: its id and its class (#116). */
export interface ClassedSection {
  readonly id: string;
  readonly class: AtomClass;
}

/**
 * The classes a class Proposal may give a section of class `from` (#116), in
 * the order the composer offers them: an ordinary section may become
 * entrenched or eternal, an entrenched one eternal or ordinary again, and an
 * eternal one nothing, ever.
 */
export function classChoices(from: AtomClass): readonly AtomClass[] {
  switch (from) {
    case 'ordinary':
      return ['entrenched', 'eternal'];
    case 'entrenched':
      return ['eternal', 'ordinary'];
    case 'eternal':
      return [];
  }
}

/**
 * True when a class Proposal may take a section of class `from` to `to`
 * (#116): `to` is a class {@link classChoices} offers, so never the class it
 * has, and never anything for an eternal section.
 */
export function classChangeIsValid(from: AtomClass, to: string): to is AtomClass {
  return classChoices(from).some((choice) => choice === to);
}

/** The class of section `id` in `state`, or ordinary for a section it doesn't hold. */
export function classOfSection(
  state: { readonly atoms: readonly ClassedSection[] },
  id: string,
): AtomClass {
  return state.atoms.find((atom) => atom.id === id)?.class ?? 'ordinary';
}

/**
 * What {@link targetClass} may read of a group: its state at the Proposal's
 * place in relay order, its sections and their classes included (#116).
 */
export interface ClassState {
  readonly rules: Rules;
  readonly atoms: readonly ClassedSection[];
}

/** How a Proposal's class is found, from the group's state when it opens and the Proposal's own body. */
export type TargetClassifier = (state: ClassState, proposal: ProposalEventBody) => ProposalClass;

/**
 * The section a Proposal changes in place, moves or removes: an edit's Atom,
 * a removal's included, or a move's (#103). Null for any other Proposal, an
 * add included, whose anchor it leaves as it is (#116).
 */
function sectionChanged(proposal: ProposalEventBody): string | null {
  if ('atom' in proposal) return proposal.atom;
  return isMoveProposal(proposal) ? proposal.target.atom : null;
}

/**
 * The class of the change a Proposal makes, computed from state when it opens
 * and never from a field the proposer writes, so nobody can understate a
 * change. The fold stores it as the Proposal's `class`. Dissolving the group
 * is entrenched (ADR-0051, #108), and so is a rules Proposal that widens an
 * opt-in from its standing value (ADR-0040, #117). A class Proposal is
 * entrenched whatever it asks, so entrenchment is itself entrenched, and so
 * is a change, a removal or a move of an entrenched section (ADR-0015, #116).
 * Every other target is ordinary, steward elections and recalls included
 * (ADR-0049), and so is an add, wherever its anchor: removal (#115) adds its
 * case here.
 */
export const targetClass: TargetClassifier = (state, proposal) => {
  if (isDissolveProposal(proposal) || isClassProposal(proposal)) return 'entrenched';
  if (isRulesProposal(proposal)) {
    const { optIn, value } = proposal.target;
    const wider = isOptIn(optIn) && isWider(optIn, state.rules.optIns[optIn], value);
    return wider ? 'entrenched' : 'ordinary';
  }
  const section = sectionChanged(proposal);
  const entrenched = section !== null && classOfSection(state, section) === 'entrenched';
  return entrenched ? 'entrenched' : 'ordinary';
};

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
