/**
 * The Dispatches view (`#/g/{groupId}/dispatches`; ADR-0003, ADR-0074,
 * #112): every Dispatch the group has had, newest first. Every level follows
 * the group, so everyone reads them. Send a Dispatch shows only for someone
 * `can()` lets send one, and never while they leave or once the group has
 * dissolved. This device's own Dispatch shows first while it waits to send.
 */
import { Link } from 'react-aria-components';

import { DispatchCard, WaitingDispatchCard } from '../app/DispatchCard';
import { waitingDispatches } from '../app/dispatchLines';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { BackLink, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import { newestFirst } from '../engine/dispatches';
import type { ParsedEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';

/** Props for {@link Dispatches}. */
export interface DispatchesProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** This device's events the relay hasn't accepted yet, oldest first. */
  readonly pending: readonly ParsedEvent[];
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
  /** Whether this device's leave waits for the relay (#77): then nothing new is sent. */
  readonly leaving?: boolean;
  /** Whether this copy came back from a backup and hasn't heard from its group (#231): the same. */
  readonly unconfirmed?: boolean;
}

/** Whether `me` may send a Dispatch from this screen now. */
function sends({ state, me, leaving = false, unconfirmed = false }: DispatchesProps): boolean {
  return !leaving && !unconfirmed && state.dissolved === null && can(state, me, 'dispatch');
}

/** Send a Dispatch, the one primary action here, for someone who may send one. */
function SendLink({ groupId }: { readonly groupId: string }) {
  return (
    <div className="row">
      <Link className="button button-primary" href={routeHref({ name: 'sendDispatch', groupId })}>
        {messages.dispatches.send}
      </Link>
    </div>
  );
}

/** The Dispatches: this device's waiting ones first, then the group's, newest first. */
function DispatchList(props: DispatchesProps) {
  const { state, me, pending, reachable } = props;
  const waiting = waitingDispatches(state, me, pending).reverse();
  const sent = newestFirst(state);
  if (waiting.length === 0 && sent.length === 0) return <p>{messages.dispatches.empty}</p>;
  return (
    <ul className="dispatch-list">
      {waiting.map((dispatch) => (
        <li key={dispatch.id}>
          <WaitingDispatchCard state={state} dispatch={dispatch} reachable={reachable} />
        </li>
      ))}
      {sent.map((dispatch) => (
        <li key={dispatch.id}>
          <DispatchCard state={state} dispatch={dispatch} level={2} />
        </li>
      ))}
    </ul>
  );
}

/** The group's Dispatches, newest first, with Send a Dispatch for whoever may send one. */
export function Dispatches(props: DispatchesProps) {
  const { state } = props;
  const groupId = state.group ?? '';
  const { dispatches } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId }} label={state.name} />
      <PageHeader title={dispatches.title} pageTitle={dispatches.pageTitle} />
      <p className="lede">{dispatches.lede}</p>
      {sends(props) ? <SendLink groupId={groupId} /> : null}
      <DispatchList {...props} />
    </main>
  );
}
