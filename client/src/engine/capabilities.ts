/**
 * Involvement levels and the one permission check (ADR-0003, ADR-0021, ADR-0074).
 *
 * Each person chooses how involved they are: a Member follows along, a
 * Collaborator also votes, vouches and invites, and a Co-Creator also
 * proposes. Code asks `can()` for a capability and never compares level
 * names, and `LEVEL_CAPABILITIES` is the one map from levels to what they
 * allow, so a group could later supply its own map without touching a caller.
 * This file is the only place in src/ that spells out a level name, apart from
 * the golden vectors, which pin events' exact bytes.
 *
 * Stewards are an elected capability, not a level (ADR-0016, #102): holding a
 * seat adds {@link SEAT_CAPABILITIES} to a level's capabilities, and a
 * suspension leaves only {@link SUSPENDED_CAPABILITIES} until it ends, in
 * relay time. Once a removal of a member passes, they keep only
 * {@link REMOVED_CAPABILITIES} until a `remove` takes them out (#115).
 *
 * The voting levels need earned rights (ADR-0014, ADR-0021, #101): until a
 * member's `rightsAt` arrives in relay time, they hold only
 * {@link NEWCOMER_CAPABILITIES}, whatever level they chose. admission.ts
 * decides when rights arrive, and the fold records it on each member.
 */

/**
 * Something a member may do in a group. `suspend` (#102) and `narrow`, closing
 * an opt-in at once (#117), come with a steward seat, never a level.
 * `propose-removal` is any voting level's (ADR-0049, #115): a Collaborator
 * may propose removing someone, though not a change to the Document.
 */
export type Capability =
  | 'read'
  | 'see-roster'
  | 'vote'
  | 'vouch'
  | 'invite'
  | 'propose-removal'
  | 'propose'
  | 'suspend'
  | 'narrow';

/** The involvement levels, from following to creating. Screens list them in this order. */
export const LEVELS = ['member', 'collaborator', 'co-creator'] as const;

/** An involvement level. */
export type Level = (typeof LEVELS)[number];

/**
 * The capabilities each level holds. Every level reads the roster: hiding it
 * from Members stays deferred (ADR-0074, ADR-0072 item 12). Both voting
 * levels may propose a removal (ADR-0049, #115); the lists are flat, so each
 * names it.
 */
export const LEVEL_CAPABILITIES = {
  member: ['read', 'see-roster'],
  collaborator: ['read', 'see-roster', 'vote', 'vouch', 'invite', 'propose-removal'],
  'co-creator': ['read', 'see-roster', 'vote', 'vouch', 'invite', 'propose-removal', 'propose'],
} as const satisfies Record<Level, readonly Capability[]>;

/** The level genesis gives the group's founder. */
export const FOUNDER_LEVEL: Level = 'co-creator';

/** The level of a `join` that names none, and the one Join preselects. */
export const DEFAULT_JOIN_LEVEL: Level = 'collaborator';

/** True when `value` is one of {@link LEVELS}. */
export function isLevel(value: unknown): value is Level {
  return LEVELS.some((level) => level === value);
}

/** What a steward seat adds to its holder's level: suspending someone (#102) and narrowing an opt-in (#117). */
export const SEAT_CAPABILITIES = ['suspend', 'narrow'] as const satisfies readonly Capability[];

/**
 * What a newcomer holds until their voting rights arrive (ADR-0021, #101): a
 * Member's capabilities, whatever level they chose.
 */
export const NEWCOMER_CAPABILITIES = LEVEL_CAPABILITIES.member;

/** What a suspended member keeps until the suspension ends (ADR-0016): reading, and the roster. */
export const SUSPENDED_CAPABILITIES = [
  'read',
  'see-roster',
] as const satisfies readonly Capability[];

/**
 * What the person a removal names keeps from its final pass until a `remove`
 * takes them out of the group (ADR-0049, #115): reading, and nothing else.
 */
export const REMOVED_CAPABILITIES = ['read'] as const satisfies readonly Capability[];

/**
 * The part of a group's state that permissions read: who is a member, at
 * which level, and from which relay minute they hold voting rights (null
 * until they've earned them, #101); who holds a steward seat; the
 * suspensions; whom a removal has passed against (#115); and `at`, the relay
 * minute the state stands at (the fold's place in relay order, or the relay's
 * latest `now` once it has folded everything).
 */
export interface Roster {
  readonly members: readonly {
    readonly author: string;
    readonly level: Level;
    readonly rightsAt: number | null;
  }[];
  readonly stewards: readonly { readonly holder: string | null }[];
  readonly suspensions: readonly { readonly member: string; readonly until: number }[];
  readonly removals: readonly { readonly member: string }[];
  readonly at: number;
}

/** True when a member's voting rights have arrived by relay minute `at`. */
function arrived(rightsAt: number | null, at: number): boolean {
  return rightsAt !== null && rightsAt <= at;
}

/**
 * True when `member` belongs to the group and holds voting rights at
 * `state.at` (ADR-0014, ADR-0075 §3): from their `rightsAt` on, whatever level
 * they chose. Rights once earned stay, so stepping down and back up keeps them.
 */
export function holdsRights(state: Roster, member: string): boolean {
  return state.members.some((m) => m.author === member && arrived(m.rightsAt, state.at));
}

/** True once a removal of `member` has passed (#115): from its final pass on, they only read. */
export function isOusted(state: Pick<Roster, 'removals'>, member: string): boolean {
  return state.removals.some((removal) => removal.member === member);
}

/**
 * What `member`'s level grants once their rights have arrived, a Member's
 * capabilities before then (#101), reading alone once a removal of them has
 * passed (#115), or nothing for someone who isn't a member.
 */
function granted(state: Roster, member: string): readonly Capability[] {
  const found = state.members.find((m) => m.author === member);
  if (found === undefined) return [];
  if (isOusted(state, member)) return REMOVED_CAPABILITIES;
  return arrived(found.rightsAt, state.at)
    ? LEVEL_CAPABILITIES[found.level]
    : NEWCOMER_CAPABILITIES;
}

/** True while one of `member`'s suspensions runs: until its `until`, in relay minutes. */
export function isSuspended(state: Roster, member: string): boolean {
  return state.suspensions.some((s) => s.member === member && state.at < s.until);
}

/**
 * What `member` may do now: their level's capabilities, a seat's with a seat,
 * a suspension's two, or reading alone once a removal of them has passed.
 */
function current(state: Roster, member: string): readonly Capability[] {
  const level = granted(state, member);
  if (level.length === 0 || isOusted(state, member)) return level;
  if (isSuspended(state, member)) return SUSPENDED_CAPABILITIES;
  const seated = state.stewards.some((seat) => seat.holder === member);
  return seated ? [...level, ...SEAT_CAPABILITIES] : level;
}

/**
 * The only permission check: true when `member` belongs to the group and may
 * do `capability` now, by their level once their voting rights have arrived
 * (#101) and any steward seat, unless a suspension narrows them to reading
 * (#102, #117), or a removal of them has passed (#115).
 */
export function can(state: Roster, member: string, capability: Capability): boolean {
  return current(state, member).includes(capability);
}

/**
 * Whether `member` belongs in the eligible set of a Proposal that opens now
 * (ADR-0015 §1): they hold voting rights (#101) and their level grants
 * `vote`. It ignores suspensions, so a suspension never shrinks the
 * electorate (ADR-0075 §3): `can()` narrows a suspended member, and this
 * leaves them in. Someone a passed removal names is out (#115).
 */
export function wouldVote(state: Roster, member: string): boolean {
  return granted(state, member).includes('vote');
}

/**
 * How many people hold voting rights (ADR-0075 §3): the one count of "voting
 * members" the steward thresholds read (#102). It counts the members whose
 * rights have arrived ({@link holdsRights}) whatever level they chose, so a
 * Member who could step up counts, and a newcomer at a voting level who is
 * still waiting doesn't. A suspension doesn't lower it.
 */
export function votingRightsCount(state: Roster): number {
  return state.members.filter((m) => arrived(m.rightsAt, state.at)).length;
}
