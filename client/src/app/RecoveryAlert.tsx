/**
 * The recovery alert (#118; ADR-0043 §2, ADR-0008): what the person's own
 * devices show, on Start and on every group home, while a recovery of their
 * groups waits out its 72 hours, with Cancel this recovery. Its words are
 * the issue's, and it is a notice with a `warning` rule, never a modal or a
 * banner (DESIGN.md: safety stays quiet). Once every alert is cancelled, it
 * says so in plain words on the same card until the hold would have ended.
 */
import { useState } from 'react';
import { Button } from 'react-aria-components';

import type { AlertSummary } from '../recovery/alert';
import { messages } from './messages';
import { formatDay, MINUTE_MS } from './time';

/** Props for {@link RecoveryAlert}. */
export interface RecoveryAlertProps {
  /** What to show: a recovery to cancel, one cancelled, or nothing. */
  readonly summary: AlertSummary;
  /** Posts a cancel for every pending alert; rejects when it couldn't be queued. */
  readonly onCancel: () => Promise<void>;
}

/** Where a press of Cancel has got to. */
type Cancelling = 'idle' | 'busy' | 'failed';

/** The alert's words, Cancel this recovery, and how cancelling is going. */
function Pending({
  completes,
  onCancel,
}: { readonly completes: number } & Pick<RecoveryAlertProps, 'onCancel'>) {
  const words = messages.recoveryAlert;
  const [cancelling, setCancelling] = useState<Cancelling>('idle');
  const cancel = () => {
    setCancelling('busy');
    onCancel().then(
      () => {
        setCancelling('idle');
      },
      () => {
        setCancelling('failed');
      },
    );
  };
  return (
    <div className="recovery-alert">
      <p>{words.body(formatDay(completes * MINUTE_MS))}</p>
      <div className="field-status">
        <Button
          className="button button-secondary"
          onPress={cancel}
          isDisabled={cancelling === 'busy'}
        >
          {words.cancel}
        </Button>
        <p role="status" className="status">
          {cancelling === 'busy' ? words.cancelling : ''}
        </p>
      </div>
      {cancelling === 'failed' ? (
        <p role="alert" className="form-error">
          {words.failed}
        </p>
      ) : null}
    </div>
  );
}

/** The alert for `summary`, or nothing when there is none. */
export function RecoveryAlert({ summary, onCancel }: RecoveryAlertProps) {
  if (summary === null) return null;
  if (summary.kind === 'cancelled') {
    return (
      <div className="recovery-alert recovery-alert-cancelled">
        <p role="status">{messages.recoveryAlert.cancelled}</p>
      </div>
    );
  }
  return <Pending completes={summary.completes} onCancel={onCancel} />;
}
