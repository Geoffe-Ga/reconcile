/**
 * What a pasted text is (#444; ADR-0077 §6): text in, kind and payload out,
 * with no field, no React and no side effects, so the link bar can say what a
 * link is before anything opens it, and search (#445) can tell a link from
 * words. It reads an invite (spec §3), a reconcile card (#114), a
 * coalition's follow link (#124), a group's front door (#121), a shared
 * Document (#105) and a vote (#472), each as the app makes it (`openPasted`
 * opens them).
 */
import { CARD_PREFIX, parseCardPayload } from '../coalition/card';
import { FOLLOW_PREFIX, parseFollowPayload } from '../coalition/follow';
import { LINK_CODE_PREFIX } from '../crypto/link';
import { RECOVERY_CODE_PREFIX } from '../crypto/recovery';
import { DOOR_PREFIX, parseDoorPayload } from '../door/page';
import { parseSharePayload, SHARE_PREFIX } from '../share/shareLink';
import { parseInvitePayload } from './invite';
import { readsAsVoteToken, VOTE_PREFIX } from './voteLink';

/** The kinds of link the link bar opens (#444). */
export type LinkKindName = 'invite' | 'card' | 'follow' | 'door' | 'shared' | 'vote';

/**
 * What a pasted text is (#444): a link of one kind, with what follows its
 * fragment's prefix; a link of one of those kinds whose payload doesn't read
 * (cut short, or changed); or no link at all.
 */
export type LinkKind =
  | { readonly kind: LinkKindName; readonly payload: string }
  | { readonly kind: CodeKind }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'not-a-link' };

/**
 * A code pasted where links go: a linking code (#96) or a recovery code
 * (#118). The bar only says where it goes; it never carries one, so the kind
 * holds none of it.
 */
export type CodeKind = 'linking-code' | 'recovery-code';

/** Each code's prefix, by its kind: recognized only to point to where the code goes. */
const CODES: readonly { readonly prefix: string; readonly kind: CodeKind }[] = [
  { prefix: LINK_CODE_PREFIX, kind: 'linking-code' },
  { prefix: RECOVERY_CODE_PREFIX, kind: 'recovery-code' },
];

/** A link the bar can open: one of the kinds, with its payload. */
export type OpenableLink = Extract<LinkKind, { readonly payload: string }>;

/** Each kind's fragment prefix, and whether a payload after it reads. */
const FRAGMENTS: readonly {
  readonly prefix: string;
  readonly kind: LinkKindName;
  readonly reads: (payload: string) => boolean;
}[] = [
  { prefix: '#join/', kind: 'invite', reads: (payload) => parseInvitePayload(payload) !== null },
  { prefix: CARD_PREFIX, kind: 'card', reads: (payload) => parseCardPayload(payload) !== null },
  {
    prefix: FOLLOW_PREFIX,
    kind: 'follow',
    reads: (payload) => parseFollowPayload(payload) !== null,
  },
  { prefix: DOOR_PREFIX, kind: 'door', reads: (payload) => parseDoorPayload(payload) !== null },
  {
    prefix: SHARE_PREFIX,
    kind: 'shared',
    reads: (payload) => parseSharePayload(payload) !== null,
  },
  { prefix: VOTE_PREFIX, kind: 'vote', reads: readsAsVoteToken },
];

/** What a chat app or a sentence puts before a link, and after it. */
const OPENERS = /^[<([{"'“‘]+/u;
const CLOSERS = /[>)\]}"'”’.,;:!?]+$/u;

/** The fragment `word` carries: itself when it starts with `#`, an http(s) link's, or null. */
function fragmentIn(word: string): string | null {
  const bare = word.replace(OPENERS, '').replace(CLOSERS, '');
  if (bare.startsWith('#')) return bare;
  if (!/^https?:\/\//iu.test(bare)) return null;
  try {
    return new URL(bare).hash;
  } catch {
    return null;
  }
}

/** The kind `fragment` names and whether its payload reads, or null for none of the app's. */
function readFragment(fragment: string): LinkKind | null {
  const match = FRAGMENTS.find(({ prefix }) => fragment.startsWith(prefix));
  if (match === undefined) return null;
  const payload = fragment.slice(match.prefix.length);
  return match.reads(payload) ? { kind: match.kind, payload } : { kind: 'damaged' };
}

/**
 * What `text` is: the first of the app's links in it that reads, as a whole
 * link from any origin (the app keys off its fragment, never visiting its
 * address) or its bare fragment, with whitespace, line breaks and words
 * around it; else a linking or recovery code's kind, by its prefix alone
 * (#444: the bar only points to where it goes); else damaged when it holds a
 * link that doesn't read; else no link. A bare seed names no kind, so it's
 * no link.
 */
export function linkKind(text: string): LinkKind {
  const words = text.split(/\s+/u);
  let damaged = false;
  for (const word of words) {
    const fragment = fragmentIn(word);
    const read = fragment === null ? null : readFragment(fragment);
    if (read?.kind === 'damaged') damaged = true;
    else if (read !== null) return read;
  }
  const code = codeIn(words);
  if (code !== null) return { kind: code };
  return damaged ? { kind: 'damaged' } : { kind: 'not-a-link' };
}

/** The kind of the first code among `words`, by its prefix alone, or null for none. */
function codeIn(words: readonly string[]): CodeKind | null {
  for (const word of words) {
    const bare = word.replace(OPENERS, '');
    const code = CODES.find(({ prefix }) => bare.startsWith(prefix));
    if (code !== undefined) return code.kind;
  }
  return null;
}
