/**
 * Press and hold to confirm (#78; DESIGN.md "Erase card"): the last step of
 * Erase Reconcile from this device, and the only place `negative` appears.
 *
 * Holding the button for {@link HOLD_SECONDS} seconds, by pointer, Space or
 * Enter, confirms. Letting go sooner, or sliding off it, cancels, and a held
 * key's repeats never count as a new press (React Aria's usePress). A polite
 * live region counts the seconds down and says when a release cancelled.
 * Once it confirms, the button is disabled and further presses do nothing,
 * even React Aria's late synthetic click on a disabled button (#190); if
 * confirming fails, it says so and can be held again.
 */
import { useEffect, useEffectEvent, useId, useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from './messages';

/** How long the button must be held. */
export const HOLD_SECONDS = 3;

/** Props for {@link HoldToConfirm}. */
export interface HoldToConfirmProps {
  /** The button's words, such as "Hold to erase". */
  readonly label: string;
  /** What the live region says when a release cancels. */
  readonly released: string;
  /** What it says once the hold confirms, while `onConfirm` runs. */
  readonly busy: string;
  /** What an alert says when `onConfirm` rejects. */
  readonly failed: string;
  /** What a full hold does. */
  readonly onConfirm: () => Promise<void>;
}

/** Where a hold has got to. */
type Hold =
  | { readonly kind: 'idle' | 'released' | 'busy' | 'failed' }
  | { readonly kind: 'holding'; readonly left: number };

/** The live region's words for `hold`. */
function statusOf(hold: Hold, { released, busy }: HoldToConfirmProps): string {
  switch (hold.kind) {
    case 'holding':
      return messages.hold.holding(hold.left);
    case 'released':
      return released;
    case 'busy':
      return busy;
    default:
      return '';
  }
}

/** A button that confirms only after a {@link HOLD_SECONDS}-second hold. */
export function HoldToConfirm(props: HoldToConfirmProps) {
  const [hold, setHold] = useState<Hold>({ kind: 'idle' });
  const hint = useId();

  const confirm = useEffectEvent(() => {
    setHold({ kind: 'busy' });
    props.onConfirm().catch(() => {
      setHold({ kind: 'failed' });
    });
  });

  // One second at a time, so the live region can count down; each tick is a new state.
  useEffect(() => {
    if (hold.kind !== 'holding') return;
    const handle = window.setTimeout(() => {
      if (hold.left > 1) setHold({ kind: 'holding', left: hold.left - 1 });
      else confirm();
    }, 1000);
    return () => {
      window.clearTimeout(handle);
    };
  }, [hold]);

  const start = () => {
    setHold((now) => (now.kind === 'busy' ? now : { kind: 'holding', left: HOLD_SECONDS }));
  };
  const end = () => {
    setHold((now) => (now.kind === 'holding' ? { kind: 'released' } : now));
  };

  return (
    <div className="hold">
      <p id={hint} className="field-hint">
        {messages.hold.hint(HOLD_SECONDS)}
      </p>
      <Button
        className="button button-negative"
        onPressStart={start}
        onPressEnd={end}
        isDisabled={hold.kind === 'busy'}
        aria-describedby={hint}
      >
        {props.label}
      </Button>
      <span className="hold-track" aria-hidden="true">
        <span className="hold-fill" data-holding={hold.kind === 'holding' ? 'true' : undefined} />
      </span>
      <p role="status" className="status">
        {statusOf(hold, props)}
      </p>
      {hold.kind === 'failed' ? (
        <p role="alert" className="form-error">
          {props.failed}
        </p>
      ) : null}
    </div>
  );
}
