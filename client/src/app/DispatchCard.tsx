/**
 * One Dispatch as a card (#112), on the Dispatches view and on Group home:
 * its title, who or which Proposal sent it and when, in relay time, its text
 * as plain pre-wrapped text (never Markdown, never auto-linked), and Open
 * with the Document's title when it points to one. Every name and title sits
 * in `<bdi>`.
 *
 * A coalition's Dispatch (#124) comes from a passed motion, whose vote lives
 * inside each member group, so its title is plain text there, and Open goes
 * to the coalition's own Document.
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

/** Where a Dispatch is read: a group's log, or a coalition's (#124). */
export type DispatchPlace = 'group' | 'coalition';

/** What a card's parts read: the log's state, the Dispatch, and whose log it is. */
interface PartProps {
  readonly state: GroupState;
  readonly dispatch: Dispatch;
  readonly place: DispatchPlace;
}

/**
 * "From Ana", or "From the Proposal ‘<title>’", the title linking to the
 * Proposal in a group, and plain in a coalition, whose motions are voted on
 * inside each member group (#124).
 */
function SenderLine({ state, dispatch, place }: PartProps) {
  const sender = senderOf(state, dispatch.by);
  const { from, fromProposal } = messages.dispatches;
  if (sender.kind === 'person') {
    return (
      <span>
        <Named parts={from} name={sender.name} />
      </span>
    );
  }
  const title = <bdi>{sender.title}</bdi>;
  const href = routeHref({ name: 'proposal', groupId: state.group ?? '', proposalId: sender.id });
  return (
    <span>
      {fromProposal.before}
      {place === 'group' ? <Link href={href}>{title}</Link> : title}
      {fromProposal.after}
    </span>
  );
}

/** Where Open goes: the group's Document `doc` (#92), or the coalition's (#124). */
function documentHref(state: GroupState, doc: string, place: DispatchPlace): string {
  const id = state.group ?? '';
  return place === 'group'
    ? routeHref({ name: 'document', groupId: id, documentId: doc })
    : routeHref({ name: 'coalitionDocument', coalitionId: id, documentId: doc });
}

/** "Open <Document title> →", when the Dispatch points to one of its log's Documents (#92). */
function OpenDocument({
  state,
  doc,
  place,
}: {
  state: GroupState;
  doc: string | null;
  place: DispatchPlace;
}) {
  const title = documentTitle(state, doc);
  if (doc === null || title === null) return null;
  return (
    <Link className="forward-link dispatch-open" href={documentHref(state, doc, place)}>
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
  /** Whose log it's from: a group's unless a coalition's (#124). */
  readonly place?: DispatchPlace;
}

/** One Dispatch: its title, sender and date, text, and Document. */
export function DispatchCard({ state, dispatch, level, place = 'group' }: DispatchCardProps) {
  const heading = useId();
  return (
    <article className="card dispatch" aria-labelledby={heading}>
      <Title id={heading} level={level} title={dispatch.title} />
      <p className="dispatch-meta">
        <SenderLine state={state} dispatch={dispatch} place={place} />
        <VisuallyHidden>{messages.home.levelSeparator}</VisuallyHidden>
        <span aria-hidden="true">{messages.dispatches.dateSeparator}</span>
        <time dateTime={minuteIso(dispatch.received)}>{formatDay(dispatch.received)}</time>
      </p>
      <Text text={dispatch.text} />
      <OpenDocument state={state} doc={dispatch.doc} place={place} />
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
      <OpenDocument state={state} doc={dispatch.doc ?? null} place="group" />
    </article>
  );
}
