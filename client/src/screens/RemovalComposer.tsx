/**
 * Propose removing a member (`#/g/{groupId}/remove-member/{member}`; ADR-0016,
 * ADR-0049, ADR-0075 §3, #115): what the ballot will decide, the higher bar
 * it needs and that the person can't vote on it but can post one response,
 * all in words from the engine, then a title and a why. A removal always runs
 * a fixed 14 days, so there is no voting time to choose. Submitting queues one
 * removal. It shows a form only where the fold would accept one
 * (src/engine/removal.ts), and says why otherwise.
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import { formatAverageLine, formatZeroLine } from '../app/format';
import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import { checkTitle, checkWhy } from '../app/proposalFields';
import type { RemovalValues } from '../app/proposals';
import { Named, SuspendedNote } from '../app/stewards';
import { BackLink, Field, PageHeader } from '../app/ui';
import { type SendOutcome, useSend } from '../app/useSend';
import { can, isSuspended } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { displayName } from '../engine/names';
import { mayProposeRemoval } from '../engine/removal';
import { targetClass } from '../engine/rules';

/** Props for {@link RemovalComposer}. */
export interface RemovalComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The key of the member it would remove, from the route. */
  readonly member: string;
  /** Whether this device's leave waits for the relay (#77): then nothing is proposed. */
  readonly leaving?: boolean;
  /** Queues the removal from valid entries. */
  readonly onPropose: (values: RemovalValues) => Promise<SendOutcome>;
}

/** The screen without a form: why there's nothing to propose here. */
function Unavailable({ state, me, text }: { state: GroupState; me: string; text: string }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        title={messages.removal.unavailableTitle}
        pageTitle={messages.removal.pageTitle}
      />
      {isSuspended(state, me) ? (
        <SuspendedNote state={state} me={me} />
      ) : (
        <p className="lede">{text}</p>
      )}
    </main>
  );
}

/** The class a removal gets, which sets its bar and its fixed window, from the engine. */
function removalTerms(state: GroupState, member: string) {
  const body = { target: { kind: 'remove', member } as const, title: '', why: '' };
  const cls = targetClass(state, body);
  return { bar: state.rules.bars[cls], days: state.rules.windows[cls].default };
}

/** What the ballot will decide, as it will put it, and what passing does. */
function OnTheBallot({ name }: { readonly name: string }) {
  const { removal } = messages;
  return (
    <div className="card">
      <p className="eyebrow">{messages.proposal.onBallot}</p>
      <p className="heading-3">
        <Named parts={removal.ballotTitle} name={name} />
      </p>
      <p className="caption">{removal.ballotLine}</p>
    </div>
  );
}

/** The bar in words, that the person can't vote but can respond, and how long it runs. */
function Terms({ state, member, name }: { state: GroupState; member: string; name: string }) {
  const { removal } = messages;
  const { bar, days } = removalTerms(state, member);
  return (
    <div className="stack removal-terms">
      <p className="caption">
        {removal.bar(formatAverageLine(bar), bar.zerosAllowed ?? 0, formatZeroLine(bar))}{' '}
        <bdi>{name}</bdi> {removal.cantVote}
      </p>
      <p className="caption">{removal.runs(days)}</p>
    </div>
  );
}

interface FormProps {
  readonly member: string;
  readonly name: string;
  readonly onPropose: RemovalComposerProps['onPropose'];
}

/** The form: a title that starts as the ballot's line, and a why. Submitting queues one removal. */
function RemovalForm({ member, name, onPropose }: FormProps) {
  const [title, setTitle] = useState(messages.removal.titleDefault(name));
  const [why, setWhy] = useState('');
  const { run, running, failed, refused } = useSend(onPropose);
  const { removal } = messages;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run({ member, title: title.trim(), why: why.trim() });
  };
  return (
    <Form className="form" onSubmit={submit} validationErrors={refused}>
      <Field
        name="title"
        label={messages.composer.titleLabel}
        hint={removal.titleHint}
        autoComplete="off"
        isRequired
        validate={checkTitle}
        value={title}
        onChange={setTitle}
      />
      <Field
        name="why"
        label={messages.composer.whyLabel}
        hint={removal.whyHint}
        multiline
        isRequired
        validate={checkWhy}
        value={why}
        onChange={setWhy}
      />
      <p className="caption">{removal.visibility}</p>
      {failed ? (
        <p role="alert" className="form-error">
          {removal.failed}
        </p>
      ) : null}
      <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {removal.submit}
        </Button>
      </div>
    </Form>
  );
}

/** Why there's no form now, or null when there is one. */
function unavailable({ state, me, member, leaving = false }: RemovalComposerProps): string | null {
  const { removal } = messages;
  if (leaving) return messages.leave.noProposing;
  if (member === me) return removal.yourself;
  if (!can(state, me, 'propose-removal')) return removal.notAllowed;
  if (!state.members.some((m) => m.author === member)) return removal.notMember;
  return mayProposeRemoval(state, me, member) ? null : removal.alreadyOpen;
}

/**
 * The removal composer: what passing does, the bar it needs and the form.
 * Its words name the person by the name the group sees.
 */
export function RemovalComposer(props: RemovalComposerProps) {
  const { state, me, member } = props;
  const reason = unavailable(props);
  if (reason !== null) return <Unavailable state={state} me={me} text={reason} />;
  const name = displayName(state, member) ?? '';
  const { removal } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader eyebrow={removal.eyebrow} title={removal.title} pageTitle={removal.pageTitle} />
      <OnTheBallot name={name} />
      <Terms state={state} member={member} name={name} />
      <RemovalForm key={member} member={member} name={name} onPropose={props.onPropose} />
    </main>
  );
}
