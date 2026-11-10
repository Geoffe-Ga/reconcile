/**
 * Vouch for <name> (#101; ADR-0014): a button on a newcomer's row in People,
 * for a member who may vouch for them, and the modal dialog it opens. Before
 * anything is queued, the dialog asks the member to vouch only for someone
 * they've met or talked with, and says that everyone in the group sees it.
 * The group's chat sits beside that line, since that's where people meet
 * first (ADR-0011): Reconcile is not a video platform.
 *
 * Built on React Aria's `DialogTrigger`, `ModalOverlay`, `Modal` and
 * `Dialog`, so focus moves into the dialog, stays there, and returns to the
 * button when it closes. Vouch queues one `vouch` and closes; Cancel and
 * Escape close with nothing queued.
 */
import { useState } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { ChatLink } from './ChatLink';
import { holdPresses } from './holdPresses';
import { messages } from './messages';
import { Named } from './stewards';
import { useSaving } from './useSaving';

/** Props for {@link VouchDialog}. */
export interface VouchDialogProps {
  /** The newcomer's name, as the group sees it. */
  readonly name: string;
  /** The group's latest chat link from its log, or null when it has none. */
  readonly chat: string | null;
  /** Queues one `vouch` for the newcomer; rejects when it couldn't be saved. */
  readonly onVouch: () => Promise<void>;
}

/** The dialog's body: who, the line about meeting first, the chat, then Vouch and Cancel. */
function VouchBody({
  name,
  chat,
  onVouch,
  close,
}: VouchDialogProps & { readonly close: () => void }) {
  const { run, running, outcome } = useSaving(onVouch);
  const confirm = () => {
    void run().then((saved) => {
      if (saved) close();
    });
  };
  const { admission } = messages;
  return (
    <div className="stack">
      <Heading slot="title" className="dialog-title">
        <Named parts={admission.dialogTitle} name={name} />
      </Heading>
      <p className="lede">{admission.dialogLine}</p>
      <div>
        <ChatLink href={chat} />
      </div>
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {admission.failed}
        </p>
      ) : null}
      <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
        <Button className="button button-primary" onPress={confirm} isDisabled={running}>
          {admission.confirm}
        </Button>
        <Button className="button button-secondary" onPress={close} isDisabled={running}>
          {admission.cancel}
        </Button>
      </div>
    </div>
  );
}

/** "Vouch for <name>", and the dialog it opens. */
export function VouchDialog(props: VouchDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button className="button button-quiet">
        {/* One flex item, so the button's gap doesn't widen the space before the name. */}
        <span>
          <Named parts={messages.admission.vouchFor} name={props.name} />
        </span>
      </Button>
      <ModalOverlay className="modal-overlay" isDismissable>
        <Modal className="modal">
          <Dialog className="dialog">
            {({ close }) => <VouchBody {...props} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
