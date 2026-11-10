/**
 * Leave this group (#77; ADR-0010: exit is always possible): a button on
 * People that opens an alert dialog ({@link ConfirmDialog}), which says
 * plainly what leaving does and doesn't do before anything is queued. Its
 * last sentence says the group gets a new key when someone leaves (#98), so
 * neither this device nor a backup reads what comes next.
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
