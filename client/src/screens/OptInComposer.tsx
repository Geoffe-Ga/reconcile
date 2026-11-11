import { type SyntheticEvent, useRef, useState } from 'react';
import { Button, CheckboxButton, CheckboxField, Form, Text } from 'react-aria-components';

import { formatAverageLine, formatZeroLine } from '../app/format';
import { messages } from '../app/messages';
import type { RulesValues } from '../app/proposals';
import { SuspendedNote } from '../app/stewards';
import { BackLink, Field, PageHeader } from '../app/ui';
import { WindowField } from '../app/WindowField';
import { newFrontDoor } from '../door/page';
import { can, isSuspended } from '../engine/capabilities';
import { type GroupState, TITLE_MAX, WHY_MAX } from '../engine/fold';
import {
  type FrontDoor,
  isOff,
  isWebhook,
  OFF,
  type OptIn,
  type OptInValue,
  openRulesProposal,
} from '../engine/optIns';
import { type ProposalClass, targetClass } from '../engine/rules';
import { mayTurnOffNow } from '../engine/stewards';
import { nfcLength } from '../engine/text';

/** How sending went: `proposed` moves on to the Proposal; the others stay on the form. */
export type OptInOutcome = 'proposed' | 'too-large' | 'failed';

/** Props for {@link OptInComposer}. */
export interface OptInComposerProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The opt-in, from the route. */
  readonly optIn: OptIn;
  /** True for a steward's Turn off now: the off-Proposal, then a `narrow` beside it. */
  readonly narrow: boolean;
  /** The device clock now, in ms, which the voting time's closing line counts from (#106). */
  readonly now: number;
  /** Queues the rules Proposal (and for Turn off now, the narrowing) from valid entries. */
  readonly onPropose: (values: RulesValues) => Promise<OptInOutcome>;
}

/** Limits count code points after NFC (spec §4), never UTF-16 units. */
function required(missing: string, max: number, tooLong: string) {
  return (value: string): string | null => {
    const text = value.trim();
    if (text === '') return missing;
    return nfcLength(text) > max ? tooLong : null;
  };
}

const checkTitle = required(
  messages.composer.titleMissing,
  TITLE_MAX,
  messages.composer.titleTooLong(TITLE_MAX),
);
const checkWhy = required(
  messages.composer.whyMissing,
  WHY_MAX,
  messages.composer.whyTooLong(WHY_MAX),
);

/** The webhook, trimmed, checked by the same validator the fold runs (src/engine/optIns.ts). */
function checkWebhook(value: string): string | null {
  const text = value.trim();
  if (text === '') return messages.optIns.webhookMissing;
  return isWebhook(text) ? null : messages.optIns.webhookInvalid;
}

/** Whether this composer turns the opt-in on: it stands off now, and this isn't Turn off now. */
function turnsOn(props: Pick<OptInComposerProps, 'state' | 'optIn' | 'narrow'>): boolean {
  return !props.narrow && isOff(props.optIn, props.state.rules.optIns[props.optIn]);
}

/**
 * The class `targetClass` gives the change, which bounds its voting time
 * (#106): entrenched to turn an opt-in on, ordinary to turn it off. A webhook
 * still being typed counts as on.
 */
function classOf(state: GroupState, optIn: OptIn, value: OptInValue): ProposalClass {
  const target = { kind: 'rules', optIn, value } as const;
  return targetClass(state, { target, title: '', why: '' });
}

/** The motion this composer proposes, as its ballot will be headed. */
function motionOf(optIn: OptIn, on: boolean): string {
  const motion = messages.optIns.motions[optIn];
  return on ? motion.on : motion.off;
}

/** Why there's no form here now, or null when there is one. */
function unavailable(props: OptInComposerProps): string | null {
  const { state, me, optIn, narrow } = props;
  if (!can(state, me, 'propose')) return messages.stewards.notAllowed;
  if (openRulesProposal(state, optIn) !== undefined) return messages.optIns.unavailable;
  return narrow && !mayTurnOffNow(state, me, optIn) ? messages.optIns.nowUnavailable : null;
}

/** The screen without a form: why there's nothing to propose here. */
function Unavailable({ state, me, text }: { state: GroupState; me: string; text: string }) {
  const { optIns } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'rules', groupId: state.group ?? '' }} label={optIns.pageTitle} />
      <PageHeader title={optIns.unavailableTitle} pageTitle={optIns.composerPageTitle} />
      {isSuspended(state, me) ? (
        <SuspendedNote state={state} me={me} />
      ) : (
        <p className="lede">{text}</p>
      )}
    </main>
  );
}

/** Runs `onPropose` once at a time; what was proposed leaves this screen, so the button stays off. */
function useSend(onPropose: OptInComposerProps['onPropose']) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: RulesValues) => {
    // A press React Aria delivers late, or a second press, finds it busy (#190).
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    setRefused({});
    const outcome = await onPropose(values).catch(() => 'failed' as const);
    if (outcome === 'proposed') return;
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { why: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}

/** What goes above the fields: the warning, then the higher bar or Turn off now's line. */
function Context({ state, optIn, narrow }: Pick<OptInComposerProps, 'state' | 'optIn' | 'narrow'>) {
  const { optIns } = messages;
  const bar = state.rules.bars.entrenched;
  return (
    <div className="stack">
      <p className="opt-in-warning">{optIns.warnings[optIn]}</p>
      {turnsOn({ state, optIn, narrow }) ? (
        <p className="caption">{optIns.higherBar(formatAverageLine(bar), formatZeroLine(bar))}</p>
      ) : null}
      {narrow ? <p className="opt-in-narrowed">{optIns.nowLine}</p> : null}
    </div>
  );
}

/**
 * The value the form would set: the webhook typed so far, an open front door
 * (`door`, its secrets made when the form opened) with the count as chosen,
 * or off.
 */
function valueOf(optIn: OptIn, on: boolean, webhook: string, door: FrontDoor): OptInValue {
  if (!on) return OFF[optIn];
  return optIn === 'chatBot' ? { webhook: webhook.trim() } : door;
}

/** Opening the front door's one choice: whether its page shows how many people are in the group (#121). */
function CountChoice({ value, onChange }: { value: boolean; onChange: (show: boolean) => void }) {
  const { door } = messages;
  return (
    <CheckboxField className="check-option" name="showCount" isSelected={value} onChange={onChange}>
      <CheckboxButton className="checkbox">
        <span className="checkbox-box" aria-hidden="true" />
        {door.countLabel}
      </CheckboxButton>
      <Text slot="description" className="check-description">
        {door.countHint}
      </Text>
    </CheckboxField>
  );
}

/**
 * The form: the webhook when it turns the bot on, a title that starts as the
 * ballot's heading, and a why. Submitting queues one rules Proposal, and for
 * Turn off now a `narrow` after it.
 */
function OptInForm(props: OptInComposerProps) {
  const { state, optIn, narrow } = props;
  const on = turnsOn(props);
  const asksWebhook = on && optIn === 'chatBot';
  const asksCount = on && optIn === 'frontDoor';
  const [webhook, setWebhook] = useState('');
  // A new door's secrets, made once on this device when the form opens (#121).
  const [secrets] = useState(() => newFrontDoor(false));
  const [showCount, setShowCount] = useState(false);
  const [title, setTitle] = useState(motionOf(optIn, on));
  const [why, setWhy] = useState('');
  const value = valueOf(optIn, on, webhook, { ...secrets, showCount });
  const cls = classOf(state, optIn, value);
  const [days, setDays] = useState<number | null>(null);
  const window = days ?? state.rules.windows[cls].default;
  const { run, running, failed, refused } = useSend(props.onPropose);
  const { optIns, stewards, composer } = messages;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run({ optIn, value, title: title.trim(), why: why.trim(), narrow, window });
  };
  return (
    <Form className="form" onSubmit={submit} validationErrors={refused}>
      {asksWebhook ? (
        <Field
          name="webhook"
          label={optIns.webhookLabel}
          hint={optIns.webhookHint}
          inputMode="url"
          autoComplete="off"
          inputClassName="input-link"
          isRequired
          validate={checkWebhook}
          value={webhook}
          onChange={setWebhook}
        />
      ) : null}
      {asksCount ? <CountChoice value={showCount} onChange={setShowCount} /> : null}
      <Field
        name="title"
        label={composer.titleLabel}
        hint={stewards.titleHint}
        autoComplete="off"
        isRequired
        validate={checkTitle}
        value={title}
        onChange={setTitle}
      />
      <Field
        name="why"
        label={composer.whyLabel}
        hint={stewards.whyHint}
        multiline
        isRequired
        validate={checkWhy}
        value={why}
        onChange={setWhy}
      />
      <WindowField
        rules={state.rules}
        cls={cls}
        value={window}
        onChange={setDays}
        now={props.now}
      />
      <p className="caption">{stewards.visibility}</p>
      {failed ? (
        <p role="alert" className="form-error">
          {stewards.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {narrow ? optIns.submitNow : composer.submit}
        </Button>
      </div>
    </Form>
  );
}

/**
 * The opt-in composer (`#/g/{groupId}/rules/{optIn}` and, for a steward's
 * Turn off now, `…/narrow/{optIn}`; ADR-0039, ADR-0040, #117): a rules
 * Proposal turning the opt-in on if it stands off, or off if it stands on,
 * with the opt-in's warning first. Turning the bot on asks for its Discord
 * webhook, checked by the fold's own validator. Opening the front door makes
 * its two secrets on this device and asks whether its page shows the member
 * count (#121). It shows a form only where
 * the fold would accept the Proposal, and Turn off now only where the
 * narrowing beside it would hold too; elsewhere it says why.
 */
export function OptInComposer(props: OptInComposerProps) {
  const { state, me, optIn, narrow } = props;
  const reason = unavailable(props);
  if (reason !== null) return <Unavailable state={state} me={me} text={reason} />;
  const { optIns } = messages;
  const motion = motionOf(optIn, turnsOn(props));
  return (
    <main className="shell">
      <BackLink to={{ name: 'rules', groupId: state.group ?? '' }} label={optIns.pageTitle} />
      <PageHeader
        eyebrow={optIns.names[optIn]}
        title={narrow ? optIns.nowTitle(motion) : motion}
        pageTitle={optIns.composerPageTitle}
      />
      <Context state={state} optIn={optIn} narrow={narrow} />
      <OptInForm key={`${optIn}-${String(narrow)}`} {...props} />
    </main>
  );
}
