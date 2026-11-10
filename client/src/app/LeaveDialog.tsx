/**
 * Leave this group (#77; ADR-0010: exit is always possible): a button on
 * People that opens an alert dialog, which says plainly what leaving does and
 * doesn't do before anything is queued.
 *
 * Built on React Aria's `DialogTrigger`, `ModalOverlay`, `Modal` and `Dialog`,
 * so focus moves into the dialog, stays there, and returns to the button when
 * it closes. Escape and Cancel close it with nothing queued. Under ADR-0073,
 * keys don't rotate, and the dialog says so until #98 replaces its last
 * sentence.
 */
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { messages } from './messages';
import { useSaving } from './useSaving';

/** Props for {@link LeaveDialog}. */
export interface LeaveDialogProps {
  /** Queues this member's leave and marks the group as leaving; rejects when it couldn't be saved. */
  readonly onLeave: () => Promise<void>;
}

/** The dialog's body: the plain words, then Leave this group and Cancel. */
function LeaveBody({ onLeave, close }: LeaveDialogProps & { readonly close: () => void }) {
  const { run, running, outcome } = useSaving(onLeave);
  const confirm = () => {
    void run().then((left) => {
      if (left) close();
    });
  };
  const { leave } = messages;
  return (
    <div className="stack">
      <Heading slot="title" className="dialog-title">
        {leave.title}
      </Heading>
      <p className="lede">{leave.body}</p>
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {leave.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button className="button button-primary" onPress={confirm} isDisabled={running}>
          {leave.confirm}
        </Button>
        <Button className="button button-secondary" onPress={close} isDisabled={running}>
          {leave.cancel}
        </Button>
      </div>
    </div>
  );
}

/** "Leave this group", and the alert dialog it opens. */
export function LeaveDialog({ onLeave }: LeaveDialogProps) {
  return (
    <DialogTrigger>
      <Button className="button button-secondary">{messages.leave.open}</Button>
      <ModalOverlay className="modal-overlay">
        <Modal className="modal">
          <Dialog role="alertdialog" className="dialog">
            {({ close }) => <LeaveBody onLeave={onLeave} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
