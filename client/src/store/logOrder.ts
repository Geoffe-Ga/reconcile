/**
 * Where records read from the relay go in a group's log (#110): in relay
 * order, which the fold reads it in.
 *
 * A pass reads several weekly mailboxes, so a record that reached last week's
 * mailbox just as the week turned, after this device had read it, comes in a
 * later pass than records with higher seqs from this week's. It still goes
 * before them, so every device folds the same log. Within one relay, a higher
 * seq never arrived earlier (the relay stamps and stores each blob in one
 * step), so a record goes after the last one that has a lower seq or arrived
 * earlier. A fresh relay instance starts its seqs again from 1, and its
 * records arrived after all of the old instance's, so they stay after them,
 * as they always have.
 */
import type { LogRecord } from '../engine/fold';

/** Whether `kept` belongs after `record` in relay order: a higher seq, received no earlier. */
function comesAfter(kept: LogRecord | undefined, record: LogRecord): boolean {
  return kept !== undefined && kept.seq > record.seq && kept.received >= record.received;
}

/**
 * `log` with each of `added` put, in turn, after the last record that doesn't
 * come after it in relay order: at the end, unless records read earlier came
 * after it. `log` itself is left as it was.
 */
export function placedInLog(log: readonly LogRecord[], added: readonly LogRecord[]): LogRecord[] {
  const placed = [...log];
  for (const record of added) {
    let at = placed.length;
    while (comesAfter(placed[at - 1], record)) at -= 1;
    placed.splice(at, 0, record);
  }
  return placed;
}
