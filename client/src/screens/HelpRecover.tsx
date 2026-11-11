/**
 * Help someone recover (`#/help-recover`; #118), on a recovery contact's
 * device, from Settings › Recovery contacts.
 *
 * The contact pastes the code the person sent, then picks whose share it is
 * for from the shares this device holds ("Which person?"). The screen says
 * "Call <name> or meet them. Make sure it's really them." and asks for the
 * number the person reads out from their new device. Approve goes on only
 * when it matches the code's check (`recovery/holder.ts`); a number that
 * doesn't says so and approves nothing. Above the form, each recovery this
 * device is helping with reads where it stands: holding until a date,
 * ready, sent, or stopped by a cancel. Names sit in `<bdi>`.
 */
import { type SyntheticEvent, useId, useState } from 'react';
import {
  Button,
  Form,
  Label,
  Link,
  RadioButton,
  RadioField,
  RadioGroup,
} from 'react-aria-components';

import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { formatMinute } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { parseRecoveryCode } from '../crypto/recovery';
import { type Approval, CheckMismatch, type HoldView } from '../recovery/holder';
import type { HeldShare } from '../store/recovery';

/** Props for {@link HelpRecover}. */
export interface HelpRecoverProps {
  /** The shares this device holds, one per person and group. */
  readonly held: readonly HeldShare[];
  /** The recoveries this device is helping with, oldest first. */
  readonly holds: readonly HoldView[];
  /** Approves; rejects with `CheckMismatch` for a number that doesn't match. */
  readonly onApprove: (approval: Approval) => Promise<void>;
}

/** Where the screen has got to: the code, then the person and the number, then done. */
type Step =
  | { readonly kind: 'code' }
  | { readonly kind: 'confirm'; readonly code: string }
  | { readonly kind: 'done' };

/** The paste field's check: anything but a recovery code says so, without repeating it. */
const checkCode = (text: string): string | null =>
  parseRecoveryCode(text) === null ? messages.helpRecover.notACode : null;

/** The words after the name, for each place a hold can stand. */
function afterName({ status }: HoldView): string {
  const words = messages.helpRecover;
  switch (status.kind) {
    case 'holding':
      return words.holdingUntil(formatMinute(status.until));
    case 'soon':
      return words.holdingSoon;
    case 'ready':
      return words.readyAfter;
    case 'sent':
      return words.sentAfter;
    case 'stopped':
      return words.stoppedAfter;
  }
}

/** One hold's line: "Holding <name>’s share until …", or where else it stands. */
function HoldLine({ hold }: { readonly hold: HoldView }) {
  const holding = hold.status.kind === 'holding' || hold.status.kind === 'soon';
  return (
    <li>
      {holding ? `${messages.helpRecover.holdingBefore} ` : null}
      <bdi>{hold.name}</bdi>
      {afterName(hold)}
    </li>
  );
}

/** "Recoveries you're helping with", and each one's line. Nothing for none. */
function Holds({ holds }: { readonly holds: readonly HoldView[] }) {
  const heading = useId();
  if (holds.length === 0) return null;
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.helpRecover.heldHeading}
      </h2>
      <ul className="recovery-held" aria-labelledby={heading}>
        {holds.map((hold) => (
          <HoldLine key={hold.alert} hold={hold} />
        ))}
      </ul>
    </section>
  );
}

/** Paste the code, and Continue. */
function CodeStep({ onCode }: { readonly onCode: (code: string) => void }) {
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('code');
    const parsed = typeof text === 'string' ? parseRecoveryCode(text) : null;
    if (parsed !== null) onCode(parsed.code);
  };
  return (
    <Form className="form" onSubmit={submit}>
      <Field
        name="code"
        label={messages.helpRecover.codeLabel}
        hint={messages.helpRecover.codeHint}
        inputClassName="input-link"
        autoComplete="off"
        isRequired
        validate={checkCode}
      />
      <div>
        <Button type="submit" className="button button-primary">
          {messages.helpRecover.next}
        </Button>
      </div>
    </Form>
  );
}

/** "Which person?": one radio per held share, "<name> (<group>)". */
function WhichPerson({
  held,
  value,
  onChange,
}: {
  readonly held: readonly HeldShare[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { recovery } = messages;
  return (
    <RadioGroup className="level-group" value={value} onChange={onChange}>
      <Label className="field-label">{messages.helpRecover.who}</Label>
      <div className="level-options">
        {held.map((share) => (
          <RadioField key={share.id} value={share.id} className="level-option">
            <RadioButton className="level-button">
              <bdi>{share.name}</bdi> {recovery.groupOpen}
              <bdi>{share.groupName}</bdi>
              {recovery.groupClose}
            </RadioButton>
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}

/** Why the last Approve didn't go through, or nothing. */
type Refusal = 'mismatch' | 'failed' | null;

/** Which person, the call, the number, and Approve or Back. */
function ConfirmStep({
  code,
  held,
  onApprove,
  onBack,
  onDone,
}: {
  readonly code: string;
  readonly held: readonly HeldShare[];
  readonly onApprove: HelpRecoverProps['onApprove'];
  readonly onBack: () => void;
  readonly onDone: () => void;
}) {
  const words = messages.helpRecover;
  const [picked, setPicked] = useState(held[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const share = held.find(({ id }) => id === picked) ?? held[0];
  if (share === undefined) return null;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entered = new FormData(event.currentTarget).get('check');
    const check = typeof entered === 'string' ? entered : '';
    setBusy(true);
    const approval = { code, groupId: share.groupId, person: share.author, check };
    onApprove(approval).then(onDone, (error: unknown) => {
      setBusy(false);
      setRefusal(error instanceof CheckMismatch ? 'mismatch' : 'failed');
    });
  };
  return (
    <Form className="form" onSubmit={submit}>
      <WhichPerson held={held} value={share.id} onChange={setPicked} />
      <p className="lede">
        {words.callBefore} <bdi>{share.name}</bdi> {words.callAfter}
      </p>
      <Field
        name="check"
        label={words.numberLabel}
        hint={words.numberHint}
        inputMode="numeric"
        autoComplete="off"
        isRequired
      />
      {refusal === null ? null : (
        <p role="alert" className="form-error">
          {refusal === 'mismatch' ? words.wrongNumber : words.failed}
        </p>
      )}
      <p role="status" className="status">
        {busy ? words.approving : ''}
      </p>
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={busy}>
          {words.approve}
        </Button>
        <Button className="button button-secondary" onPress={onBack}>
          {words.back}
        </Button>
      </div>
    </Form>
  );
}

/** After an approval: Help someone else, or back to Settings. */
function Done({ onAgain }: { readonly onAgain: () => void }) {
  return (
    <div className="row form-actions">
      <Button className="button button-secondary" onPress={onAgain}>
        {messages.helpRecover.another}
      </Button>
      <Link className="button button-secondary" href={routeHref({ name: 'settings' })}>
        {messages.helpRecover.settings}
      </Link>
    </div>
  );
}

/** The step's form, or what follows an approval. */
function StepView({ held, onApprove }: Pick<HelpRecoverProps, 'held' | 'onApprove'>) {
  const [step, setStep] = useState<Step>({ kind: 'code' });
  const again = () => {
    setStep({ kind: 'code' });
  };
  switch (step.kind) {
    case 'code':
      return (
        <CodeStep
          onCode={(code) => {
            setStep({ kind: 'confirm', code });
          }}
        />
      );
    case 'confirm':
      return (
        <ConfirmStep
          code={step.code}
          held={held}
          onApprove={onApprove}
          onBack={again}
          onDone={() => {
            setStep({ kind: 'done' });
          }}
        />
      );
    case 'done':
      return <Done onAgain={again} />;
  }
}

/** Help someone recover: the holds, then the code, the person and the number. */
export function HelpRecover({ held, holds, onApprove }: HelpRecoverProps) {
  const words = messages.helpRecover;
  return (
    <main className="shell">
      <BackLink to={{ name: 'settings' }} label={messages.settings.title} />
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.lede}</p>
      <Holds holds={holds} />
      {held.length === 0 ? <p>{words.none}</p> : <StepView held={held} onApprove={onApprove} />}
    </main>
  );
}
