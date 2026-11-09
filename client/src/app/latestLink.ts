/**
 * The group's discussion link (ADR-0011, as ADR-0073 cut it): there is no
 * group-wide chat setting, so the latest Proposal's link is the default.
 */
import type { GroupState } from '../engine/fold';
import { isHttpLink } from './links';

/**
 * The link of the most recent Proposal, in relay order, that carries an
 * `http:` or `https:` link, or else genesis's chat link when it is one, or null.
 * The composer prefills it, and Group home's Join discussion points at it.
 */
export function latestLink(state: GroupState): string | null {
  const links = [state.chat, ...state.proposals.map((proposal) => proposal.link)];
  for (const link of links.reverse()) {
    if (link !== null && isHttpLink(link)) return link;
  }
  return null;
}
