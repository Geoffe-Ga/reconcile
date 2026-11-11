/**
 * Send a Dispatch (`#/g/{groupId}/dispatch/new`; ADR-0003, ADR-0012,
 * ADR-0074, #112): a title, a short plain text and, optionally, the Document
 * it points to. Submitting queues one `dispatch`, whose PUT wakes the
 * group's opted-in phones with the usual content-free push. It shows a form
 * only to someone who holds `dispatch` (`can()`, as the fold asks) and isn't
 * leaving, and says why otherwise.
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, Form, Label, RadioButton, RadioField, RadioGroup } from 'react-aria-components';

import { documentTitle } from '../app/dispatchLines';
import { messages } from '../app/messages';
import { checkDispatchText, checkDispatchTitle } from '../app/proposalFields';
import type { DispatchValues } from '../app/proposals';
import { SuspendedNote } from '../app/stewards';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useSaving } from '../app/useSaving';
import { can, isSuspended } from '../engine/capabilities';
import { documentIds } from '../engine/dispatches';
import type { GroupState } from '../engine/fold';

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
}

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
  const documents = documentIds(state).map((id) => ({ id, title: documentTitle(state, id) ?? '' }));
  return (
    <RadioGroup className="level-group" name="doc" value={value} onChange={onChange}>
      <Label className="field-label">{sendDispatch.documentLabel}</Label>
      <div className="level-options">
        <RadioField value={NO_DOCUMENT} className="level-option">
          <RadioButton className="level-button">{sendDispatch.noDocument}</RadioButton>
        </RadioField>
        {documents.map((document) => (
          <RadioField key={document.id} value={document.id} className="level-option">
            <RadioButton className="level-button">
              <bdi>{document.title}</bdi>
            </RadioButton>
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}

/** The form: title, text and Document. Submitting queues one `dispatch`. */
function DispatchForm({ state, onSend }: Pick<SendDispatchProps, 'state' | 'onSend'>) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [doc, setDoc] = useState(NO_DOCUMENT);
  const { run, running, outcome } = useSaving(onSend);
  const { sendDispatch } = messages;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = doc === NO_DOCUMENT ? null : doc;
    void run({ title: title.trim(), text: text.trim(), doc: chosen });
  };
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
      <p className="caption">{sendDispatch.visibility}</p>
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {sendDispatch.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {sendDispatch.submit}
        </Button>
      </div>
    </Form>
  );
}

/** Send a Dispatch to everyone in the group, for someone who may send one. */
export function SendDispatch({ state, me, leaving = false, onSend }: SendDispatchProps) {
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
      <DispatchForm state={state} onSend={onSend} />
    </main>
  );
}
