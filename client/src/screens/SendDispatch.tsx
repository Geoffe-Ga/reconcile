/**
 * Send a Dispatch (`#/g/{groupId}/dispatch/new`; ADR-0003, ADR-0012,
 * ADR-0074, #112): a title, a short plain text and, optionally, the Document
 * it points to. Submitting queues one `dispatch`, whose PUT wakes the
 * group's opted-in phones with the usual content-free push. It shows a form
 * only to someone who holds `dispatch` (`can()`, as the fold asks) and isn't
 * leaving, and says why otherwise.
 *
 * Once the group sits in a formed coalition, the form asks how far it can go
 * (#126; ADR-0037, ADR-0071): this group only sends it at once, as before,
 * and any other choice puts it to the group's vote with that ceiling, so each
 * coalition above can vote on it in turn. While the group's front door is
 * listed (#430; ADR-0081), it also offers to ask for the public shelf, never
 * ticked: that puts the Dispatch to the group's vote, whatever its reach,
 * with a second line on the ballot, as the fold takes one (listingInEffect).
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, CheckboxButton, CheckboxField, Form, Text } from 'react-aria-components';

import { documentTitle } from '../app/dispatchLines';
import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import { checkDispatchText, checkDispatchTitle } from '../app/proposalFields';
import { RadioCards } from '../app/RadioCards';
import type { DispatchValues, RisingValues } from '../app/proposals';
import { SuspendedNote } from '../app/stewards';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useSaving } from '../app/useSaving';
import { can, isSuspended } from '../engine/capabilities';
import { documentIds } from '../engine/dispatches';
import { CEILINGS, type Reach } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { listingInEffect } from '../engine/frontDoor';

/** Props for {@link SendDispatch}. */
export interface SendDispatchProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** Whether this device's leave waits for the relay (#77): then nothing new is sent. */
  readonly leaving?: boolean;
  /** Queues the Dispatch from valid entries; rejects when it couldn't be saved. */
  readonly onSend: (values: DispatchValues) => Promise<void>;
  /**
   * Puts the Dispatch to the group's vote with the reach chosen (#126) and
   * any shelf line (#430); rejects when it couldn't be saved. Without it the
   * form offers neither a ceiling nor the shelf.
   */
  readonly onPropose?: (values: RisingValues) => Promise<void>;
  /** Whether the group sits in a formed coalition, so the form asks how far it can go (#126). */
  readonly rises?: boolean;
}

/** Every choice, this group only first. */
const REACHES: readonly Reach[] = [0, ...CEILINGS];

/** The picker's value for pointing to no Document: never a Document id, which is 43 characters. */
const NO_DOCUMENT = 'none';

/** The screen without a form: why this member can't send a Dispatch here. */
function Unavailable({ state, me, leaving }: { state: GroupState; me: string; leaving: boolean }) {
  const { sendDispatch, leave } = messages;
  const title = leaving ? leave.noProposingTitle : sendDispatch.notAllowedTitle;
  return (
    <main className="shell">
      <BackLink
        to={{ name: 'dispatches', groupId: state.group ?? '' }}
        label={messages.dispatches.title}
      />
      <PageHeader title={title} pageTitle={sendDispatch.pageTitle} />
      {!leaving && isSuspended(state, me) ? (
        <SuspendedNote state={state} me={me} />
      ) : (
        <p className="lede">{leaving ? sendDispatch.leaving : sendDispatch.notAllowed}</p>
      )}
    </main>
  );
}

interface DocumentPickerProps {
  readonly state: GroupState;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** "Point to a Document (optional)": No Document, or each of the group's Documents by title. */
function DocumentPicker({ state, value, onChange }: DocumentPickerProps) {
  const { sendDispatch } = messages;
  const documents = documentIds(state).map((id) => ({
    value: id,
    label: <bdi>{documentTitle(state, id) ?? ''}</bdi>,
  }));
  const cards = [{ value: NO_DOCUMENT, label: sendDispatch.noDocument }, ...documents];
  return (
    <RadioCards
      label={sendDispatch.documentLabel}
      name="doc"
      value={value}
      onChange={onChange}
      cards={cards}
    />
  );
}

interface CeilingPickerProps {
  readonly value: Reach;
  readonly onChange: (value: Reach) => void;
}

/**
 * "How far can it go?" (#126): this group only, one level up, two levels up,
 * or as high as the group's coalitions reach, each a card with the line that
 * says what happens.
 */
function CeilingPicker({ value, onChange }: CeilingPickerProps) {
  const { ceilingLabel, ceilings, ceilingHints } = messages.sendDispatch;
  const pick = (picked: string) => {
    const reach = REACHES.find((candidate) => String(candidate) === picked);
    if (reach !== undefined) onChange(reach);
  };
  const cards = REACHES.map((reach) => ({
    value: String(reach),
    label: ceilings[reach],
    description: ceilingHints[reach],
  }));
  return (
    <RadioCards
      label={ceilingLabel}
      name="ceiling"
      value={String(value)}
      onChange={pick}
      cards={cards}
    />
  );
}

interface ShelfChoiceProps {
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

/** "Also ask to put it on the public shelf" (#430), with what that means. */
function ShelfChoice({ value, onChange }: ShelfChoiceProps) {
  const { sendDispatch } = messages;
  return (
    <CheckboxField className="check-option" name="shelf" isSelected={value} onChange={onChange}>
      <CheckboxButton className="checkbox">
        <span className="checkbox-box" aria-hidden="true" />
        {sendDispatch.shelfLabel}
      </CheckboxButton>
      <Text slot="description" className="check-description">
        {sendDispatch.shelfHint}
      </Text>
    </CheckboxField>
  );
}

/** What the form submits: the entries, how far it can go, and whether it asks for the shelf. */
interface Chosen extends DispatchValues {
  readonly reach: Reach;
  readonly shelf: boolean;
}

/**
 * Sends the Dispatch at once for this group only, else puts it to a vote with
 * its reach (#126), and with the shelf line when it asks for it (#430).
 */
function sender(props: Pick<SendDispatchProps, 'onSend' | 'onPropose'>) {
  return async ({ reach, shelf, ...values }: Chosen) => {
    const asked = shelf ? { shelf } : {};
    if ((reach === 0 && !shelf) || props.onPropose === undefined) await props.onSend(values);
    else await props.onPropose({ ...values, ceiling: reach, ...asked });
  };
}

/** The caption under the choices: who sees a Dispatch, a Proposal, or a shelf line's result. */
function visibilityOf(voted: boolean, shelf: boolean): string {
  const { sendDispatch } = messages;
  if (shelf) return sendDispatch.visibilityShelf;
  return voted ? sendDispatch.visibilityVote : sendDispatch.visibility;
}

/** A Dispatch's reach as chosen: one that asks for the shelf stays in this group (#430). */
function reachOf(chosen: Reach, asked: boolean): Reach {
  return asked ? 0 : chosen;
}

/** Whether the form offers a ceiling: it can rise, and it doesn't ask for the shelf (#430). */
function offersCeiling(
  { onPropose, rises = false }: Pick<SendDispatchProps, 'onPropose' | 'rises'>,
  asked: boolean,
): boolean {
  return onPropose !== undefined && rises && !asked;
}

/**
 * The form: title, text, Document and, once the group sits in a formed
 * coalition, how far it can go (#126), and while its door is listed, the
 * public shelf (#430). Submitting queues one `dispatch`, or one Proposal that
 * puts it to a vote.
 */
function DispatchForm(props: Pick<SendDispatchProps, 'state' | 'onSend' | 'onPropose' | 'rises'>) {
  const { state, onPropose } = props;
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [doc, setDoc] = useState(NO_DOCUMENT);
  const [reach, setReach] = useState<Reach>(0);
  const [shelf, setShelf] = useState(false);
  const { run, running, outcome } = useSaving(sender(props));
  const { sendDispatch } = messages;
  const offersShelf = onPropose !== undefined && listingInEffect(state) !== null;
  const asked = offersShelf && shelf;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = doc === NO_DOCUMENT ? null : doc;
    void run({
      title: title.trim(),
      text: text.trim(),
      doc: chosen,
      reach: reachOf(reach, asked),
      shelf: asked,
    });
  };
  const voted = reach !== 0 || asked;
  return (
    <Form className="form" onSubmit={submit}>
      <Field
        name="title"
        label={sendDispatch.titleLabel}
        hint={sendDispatch.titleHint}
        autoComplete="off"
        isRequired
        validate={checkDispatchTitle}
        value={title}
        onChange={setTitle}
      />
      <Field
        name="text"
        label={sendDispatch.textLabel}
        hint={sendDispatch.textHint}
        multiline
        validate={checkDispatchText}
        value={text}
        onChange={setText}
      />
      <DocumentPicker state={state} value={doc} onChange={setDoc} />
      {offersCeiling(props, asked) ? <CeilingPicker value={reach} onChange={setReach} /> : null}
      {offersShelf ? <ShelfChoice value={shelf} onChange={setShelf} /> : null}
      <p className="caption">{visibilityOf(voted, asked)}</p>
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {sendDispatch.failed}
        </p>
      ) : null}
      <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {voted ? sendDispatch.submitVote : sendDispatch.submit}
        </Button>
      </div>
    </Form>
  );
}

/** Send a Dispatch to everyone in the group, for someone who may send one. */
export function SendDispatch(props: SendDispatchProps) {
  const { state, me, leaving = false, onSend, onPropose, rises = false } = props;
  if (leaving || !can(state, me, 'dispatch')) {
    return <Unavailable state={state} me={me} leaving={leaving} />;
  }
  const { sendDispatch } = messages;
  return (
    <main className="shell">
      <BackLink
        to={{ name: 'dispatches', groupId: state.group ?? '' }}
        label={messages.dispatches.title}
      />
      <PageHeader
        eyebrow={sendDispatch.eyebrow}
        title={sendDispatch.title}
        pageTitle={sendDispatch.pageTitle}
      />
      <p className="lede">{sendDispatch.lede}</p>
      <DispatchForm
        state={state}
        onSend={onSend}
        rises={rises}
        {...(onPropose === undefined ? {} : { onPropose })}
      />
    </main>
  );
}
