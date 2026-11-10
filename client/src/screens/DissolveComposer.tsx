/**
 * Propose dissolving the group (`#/g/{groupId}/dissolve`; ADR-0051,
 * ADR-0072 §10, #108): a title, a why, the voting time within the
 * entrenched bounds (#106), and whether every device also erases the group.
 * Under that choice the screen says plainly what no app can stop. Submitting
 * queues one dissolve Proposal. It shows a form only where the fold would
 * accept one (src/engine/dissolve.ts), and says why otherwise.
 */
import { type SyntheticEvent, useState } from 'react';
import { Button, CheckboxButton, CheckboxField, Form, Text } from 'react-aria-components';

import { formatAverageLine, formatZeroLine } from '../app/format';
import { messages } from '../app/messages';
import { checkTitle, checkWhy } from '../app/proposalFields';
import type { DissolveValues } from '../app/proposals';
import { SuspendedNote } from '../app/stewards';
import { BackLink, Field, PageHeader } from '../app/ui';
import { type SendOutcome, useSend } from '../app/useSend';
import { WindowField } from '../app/WindowField';
import { can, isSuspended } from '../engine/capabilities';
import { hasOpenDissolve } from '../engine/dissolve';
import type { GroupState } from '../engine/fold';
import { targetClass } from '../engine/rules';

/** Props for {@link DissolveComposer}. */
export interface DissolveComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The device clock now, in ms, which the voting time's closing line counts from. */
  readonly now: number;
  /** Whether this device's leave waits for the relay (#77): then nothing is proposed. */
  readonly leaving?: boolean;
  /** Queues the dissolve Proposal from valid entries. */
  readonly onPropose: (values: DissolveValues) => Promise<SendOutcome>;
}

/** The class a dissolve Proposal gets, which bounds its voting time and sets its bar. */
function dissolveClass(state: GroupState) {
  const body = { target: { kind: 'dissolve', wipe: false } as const, title: '', why: '' };
  return targetClass(state, body);
}

/** The screen without a form: why there's nothing to propose here. */
function Unavailable({ state, me, text }: { state: GroupState; me: string; text: string }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        title={messages.dissolve.unavailableTitle}
        pageTitle={messages.dissolve.pageTitle}
      />
      {isSuspended(state, me) ? (
        <SuspendedNote state={state} me={me} />
      ) : (
        <p className="lede">{text}</p>
      )}
    </main>
  );
}

/**
 * "Also erase it from every device", a React Aria checkbox, with what it
 * means, and what no app can do, tied to it as its description.
 */
function WipeChoice({
  value,
  onChange,
}: {
  readonly value: boolean;
  readonly onChange: (wipe: boolean) => void;
}) {
  const { dissolve } = messages;
  return (
    <CheckboxField className="check-option" name="wipe" isSelected={value} onChange={onChange}>
      <CheckboxButton className="check-button">
        <span className="check-box" aria-hidden="true" />
        {dissolve.wipeLabel}
      </CheckboxButton>
      <Text slot="description" className="check-description">
        {dissolve.wipeHint}
      </Text>
    </CheckboxField>
  );
}

interface FormProps {
  readonly state: GroupState;
  readonly now: number;
  readonly onPropose: DissolveComposerProps['onPropose'];
}

/** The form: title, why, voting time and the wipe. Submitting queues one dissolve Proposal. */
function DissolveForm({ state, now, onPropose }: FormProps) {
  const cls = dissolveClass(state);
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [window, setWindow] = useState<number>(state.rules.windows[cls].default);
  const [wipe, setWipe] = useState(false);
  const { run, running, failed, refused } = useSend(onPropose);
  const { dissolve } = messages;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run({ title: title.trim(), why: why.trim(), window, wipe });
  };
  return (
    <Form className="form" onSubmit={submit} validationErrors={refused}>
      <Field
        name="title"
        label={messages.composer.titleLabel}
        hint={dissolve.titleHint}
        autoComplete="off"
        isRequired
        validate={checkTitle}
        value={title}
        onChange={setTitle}
      />
      <Field
        name="why"
        label={messages.composer.whyLabel}
        hint={dissolve.whyHint}
        multiline
        isRequired
        validate={checkWhy}
        value={why}
        onChange={setWhy}
      />
      <WindowField rules={state.rules} cls={cls} value={window} onChange={setWindow} now={now} />
      <WipeChoice value={wipe} onChange={setWipe} />
      <p className="caption">{dissolve.visibility}</p>
      {failed ? (
        <p role="alert" className="form-error">
          {dissolve.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {dissolve.submit}
        </Button>
      </div>
    </Form>
  );
}

/** Why there's no form now, or null when there is one. */
function unavailable({ state, me, leaving = false }: DissolveComposerProps): string | null {
  if (leaving) return messages.leave.noProposing;
  if (!can(state, me, 'propose')) return messages.dissolve.notAllowed;
  return hasOpenDissolve(state) ? messages.dissolve.alreadyOpen : null;
}

/**
 * The dissolve composer: what passing does, the bar it needs, and the form.
 * Dissolving is entrenched (ADR-0051), so the voting time runs within the
 * entrenched bounds and the screen states the entrenched bar in words.
 */
export function DissolveComposer(props: DissolveComposerProps) {
  const { state, me, now } = props;
  const reason = unavailable(props);
  if (reason !== null) return <Unavailable state={state} me={me} text={reason} />;
  const { dissolve } = messages;
  const bar = state.rules.bars[dissolveClass(state)];
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        eyebrow={dissolve.eyebrow}
        title={dissolve.title}
        pageTitle={dissolve.pageTitle}
      />
      <div className="stack">
        <p className="lede">{dissolve.lede}</p>
        <p className="caption">{dissolve.bar(formatAverageLine(bar), formatZeroLine(bar))}</p>
      </div>
      <DissolveForm state={state} now={now} onPropose={props.onPropose} />
    </main>
  );
}
