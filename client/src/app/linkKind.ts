/**
 * What a pasted link is, and how a screen opens it (#423; ADR-0077 §6): link
 * in, route out. It holds no field and no React, so every place that takes a
 * link reads it the same way: Start's field, Discover's, and the floating
 * link bar to come (#444), which shows the kind before it opens anything.
 *
 * It reads an invite (spec §3), a reconcile card (#114), a coalition's follow
 * link (#124) and, where the screen opens one, a group's front door (#121).
 * Reading opens nothing. Opening hands the link to the screen's handler for
 * its kind, which holds a seed in memory, never in the address bar.
 */
import { parseCardLink } from '../coalition/card';
import { parseFollowLink } from '../coalition/follow';
import { base64url } from '../crypto/base64url';
import { parseDoorLink } from '../door/page';
import { parseInviteLink } from './invite';

/** What opens each kind of link: an invite always; the others where the screen was given a way. */
export interface LinkOpeners {
  /** Opens a pasted invite's seed. It travels in memory, never through the address bar. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** Opens a pasted reconcile card's seed (#114), in memory likewise. */
  readonly onOpenCard?: ((seed: Uint8Array) => void) | undefined;
  /** Opens a pasted follow link's seed (#124), in memory likewise. */
  readonly onOpenFollow?: ((seed: Uint8Array) => void) | undefined;
  /** Opens a pasted front door link's page (#121), by the address after `#door/`. */
  readonly onOpenDoor?: ((payload: string) => void) | undefined;
}

/** The kinds of link a screen reads. */
export type LinkKind = 'invite' | 'card' | 'follow' | 'door';

/** A link that was read: its kind, and the one way to open it. */
export interface KnownLink {
  readonly kind: LinkKind;
  /** Opens the link through the screen's handler for its kind; with none, does nothing. */
  readonly open: () => void;
}

/**
 * The link `text` is, or null for anything a screen with `openers` doesn't
 * read. A card or follow link is read even where nothing opens one, as Start
 * always has; a front door link only where the screen opens doors.
 */
export function readLink(text: string, openers: LinkOpeners): KnownLink | null {
  const invite = parseInviteLink(text);
  if (invite !== null) {
    return {
      kind: 'invite',
      open: () => {
        openers.onOpenInvite(invite);
      },
    };
  }
  const card = parseCardLink(text);
  if (card !== null) {
    return {
      kind: 'card',
      open: () => {
        openers.onOpenCard?.(card);
      },
    };
  }
  const follow = parseFollowLink(text);
  if (follow !== null) {
    return {
      kind: 'follow',
      open: () => {
        openers.onOpenFollow?.(follow);
      },
    };
  }
  return readDoor(text, openers.onOpenDoor);
}

/** The front door `text` names, where `onOpenDoor` opens one, or null. */
function readDoor(text: string, onOpenDoor: LinkOpeners['onOpenDoor']): KnownLink | null {
  if (onOpenDoor === undefined) return null;
  const door = parseDoorLink(text);
  if (door === null) return null;
  return {
    kind: 'door',
    open: () => {
      onOpenDoor(base64url(door));
    },
  };
}
