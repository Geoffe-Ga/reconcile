/**
 * A button that opens an alert dialog, which says plainly what an action
 * does before it happens: Leave this group (#77) and Remove from this
 * device (#108).
 *
 * Built on React Aria's `DialogTrigger`, `ModalOverlay`, `Modal` and `Dialog`,
 * so focus moves into the dialog, stays there, and returns to the button when
 * it closes. Escape and Cancel close it with nothing done.
 */
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { useSaving } from './useSaving';

/** What the dialog says, and the action its confirm runs. */
export interface ConfirmDialogProps {
  /** The button that opens it. */
  readonly open: string;
  /** The dialog's heading, a question. */
  readonly title: string;
  /** What the action does and doesn't do, in plain words. */
  readonly body: string;
  /** The confirm button. */
  readonly confirm: string;
  /** The button that closes it with nothing done. */
  readonly cancel: string;
  /** The line shown when the action rejects. */
  readonly failed: string;
  /** Runs the action; rejects when it couldn't be done. */
  readonly onConfirm: () => Promise<void>;
}

/** The dialog's body: the plain words, then the confirm and Cancel. */
function ConfirmBody(props: ConfirmDialogProps & { readonly close: () => void }) {
  const { title, body, confirm, cancel, failed, onConfirm, close } = props;
  const { run, running, outcome } = useSaving(onConfirm);
  const press = () => {
    void run().then((done) => {
      if (done) close();
    });
  };
  return (
    <div className="stack">
      <Heading slot="title" className="dialog-title">
        {title}
      </Heading>
      <p className="lede">{body}</p>
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button className="button button-primary" onPress={press} isDisabled={running}>
          {confirm}
        </Button>
        <Button className="button button-secondary" onPress={close} isDisabled={running}>
          {cancel}
        </Button>
      </div>
    </div>
  );
}

/** The button, and the alert dialog it opens. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <DialogTrigger>
      <Button className="button button-secondary">{props.open}</Button>
      <ModalOverlay className="modal-overlay">
        <Modal className="modal">
          <Dialog role="alertdialog" className="dialog">
            {({ close }) => <ConfirmBody {...props} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
