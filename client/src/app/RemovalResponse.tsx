/**
 * The one response the person a removal names may post on its ballot
 * (ADR-0049, ADR-0072 §4, #115).
 *
 * Everyone reads it under "<name>’s response", as plain text inside `<bdi>`,
 * never Markdown or HTML, with its line breaks kept. While the vote is open
 * and they haven’t responded, the person it names gets a one-time form, even
 * while suspended, and everyone else reads that they haven’t. Their own
 * response shows with its sending status until the relay has it. The engine
 * decides who may respond (src/engine/removal.ts), so the form never offers
 * what the fold would ignore.
 */
import { type ReactNode, type SyntheticEvent, useId, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import type { ParsedEvent } from '../engine/event';
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';
import { mayRespond, removalTarget, responseTo } from '../engine/removal';
import { messages } from './messages';
import { checkResponse } from './proposalFields';
import { SendStatus } from './SendStatus';
import { Field } from './ui';
import { useSaving } from './useSaving';

/** Props for {@link RemovalResponse}. */
export interface RemovalResponseProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The Proposal; nothing shows unless it is a removal. */
  readonly proposal: Proposal;
  /** This device's events the relay hasn't accepted yet, oldest first. */
  readonly pending: readonly ParsedEvent[];
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
  /** The relay's minute now, as this device estimates it. */
  readonly now: number;
  /** Whether this device takes nothing new: it is leaving, or the group only reads here. */
  readonly readOnly: boolean;
  /** Queues this member's response; without it, no form shows. */
  readonly onRespond?: (text: string) => Promise<void>;
}

/** "<name>’s response" over the response's text, plain, its line breaks kept, and anything below. */
function ResponseText(props: {
  readonly name: string;
  readonly text: string;
  readonly children?: ReactNode;
}) {
  const heading = useId();
  return (
    <section className="removal-response" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        <bdi>{props.name}</bdi>
        {messages.removal.responseOf}
      </h2>
      <p className="response-text">
        <bdi>{props.text}</bdi>
      </p>
      {props.children}
    </section>
  );
}

/** The one-time form: the response, then Post your response. */
function RespondForm({ onRespond }: { readonly onRespond: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const { run, running, outcome } = useSaving(onRespond);
  const { removal } = messages;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (checkResponse(text) !== null) return;
    void run(text.trim());
  };
  return (
    <Form className="form removal-respond" onSubmit={submit}>
      <Field
        name="response"
        label={removal.respondLabel}
        hint={removal.respondHint}
        multiline
        isRequired
        validate={checkResponse}
        value={text}
        onChange={setText}
      />
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {removal.respondFailed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-secondary" isDisabled={running}>
          {removal.respond}
        </Button>
      </div>
    </Form>
  );
}

/** This member's response on `proposal` still in the outbox, if one waits. */
function waitingResponse(props: RemovalResponseProps): string | undefined {
  const { pending, me, proposal } = props;
  return pending
    .flatMap(({ event }) =>
      event.type === 'removal-response' &&
      event.author === me &&
      event.body.proposal === proposal.id
        ? [event.body.text]
        : [],
    )
    .at(0);
}

/** Whether `me` may post their response now, here: the removal of them, open, and a form to post it with. */
function offersForm(props: RemovalResponseProps): boolean {
  const { state, me, proposal, readOnly, onRespond } = props;
  return !readOnly && onRespond !== undefined && mayRespond(state, me, proposal.id);
}

/**
 * The response on a removal's ballot: the posted one, this member's own on
 * its way, the form for the person it names, or, while the vote is open,
 * that they haven't responded. Nothing for any other Proposal.
 */
export function RemovalResponse(props: RemovalResponseProps) {
  const { state, proposal, now, reachable, onRespond } = props;
  const target = removalTarget(proposal);
  if (target === null) return null;
  const name = displayName(state, target) ?? '';
  const posted = responseTo(state, proposal.id);
  if (posted !== undefined) return <ResponseText name={name} text={posted.text} />;
  const waiting = waitingResponse(props);
  if (waiting !== undefined) {
    return (
      <ResponseText name={name} text={waiting}>
        <SendStatus pending reachable={reachable} sent={false} />
      </ResponseText>
    );
  }
  if (proposal.final || now >= proposal.deadline) return null;
  if (onRespond !== undefined && offersForm(props)) return <RespondForm onRespond={onRespond} />;
  return (
    <p className="caption">
      <bdi>{name}</bdi> {messages.removal.noResponse}
    </p>
  );
}
