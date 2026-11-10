/**
 * What the Dispatch screens say about a Dispatch (#112), apart from any
 * component: who it came from, the Document it points to, and this device's
 * own Dispatches still waiting in the outbox.
 */
import type { DispatchBody, ParsedEvent } from '../engine/event';
import type { DispatchSender } from '../engine/dispatches';
import type { GroupState } from '../engine/fold';
import { displayName } from '../engine/names';

/** Who a Dispatch came from, as its card names them: a member by name, or a Proposal by title. */
export type Sender =
  | { readonly kind: 'member'; readonly name: string }
  | { readonly kind: 'proposal'; readonly id: string; readonly title: string };

/**
 * Who sent a Dispatch: the member, named as everywhere else (former members
 * too), or the Proposal that carried it, by its title.
 */
export function senderOf(state: GroupState, by: DispatchSender): Sender {
  if (typeof by === 'string') return { kind: 'member', name: displayName(state, by) ?? '' };
  const title = state.proposals.find((proposal) => proposal.id === by.proposal)?.title ?? '';
  return { kind: 'proposal', id: by.proposal, title };
}

/**
 * The title of the Document a Dispatch points to, or null for none. In the
 * MVP a group has one Document, whose id is the genesis id and whose title
 * genesis set.
 */
export function documentTitle(state: GroupState, doc: string | null): string | null {
  return doc !== null && doc === state.group ? state.title : null;
}

/** A Dispatch of this device's still in the outbox: its event id and body. */
export interface WaitingDispatch extends DispatchBody {
  readonly id: string;
}

/**
 * This member's Dispatches still in the outbox, oldest first, leaving out any
 * whose copy the relay has already returned, so none shows twice.
 */
export function waitingDispatches(
  state: GroupState,
  me: string,
  pending: readonly ParsedEvent[],
): WaitingDispatch[] {
  const folded = new Set(state.dispatches.map((dispatch) => dispatch.id));
  return pending.flatMap(({ event, id }) =>
    event.type === 'dispatch' && event.author === me && !folded.has(id)
      ? [{ id, ...event.body }]
      : [],
  );
}
