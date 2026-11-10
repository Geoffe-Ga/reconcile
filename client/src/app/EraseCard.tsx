/**
 * The Erase card (DESIGN.md; #78): "Erase Reconcile from this device", in the
 * same calm style as any setting, which reveals what Erase does and the
 * press-and-hold confirm, with Cancel. Settings holds it, and so does the
 * unlock screen once a passkey fails to unlock the device (#95), so a device
 * whose passkey is lost can still start over.
 */
import { useId, useState } from 'react';
import { Button } from 'react-aria-components';

import { HoldToConfirm } from './HoldToConfirm';
import { messages } from './messages';

/** Props for {@link EraseCard}. */
export interface EraseCardProps {
  /** Erases all of Reconcile's data on this device and reloads; rejects when it couldn't. */
  readonly onErase: () => Promise<void>;
}

/** Erase Reconcile from this device, behind its disclosure and a 3-second hold. */
export function EraseCard({ onErase }: EraseCardProps) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { erase } = messages;
  return (
    <div className="card erase-card">
      <div>
        <Button
          className="button button-secondary"
          aria-expanded={open}
          {...(open ? { 'aria-controls': panel } : {})}
          onPress={() => {
            setOpen((now) => !now);
          }}
        >
          {erase.open}
        </Button>
      </div>
      {open ? (
        <div id={panel} className="stack erase-panel">
          <p>{erase.body}</p>
          <HoldToConfirm
            label={erase.hold}
            released={erase.released}
            busy={erase.erasing}
            failed={erase.failed}
            onConfirm={onErase}
          />
          <div>
            <Button
              className="button button-quiet"
              onPress={() => {
                setOpen(false);
              }}
            >
              {erase.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
