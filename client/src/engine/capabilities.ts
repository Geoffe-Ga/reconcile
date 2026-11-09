/**
 * Involvement levels and the one permission check (ADR-0003, ADR-0021, ADR-0073).
 *
 * The MVP foundation has one level, and every member holds it. Code asks
 * `can()` for a capability and never compares level names, so #90 can bring
 * back three levels without touching callers. This file is the only place in
 * src/ that spells out a level name.
 */

/** Something a member may do in a group. */
export type Capability = 'read' | 'propose' | 'vote' | 'invite' | 'see-roster';

/** An involvement level. The foundation has one. */
export type Level = 'co-creator';

/** The capabilities each level holds. */
export const LEVEL_CAPABILITIES: Readonly<Record<Level, readonly Capability[]>> = {
  'co-creator': ['read', 'propose', 'vote', 'invite', 'see-roster'],
};

/** The level every member holds in the MVP foundation. */
export const MVP_LEVEL: Level = 'co-creator';

/** The part of a group's state that permissions read: who is a member, at which level. */
export interface Roster {
  readonly members: readonly { readonly author: string; readonly level: Level }[];
}

/** The only permission check: true when `member` belongs to the group and their level holds `capability`. */
export function can(state: Roster, member: string, capability: Capability): boolean {
  const found = state.members.find((m) => m.author === member);
  return found !== undefined && LEVEL_CAPABILITIES[found.level].includes(capability);
}
