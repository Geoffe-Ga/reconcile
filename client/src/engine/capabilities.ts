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
 */

/** Something a member may do in a group. */
export type Capability = 'read' | 'see-roster' | 'vote' | 'vouch' | 'invite' | 'propose';

/** The involvement levels, from following to creating. Screens list them in this order. */
export const LEVELS = ['member', 'collaborator', 'co-creator'] as const;

/** An involvement level. */
export type Level = (typeof LEVELS)[number];

/**
 * The capabilities each level holds. Every level reads the roster: hiding it
 * from Members stays deferred (ADR-0074, ADR-0072 item 12).
 */
export const LEVEL_CAPABILITIES = {
  member: ['read', 'see-roster'],
  collaborator: ['read', 'see-roster', 'vote', 'vouch', 'invite'],
  'co-creator': ['read', 'see-roster', 'vote', 'vouch', 'invite', 'propose'],
} as const satisfies Record<Level, readonly Capability[]>;

/** The level genesis gives the group's founder. */
export const FOUNDER_LEVEL: Level = 'co-creator';

/** The level of a `join` that names none, and the one Join preselects. */
export const DEFAULT_JOIN_LEVEL: Level = 'collaborator';

/** True when `value` is one of {@link LEVELS}. */
export function isLevel(value: unknown): value is Level {
  return LEVELS.some((level) => level === value);
}

/** The part of a group's state that permissions read: who is a member, at which level. */
export interface Roster {
  readonly members: readonly { readonly author: string; readonly level: Level }[];
}

/** What `member`'s level grants, or nothing for someone who isn't a member. */
function granted(state: Roster, member: string): readonly Capability[] {
  const found = state.members.find((m) => m.author === member);
  return found === undefined ? [] : LEVEL_CAPABILITIES[found.level];
}

/** The only permission check: true when `member` belongs to the group and their level holds `capability`. */
export function can(state: Roster, member: string, capability: Capability): boolean {
  return granted(state, member).includes(capability);
}

/**
 * Whether `member` belongs in the eligible set of a Proposal that opens now
 * (ADR-0015 §1): their level, and from #101 their voting rights, would grant
 * `vote`. It ignores suspensions, so a suspension never shrinks the
 * electorate (ADR-0075 §3): #102 narrows `can()` for a suspended member and
 * leaves this alone.
 */
export function wouldVote(state: Roster, member: string): boolean {
  return granted(state, member).includes('vote');
}
