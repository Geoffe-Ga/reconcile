import { messages } from './messages';

/** Props for {@link SendStatus}. */
export interface SendStatusProps {
  /** Whether the event is still in this device's outbox. */
  readonly pending: boolean;
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
  /** Whether this screen sent the event, so its leaving the outbox means it was sent. */
  readonly sent: boolean;
}

function line({ pending, reachable, sent }: SendStatusProps): string {
  if (pending) return reachable ? messages.send.sending : messages.send.saved;
  return sent ? messages.send.sent : '';
}

/**
 * Where an event this device made has got to (spec §7): saved on this device
 * while the relay can't be reached, then "Sent" once it leaves the outbox. A
 * polite live region, present from the start so every change is announced.
 */
export function SendStatus(props: SendStatusProps) {
  return (
    <p role="status" className="status">
      {line(props)}
    </p>
  );
}
