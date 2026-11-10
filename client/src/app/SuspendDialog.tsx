import { type SyntheticEvent, useState } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Form,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';

import { REASON_MAX } from '../engine/stewards';
import { nfcLength } from '../engine/text';
import { messages } from './messages';
import { Named } from './stewards';
import { Field } from './ui';
import { useSaving } from './useSaving';

/** Props for {@link SuspendDialog}. */
export interface SuspendDialogProps {
  /** The name of the person it would suspend, as the group sees it. */
  readonly name: string;
  /** How long a suspension lasts, from the group's rules. */
  readonly days: number;
  /** Queues one `suspend` with the trimmed reason, blank for none; rejects when it couldn't be saved. */
  readonly onSuspend: (reason: string) => Promise<void>;
}

/** The reason counts code points after NFC, as the fold does (ADR-0072 §4). */
function reasonProblem(reason: string): string | null {
  return nfcLength(reason.trim()) > REASON_MAX ? messages.stewards.reasonTooLong(REASON_MAX) : null;
}

interface SuspendFormProps extends SuspendDialogProps {
  readonly close: () => void;
}

/** The dialog's content: who and for how long, the optional reason, then Suspend or Cancel. */
function SuspendForm({ name, days, onSuspend, close }: SuspendFormProps) {
  const [reason, setReason] = useState('');
  const { run, running, outcome } = useSaving(onSuspend);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reasonProblem(reason) !== null) return;
    void run(reason.trim()).then((saved) => {
      if (saved) close();
    });
  };
  const { stewards } = messages;
  return (
    <Form className="form dialog-form" onSubmit={submit}>
      <Heading slot="title" className="dialog-title">
        <Named parts={stewards.dialogTitle} name={name} />
      </Heading>
      <p className="lede">{stewards.dialogLine(days)}</p>
      <Field
        name="reason"
        label={stewards.reasonLabel}
        hint={stewards.reasonHint}
        multiline
        value={reason}
        onChange={setReason}
        validate={reasonProblem}
      />
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {stewards.suspendFailed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {stewards.confirm}
        </Button>
        <Button className="button button-secondary" onPress={close} isDisabled={running}>
          {stewards.cancel}
        </Button>
      </div>
    </Form>
  );
}

/**
 * Suspend, on a person in the People list, for a steward who may suspend them
 * (ADR-0016, #102). It opens a React Aria modal dialog, which keeps focus
 * inside until it closes: who it suspends, the line that everyone in the
 * group sees it and when it ends, and an optional reason of at most 280 code
 * points. Suspend queues one `suspend` and closes; Cancel and Escape close
 * without one.
 */
export function SuspendDialog(props: SuspendDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        className="button button-quiet person-action"
        aria-label={messages.stewards.suspendLabel(props.name)}
      >
        {messages.stewards.suspend}
      </Button>
      <ModalOverlay className="modal-overlay" isDismissable>
        <Modal className="modal">
          <Dialog className="dialog">
            {({ close }) => <SuspendForm {...props} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
