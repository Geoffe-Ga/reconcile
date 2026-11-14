/**
 * The links whose seed is a secret (spec §9): an invite (spec §3), a
 * reconcile card (#114) and a coalition's follow link (#124). Each seed
 * leaves the address bar as soon as it's read and waits in memory, never in
 * browser history: under first run (#76, #280), and from the link bar (#444,
 * `openPasted`). A front door's address and a shared Document's link carry
 * no group secret, so they stay in the address bar (#121, #105). A linking or
 * recovery code is never a link at all: it never travels in a route
 * (`router.ts`), so nothing here holds one.
 */
import { cardLink, parseCardPayload } from '../coalition/card';
import { followLink, parseFollowPayload } from '../coalition/follow';
import { inviteLink, parseInvitePayload } from './invite';
import type { Route } from './router';

/** The kinds of link whose seed is held in memory. */
export type HeldLinkName = 'invite' | 'card' | 'follow';

/** The route of a held link's own page, with its seed out of the address bar. */
type HeldRoute = Extract<Route, { readonly name: 'join' | 'card' | 'follow' }>;

/** One kind of held link: its page's route, how its payload reads, and the link a seed makes. */
interface HeldLink {
  readonly route: HeldRoute['name'];
  readonly read: (payload: string) => Uint8Array | null;
  readonly link: (origin: string, seed: Uint8Array) => string;
}

/** Each kind of held link, by its name. */
export const HELD_LINKS: Readonly<Record<HeldLinkName, HeldLink>> = {
  invite: { route: 'join', read: parseInvitePayload, link: inviteLink },
  card: { route: 'card', read: parseCardPayload, link: cardLink },
  follow: { route: 'follow', read: parseFollowPayload, link: followLink },
};

/** The held link a route's page reads, or null for a route that reads none. */
export function heldLinkOf(route: Route): HeldLinkName | null {
  switch (route.name) {
    case 'join':
      return 'invite';
    case 'card':
    case 'follow':
      return route.name;
    default:
      return null;
  }
}

/** The page of the held link `name`, its seed already out of the address bar. */
export function heldRoute(name: HeldLinkName): HeldRoute {
  return { name: HELD_LINKS[name].route, payload: null };
}
