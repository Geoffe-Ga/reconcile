/**
 * One Dispatch as a card (#112), on the Dispatches view and on Group home:
 * its title, who or which Proposal sent it and when, in relay time, its text
 * as plain pre-wrapped text (never Markdown, never auto-linked), and Open
 * with the Document's title when it points to one. Every name and title sits
 * in `<bdi>`.
 */
import { useId } from 'react';
import { Link, VisuallyHidden } from 'react-aria-components';

import type { Dispatch } from '../engine/dispatches';
import type { GroupState } from '../engine/fold';
import { documentTitle, senderOf, type WaitingDispatch } from './dispatchLines';
import { formatDay } from './format';
import { messages } from './messages';
import { routeHref } from './router';
import { SendStatus } from './SendStatus';
import { Named } from './stewards';
import { minuteIso } from './time';

/** A card's heading level: 2 on the Dispatches view, 3 under Group home's Dispatches section. */
export type DispatchHeadingLevel = 2 | 3;

/** "From Ana", or "From the Proposal ‘<title>’" with the title linking to the Proposal. */
function SenderLine({ state, dispatch }: { state: GroupState; dispatch: Dispatch }) {
  const sender = senderOf(state, dispatch.by);
  const { from, fromProposal } = messages.dispatches;
  if (sender.kind === 'person') {
    return (
      <span>
        <Named parts={from} name={sender.name} />
      </span>
    );
  }
  const href = routeHref({ name: 'proposal', groupId: state.group ?? '', proposalId: sender.id });
  return (
    <span>
      {fromProposal.before}
      <Link href={href}>
        <bdi>{sender.title}</bdi>
      </Link>
      {fromProposal.after}
    </span>
  );
}

/** "Open <Document title> →", when the Dispatch points to a Document. */
function OpenDocument({ state, doc }: { state: GroupState; doc: string | null }) {
  const title = documentTitle(state, doc);
  if (title === null) return null;
  return (
    <Link
      className="forward-link dispatch-open"
      href={routeHref({ name: 'document', groupId: state.group ?? '' })}
    >
      <span>
        {messages.dispatches.open} <bdi>{title}</bdi>
      </span>
      <span aria-hidden="true">{messages.app.forward}</span>
    </Link>
  );
}

/** The card's title, at its level. */
function Title({ id, level, title }: { id: string; level: DispatchHeadingLevel; title: string }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <Heading id={id} className="heading-3 dispatch-title">
      <bdi>{title}</bdi>
    </Heading>
  );
}

/** The text, when there is any, as plain text that keeps its line breaks. */
function Text({ text }: { readonly text: string }) {
  return text === '' ? null : (
    <p className="dispatch-text" dir="auto">
      {text}
    </p>
  );
}

/** Props for {@link DispatchCard}. */
export interface DispatchCardProps {
  readonly state: GroupState;
  readonly dispatch: Dispatch;
  readonly level: DispatchHeadingLevel;
}

/** One Dispatch: its title, sender and date, text, and Document. */
export function DispatchCard({ state, dispatch, level }: DispatchCardProps) {
  const heading = useId();
  return (
    <article className="card dispatch" aria-labelledby={heading}>
      <Title id={heading} level={level} title={dispatch.title} />
      <p className="dispatch-meta">
        <SenderLine state={state} dispatch={dispatch} />
        <VisuallyHidden>{messages.home.levelSeparator}</VisuallyHidden>
        <span aria-hidden="true">{messages.dispatches.dateSeparator}</span>
        <time dateTime={minuteIso(dispatch.received)}>{formatDay(dispatch.received)}</time>
      </p>
      <Text text={dispatch.text} />
      <OpenDocument state={state} doc={dispatch.doc} />
    </article>
  );
}

/** Props for {@link WaitingDispatchCard}. */
export interface WaitingDispatchCardProps {
  readonly state: GroupState;
  readonly dispatch: WaitingDispatch;
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
}

/** This device's own Dispatch while it waits in the outbox: where it has got to in place of a date. */
export function WaitingDispatchCard({ state, dispatch, reachable }: WaitingDispatchCardProps) {
  const heading = useId();
  return (
    <article className="card dispatch" aria-labelledby={heading}>
      <Title id={heading} level={2} title={dispatch.title} />
      <SendStatus pending reachable={reachable} sent={false} />
      <Text text={dispatch.text} />
      <OpenDocument state={state} doc={dispatch.doc ?? null} />
    </article>
  );
}
