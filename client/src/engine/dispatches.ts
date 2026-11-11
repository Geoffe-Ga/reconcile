/**
 * Dispatches (#112; ADR-0003, ADR-0012, ADR-0074; docs/spec/phase-1-spec.md
 * §4, Dispatches).
 *
 * A Dispatch is news for the whole group: a title, a short plain text and,
 * optionally, a Document it points to. A Co-Creator sends one with a
 * `dispatch` event, or a Proposal carries one, which goes out when its pass is
 * final ("Updated: Mission statement"). Every level follows the group, so
 * everyone reads them (ADR-0003). The text lives only in the sealed group
 * log, and the wake a Dispatch rides says nothing (ADR-0012).
 *
 * The fold and the screens ask the same functions here
 * ({@link maySendDispatch}, {@link dispatchFits}, {@link documentIds}), so a
 * screen never offers what the fold would ignore. Pure: no I/O, no clock.
 */
import { can, type Roster } from './capabilities';
import type { CarriedDispatch, DispatchBody } from './event';
import { codePointLength } from './text';

/** The longest Dispatch title, in code points. */
export const DISPATCH_TITLE_MAX = 80;

/** The longest Dispatch text, in code points. */
export const DISPATCH_TEXT_MAX = 500;

/** Who a Dispatch is from: the member who sent it, or the Proposal whose pass carried it. */
export type DispatchSender = string | { readonly proposal: string };

/**
 * A Dispatch in the group's state. `id` is its `dispatch` event's id, or the
 * id of the Proposal that carried it. `doc` is the Document it points to, or
 * null. `received` is its relay receipt, or for a carried one the minute the
 * Proposal closed.
 */
export interface Dispatch {
  readonly id: string;
  readonly by: DispatchSender;
  readonly title: string;
  readonly text: string;
  readonly doc: string | null;
  readonly received: number;
}

/**
 * True when a Dispatch's title is 1–80 code points and its text at most 500,
 * counted as received: the author normalizes to NFC before signing, and the
 * fold never re-normalizes (spec §4).
 */
export function dispatchFits({ title, text }: CarriedDispatch): boolean {
  const titleLength = codePointLength(title);
  return (
    titleLength >= 1 &&
    titleLength <= DISPATCH_TITLE_MAX &&
    codePointLength(text) <= DISPATCH_TEXT_MAX
  );
}

/** What the Document checks read of a group: each Atom's Document. */
export interface DocumentState {
  readonly atoms: readonly { readonly documentId: string }[];
}

/** The ids of the group's Documents, in the order their first Atoms come. */
export function documentIds(state: DocumentState): string[] {
  return [...new Set(state.atoms.map((atom) => atom.documentId))];
}

/** What {@link maySendDispatch} reads: who may do what at `at`, and the group's Documents. */
export type DispatchState = Roster & DocumentState;

/**
 * Whether the fold takes `body` from `author` now: they hold `dispatch`
 * (`can()`, so a suspended member, a newcomer still earning a vote and anyone
 * who has left can't), the title and text fit, and any `doc` names one of the
 * group's Documents.
 */
export function maySendDispatch(state: DispatchState, author: string, body: DispatchBody): boolean {
  const { doc } = body;
  const known = doc === undefined || documentIds(state).includes(doc);
  return can(state, author, 'dispatch') && dispatchFits(body) && known;
}

/** What the screens read of a group's Dispatches: the fold's list, oldest first. */
export interface DispatchList {
  readonly dispatches: readonly Dispatch[];
}

/** The group's Dispatches newest first, as the Dispatches view lists them. */
export function newestFirst(state: DispatchList): Dispatch[] {
  return [...state.dispatches].reverse();
}

/** The group's latest Dispatch, which Group home shows, or null before any. */
export function latestDispatch(state: DispatchList): Dispatch | null {
  return state.dispatches.at(-1) ?? null;
}
