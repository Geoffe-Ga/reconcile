/**
 * Help someone recover (`#/help-recover`; #118), on a recovery contact's
 * device, from Settings › Recovery contacts.
 *
 * The contact pastes the code the person sent, then picks whose share it is
 * for from the shares this device holds ("Which person?"). The screen says
 * "Call <name> or meet them. Make sure it's really them." and asks for the
 * two numbers the person reads out from their new device. Approve goes on
 * only when the first matches the code's check (`recovery/holder.ts`); a
 * number that doesn't says so and approves nothing. The second (#398) goes
 * inside the share's release, and must be six digits. Above the form, each
 * recovery this device is helping with reads where it stands: holding until
 * a date, ready, sent, or stopped by a cancel. A sent share names the second
 * number it went with, and while the relay keeps it, it can go again with
 * another, if the person says it was wrong. Names sit in `<bdi>`.
 */
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  Form,
  Label,
  Link,
  RadioButton,
  RadioField,
  RadioGroup,
} from 'react-aria-components';

import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { formatMinute } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { parseRecoveryCode } from '../crypto/recovery';
import {
  type Approval,
  CheckMismatch,
  type HoldView,
  SecondNumberInvalid,
} from '../recovery/holder';
import type { HeldShare } from '../store/recovery';

/** Props for {@link HelpRecover}. */
export interface HelpRecoverProps {
  /** The shares this device holds, one per person and group. */
  readonly held: readonly HeldShare[];
  /** The recoveries this device is helping with, oldest first. */
  readonly holds: readonly HoldView[];
  /**
   * Approves; rejects with `CheckMismatch` for a number that doesn't match,
   * or `SecondNumberInvalid` for a second number that isn't six digits.
   */
  readonly onApprove: (approval: Approval) => Promise<void>;
  /**
   * Sends a sent share again with another second number (#398); rejects
   * with `SecondNumberInvalid` for one that isn't six digits.
   */
  readonly onResend: (resend: {
    readonly groupId: string;
    readonly alert: string;
    readonly number: string;
  }) => Promise<void>;
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
function afterName({ status, number }: HoldView): string {
  const words = messages.helpRecover;
  switch (status.kind) {
    case 'holding':
      return words.holdingUntil(formatMinute(status.until));
    case 'soon':
      return words.holdingSoon;
    case 'ready':
      return words.readyAfter;
    case 'sent':
      return number === null ? words.sentAfter : words.sentWith(messages.link.number(number));
    case 'stopped':
      return words.stoppedAfter;
  }
}

/** Why the last send didn't go, or nothing. */
type ResendRefusal = 'invalid' | 'failed' | null;

/**
 * Send it again with another number (#398): a quiet button that opens the
 * second number's field, then Send again (secondary) beside Cancel, which
 * goes once while it sends.
 */
function Resend({
  hold,
  onResend,
}: {
  readonly hold: HoldView;
  readonly onResend: HelpRecoverProps['onResend'];
}) {
  const words = messages.helpRecover;
  const form = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ResendRefusal>(null);
  const [sent, setSent] = useState(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entered = new FormData(event.currentTarget).get('number');
    const number = typeof entered === 'string' ? entered : '';
    setBusy(true);
    onResend({ groupId: hold.groupId, alert: hold.alert, number }).then(
      () => {
        setBusy(false);
        setRefusal(null);
        setOpen(false);
        setSent(true);
      },
      (error: unknown) => {
        setBusy(false);
        setRefusal(error instanceof SecondNumberInvalid ? 'invalid' : 'failed');
      },
    );
  };
  // The button that opened the form has gone, so focus moves to the field it opened.
  useEffect(() => {
    const field = open ? form.current?.elements.namedItem('number') : null;
    if (field instanceof HTMLInputElement) field.focus();
  }, [open]);
  const status = (
    <p role="status" className="status">
      {busy ? words.resending : ''}
      {!busy && sent ? words.resent : ''}
    </p>
  );
  if (!open) {
    return (
      <div className="field-status">
        <div>
          <Button
            className="button button-quiet"
            onPress={() => {
              setSent(false);
              setOpen(true);
            }}
          >
            {words.resendOpen}
          </Button>
        </div>
        {status}
      </div>
    );
  }
  return (
    <Form ref={form} className="form recover-resend" onSubmit={submit}>
      <Field
        name="number"
        label={words.secondLabel}
        hint={words.resendHint}
        inputMode="numeric"
        autoComplete="off"
        isRequired
      />
      {refusal === null ? null : (
        <p role="alert" className="form-error">
          {refusal === 'invalid' ? words.badSecond : words.resendFailed}
        </p>
      )}
      <div className="field-status">
        <div className="row form-actions" onPointerDownCapture={holdPresses(busy)}>
          <Button type="submit" className="button button-secondary" isDisabled={busy}>
            {words.resend}
          </Button>
          <Button
            className="button button-quiet"
            isDisabled={busy}
            onPress={() => {
              setRefusal(null);
              setOpen(false);
            }}
          >
            {words.resendCancel}
          </Button>
        </div>
        {status}
      </div>
    </Form>
  );
}

/** One hold's line: "Holding <name>’s share until …", or where else it stands, and Send again. */
function HoldLine({
  hold,
  onResend,
}: {
  readonly hold: HoldView;
  readonly onResend: HelpRecoverProps['onResend'];
}) {
  const holding = hold.status.kind === 'holding' || hold.status.kind === 'soon';
  return (
    <li className="recover-hold">
      <p>
        {holding ? `${messages.helpRecover.holdingBefore} ` : null}
        <bdi>{hold.name}</bdi>
        {afterName(hold)}
      </p>
      {hold.resend ? <Resend hold={hold} onResend={onResend} /> : null}
    </li>
  );
}

/** "Recoveries you're helping with", and each one's line. Nothing for none. */
function Holds({
  holds,
  onResend,
}: {
  readonly holds: readonly HoldView[];
  readonly onResend: HelpRecoverProps['onResend'];
}) {
  const heading = useId();
  if (holds.length === 0) return null;
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.helpRecover.heldHeading}
      </h2>
      <ul className="recovery-held" aria-labelledby={heading}>
        {holds.map((hold) => (
          <HoldLine key={hold.alert} hold={hold} onResend={onResend} />
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
  return (
    <RadioGroup className="level-group" value={value} onChange={onChange}>
      <Label className="field-label">{messages.helpRecover.who}</Label>
      <div className="level-options">
        {held.map((share) => (
          <RadioField key={share.id} value={share.id} className="level-option">
            <RadioButton className="level-button">
              {/* One isolate for the whole label, so its accessible name reads as written. */}
              <bdi>{messages.helpRecover.person(share.name, share.groupName)}</bdi>
            </RadioButton>
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}

/** Why the last Approve didn't go through, or nothing. */
type Refusal = 'mismatch' | 'second' | 'failed' | null;

/** What each refusal says. */
const REFUSED: Readonly<Record<Exclude<Refusal, null>, string>> = {
  mismatch: messages.helpRecover.wrongNumber,
  second: messages.helpRecover.badSecond,
  failed: messages.helpRecover.failed,
};

/** Why `error` refused an approval. */
function refusalOf(error: unknown): Exclude<Refusal, null> {
  if (error instanceof CheckMismatch) return 'mismatch';
  return error instanceof SecondNumberInvalid ? 'second' : 'failed';
}

/** The text a form's field holds, or nothing. */
function textOf(form: HTMLFormElement, name: string): string {
  const entered = new FormData(form).get(name);
  return typeof entered === 'string' ? entered : '';
}

/** Which person, the call, the two numbers, and Approve or Back. */
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
    const check = textOf(event.currentTarget, 'check');
    const number = textOf(event.currentTarget, 'number');
    setBusy(true);
    const approval = { code, groupId: share.groupId, person: share.author, check, number };
    onApprove(approval).then(onDone, (error: unknown) => {
      setBusy(false);
      setRefusal(refusalOf(error));
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
      <Field
        name="number"
        label={words.secondLabel}
        hint={words.secondHint}
        inputMode="numeric"
        autoComplete="off"
        isRequired
      />
      {refusal === null ? null : (
        <p role="alert" className="form-error">
          {REFUSED[refusal]}
        </p>
      )}
      <div className="field-status">
        <div className="row form-actions" onPointerDownCapture={holdPresses(busy)}>
          <Button type="submit" className="button button-primary" isDisabled={busy}>
            {words.approve}
          </Button>
          <Button className="button button-secondary" onPress={onBack}>
            {words.back}
          </Button>
        </div>
        <p role="status" className="status">
          {busy ? words.approving : ''}
        </p>
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

/** Help someone recover: the holds, then the code, the person and the numbers. */
export function HelpRecover({ held, holds, onApprove, onResend }: HelpRecoverProps) {
  const words = messages.helpRecover;
  return (
    <main className="shell">
      <BackLink to={{ name: 'settings' }} label={messages.settings.title} />
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.lede}</p>
      <Holds holds={holds} onResend={onResend} />
      {held.length === 0 ? <p>{words.none}</p> : <StepView held={held} onApprove={onApprove} />}
    </main>
  );
}
