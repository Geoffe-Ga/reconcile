/**
 * Members' names as the screens show them (spec §3, "Names"; ADR-0045 as cut
 * by ADR-0073).
 *
 * A name is fixed at join and never has to be unique. When two members' names
 * match after NFC, trimming and lower-casing, each shows a short suffix from
 * its key, so the group can tell them apart. Lookalike names that don't match
 * this way are left to the group to sort out by talking. Screens render every
 * name inside `<bdi>`, so a right-to-left name can't reorder the text around it.
 */
import { sha256 } from '../crypto/hash';
import { fromBase64url } from './event';
import type { GroupState } from './fold';

/** What sits between a name and its key suffix. */
export const NAME_SUFFIX_SEPARATOR = ' · ';

/** How many bytes of the key's SHA-256 the suffix shows: 2 bytes, 4 hex characters. */
const SUFFIX_BYTES = 2;

/** The form two names are compared in. */
function comparable(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** The first 4 hex characters of the SHA-256 of the key's 32 bytes. */
function keySuffix(author: string): string {
  const digest = sha256(fromBase64url(author)).subarray(0, SUFFIX_BYTES);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The name to show for the member with key `author`: their name, plus
 * {@link NAME_SUFFIX_SEPARATOR} and a key suffix when another member's name
 * matches it. Null for a key that isn't a member.
 */
export function displayName(state: Pick<GroupState, 'members'>, author: string): string | null {
  const member = state.members.find((m) => m.author === author);
  if (member === undefined) return null;
  const name = comparable(member.name);
  const shared = state.members.some((m) => m.author !== author && comparable(m.name) === name);
  return shared ? `${member.name}${NAME_SUFFIX_SEPARATOR}${keySuffix(author)}` : member.name;
}
