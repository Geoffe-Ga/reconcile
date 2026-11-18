/**
 * Opening a link from the link bar (#444): through the same page the link
 * itself opens, the way Start's paste field opened it before. An invite, a
 * card or a follow link holds its seed in memory and goes to its page with
 * the seed already out of the address bar (`#/join`, `#/card`, `#/follow`),
 * so the seed never reaches browser history (`heldLinks.ts`). A front door's
 * address, a shared Document's link and a vote link carry no group secret,
 * and stay in the address bar as their own links do (#121, #105, #472).
 */
import { HELD_LINKS, heldRoute } from './heldLinks';
import type { OpenableLink } from './linkKind';
import { navigate } from './router';

/** Opens `link` through its own page, holding a seed in memory with `holdSeed`. */
export function openPasted(link: OpenableLink, holdSeed: (seed: Uint8Array) => void): void {
  if (link.kind === 'door' || link.kind === 'shared' || link.kind === 'vote') {
    navigate({ name: link.kind, payload: link.payload });
    return;
  }
  const seed = HELD_LINKS[link.kind].read(link.payload);
  if (seed === null) return;
  holdSeed(seed);
  navigate(heldRoute(link.kind));
}
