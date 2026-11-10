/**
 * Leave this group (#77; ADR-0010: exit is always possible): a button on
 * People that opens an alert dialog ({@link ConfirmDialog}), which says
 * plainly what leaving does and doesn't do before anything is queued. Under
 * ADR-0073, keys don't rotate, and the dialog says so until #98 replaces its
 * last sentence.
 */
import { ConfirmDialog } from './ConfirmDialog';
import { messages } from './messages';

/** Props for {@link LeaveDialog}. */
export interface LeaveDialogProps {
  /** Queues this member's leave and marks the group as leaving; rejects when it couldn't be saved. */
  readonly onLeave: () => Promise<void>;
}

/** "Leave this group", and the alert dialog it opens. */
export function LeaveDialog({ onLeave }: LeaveDialogProps) {
  const { leave } = messages;
  return (
    <ConfirmDialog
      open={leave.open}
      title={leave.title}
      body={leave.body}
      confirm={leave.confirm}
      cancel={leave.cancel}
      failed={leave.failed}
      onConfirm={onLeave}
    />
  );
}
