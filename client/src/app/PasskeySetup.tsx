/**
 * Passkey setup (#95; ADR-0030): Make a passkey, then Confirm your passkey.
 *
 * iOS allows one WebAuthn request per tap, so each tap makes exactly one, and
 * the primary button stays where it is between them, so focus stays on it.
 * Tap 2's answer decides, once, whether the keys are locked with the passkey
 * (`passkey.ts`). A cancelled or failed tap decides nothing: it says so and
 * the same tap can be tried again. Once it has ended, one plain line says
 * how, and takes focus. Where the passkey can't protect the keys, or the
 * groups had no way back so nothing was locked (#389), the line links to
 * Save a backup, unless the screen already holds it (Settings).
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import { messages } from './messages';
import type { Protection } from './passkey';
import { routeHref } from './router';

/** Props for {@link PasskeySetup}. */
export interface PasskeySetupProps {
  /** Tap 1: makes the passkey and resolves to its credential id; rejects when none was made. */
  readonly onCreate: () => Promise<Uint8Array>;
  /** Tap 2: asks it once and locks the keys when it can; rejects when it didn't answer. */
  readonly onProtect: (credentialId: Uint8Array) => Promise<Protection>;
  /** Hears how setup ended, once it has. */
  readonly onEnd?: (protection: Protection) => void;
  /** Whether the no-PRF line links to Save a backup in Settings. */
  readonly linkBackup: boolean;
  /** Hears a press of that link, before Settings opens. */
  readonly onBackup?: () => void;
  /** A quiet action on the primary button's line until setup ends, such as the offer's Not now. */
  readonly aside?: ReactNode;
  /** True on a screen whose one primary action is another's (Settings): the button is secondary. */
  readonly secondary?: boolean;
}

/** Where setup has got to. */
type Step =
  | { readonly kind: 'create' | 'creating' | 'create-failed' }
  | { readonly kind: 'confirm' | 'confirming' | 'confirm-failed'; readonly id: Uint8Array }
  | { readonly kind: 'ended'; readonly protection: Protection };

/** The live region's words for `step`. */
function statusOf(step: Step): string {
  if (step.kind === 'creating') return messages.passkey.creating;
  if (step.kind === 'confirming') return messages.passkey.confirming;
  return '';
}

/** The alert for `step`, or null. */
function errorOf(step: Step): string | null {
  if (step.kind === 'create-failed') return messages.passkey.createFailed;
  if (step.kind === 'confirm-failed') return messages.passkey.confirmFailed;
  return null;
}

interface EndedProps {
  readonly protection: Protection;
  readonly linkBackup: boolean;
  readonly onBackup: (() => void) | undefined;
}

/** The line for how setup ended. */
const ENDED: Readonly<Record<Protection, string>> = {
  protected: messages.passkey.locked,
  'no-prf': messages.passkey.noPrf,
  'no-recovery': messages.passkey.noRecovery,
};

/** How setup ended, in one line that takes focus, with Save a backup after a line that locked nothing. */
function Ended({ protection, linkBackup, onBackup }: EndedProps) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    line.current?.focus();
  }, []);
  const locked = protection === 'protected';
  return (
    <div className="stack">
      <p ref={line} tabIndex={-1} className="lede passkey-ended">
        {ENDED[protection]}
      </p>
      {!locked && linkBackup ? (
        <p>
          <Link
            className="forward-link"
            href={routeHref({ name: 'settings' })}
            {...(onBackup === undefined ? {} : { onPress: onBackup })}
          >
            {messages.passkey.saveBackup}
            <span aria-hidden="true">{messages.app.forward}</span>
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** Make a passkey, Confirm your passkey, then how it ended. */
export function PasskeySetup(props: PasskeySetupProps) {
  const { onCreate, onProtect, onEnd, linkBackup, onBackup, aside, secondary = false } = props;
  const [step, setStep] = useState<Step>({ kind: 'create' });
  // A ref, not state, so a second tap in the same moment sees the first.
  const busy = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  // The button was disabled while its tap waited, so it takes focus back once the tap settles.
  useEffect(() => {
    if (step.kind === 'confirm' || step.kind.endsWith('-failed')) button.current?.focus();
  }, [step.kind]);

  if (step.kind === 'ended') {
    return <Ended protection={step.protection} linkBackup={linkBackup} onBackup={onBackup} />;
  }

  const run = <T,>(start: Step, call: () => Promise<T>, done: (value: T) => Step, failed: Step) => {
    if (busy.current) return;
    busy.current = true;
    setStep(start);
    call().then(
      (value) => {
        busy.current = false;
        setStep(done(value));
      },
      () => {
        busy.current = false;
        setStep(failed);
      },
    );
  };
  const press = () => {
    if ('id' in step) {
      const { id } = step;
      run({ kind: 'confirming', id }, () => onProtect(id), ended, { kind: 'confirm-failed', id });
    } else {
      run({ kind: 'creating' }, onCreate, (made) => ({ kind: 'confirm', id: made }), {
        kind: 'create-failed',
      });
    }
  };
  const ended = (protection: Protection): Step => {
    onEnd?.(protection);
    return { kind: 'ended', protection };
  };
  const confirming = 'id' in step;
  const error = errorOf(step);
  return (
    <div className="stack">
      {confirming ? <p className="lede">{messages.passkey.confirmLede}</p> : null}
      <div className="row passkey-actions">
        <Button
          ref={button}
          className={secondary ? 'button button-secondary' : 'button button-primary'}
          isDisabled={step.kind === 'creating' || step.kind === 'confirming'}
          onPress={press}
        >
          {confirming ? messages.passkey.confirm : messages.passkey.create}
        </Button>
        {aside}
      </div>
      <p role="status" className="status">
        {statusOf(step)}
      </p>
      {error === null ? null : (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
