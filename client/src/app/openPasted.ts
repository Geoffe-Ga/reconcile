/**
 * Opening a link from the link bar (#444): through the same page the link
 * itself opens, the way Start's paste field opened it before. An invite, a
 * card or a follow link holds its seed in memory and goes to its page with
 * the seed already out of the address bar (`#/join`, `#/card`, `#/follow`),
 * so the seed never reaches browser history. A front door's address and a
 * shared Document's link carry no group secret, and stay in the address
 * bar as their own links do (#121, #105).
 */
import { parseCardPayload } from '../coalition/card';
import { parseFollowPayload } from '../coalition/follow';
import { parseInvitePayload } from './invite';
import type { OpenableLink } from './linkKind';
import { navigate } from './router';

/** The seed a pasted invite, card or follow link carries, by its kind. */
const SEEDS = {
  invite: { read: parseInvitePayload, route: { name: 'join', payload: null } },
  card: { read: parseCardPayload, route: { name: 'card', payload: null } },
  follow: { read: parseFollowPayload, route: { name: 'follow', payload: null } },
} as const;

/** Opens `link` through its own page, holding a seed in memory with `holdSeed`. */
export function openPasted(link: OpenableLink, holdSeed: (seed: Uint8Array) => void): void {
  if (link.kind === 'door' || link.kind === 'shared') {
    navigate({ name: link.kind, payload: link.payload });
    return;
  }
  const { read, route } = SEEDS[link.kind];
  const seed = read(link.payload);
  if (seed === null) return;
  holdSeed(seed);
  navigate(route);
}
