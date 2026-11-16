/**
 * Whether a key change was refused (#224; ADR-0075's 2026-11-11 amendment).
 *
 * The fold can't open a wrap, so it can't tell a key change whose wraps open
 * from one whose wraps are random bytes. Devices can: each one whose own wrap
 * opens makes every other wrap again from the secret (`crypto/epoch.ts`), and
 * takes the key up only when all of them match. What a device found goes into
 * the log, and the fold reads it here:
 *
 * - an `unwrap-failed` naming a key change, from one of its recipients, read
 *   from the old epoch's mailbox (the device that can't take the key up can't
 *   write anywhere else), says it doesn't work;
 * - a `key-taken` naming it, from one of its recipients, read from its own
 *   epoch's mailbox, says a device checked every wrap and took it up.
 *
 * A key change is refused when an `unwrap-failed` names it and no `key-taken`
 * does. Either can come later in relay order than the key change, so the fold
 * reads them ahead, before it starts, as it reads a cleared Proposal's result
 * ahead (#111), and decides at the key change's own place.
 *
 * A false `unwrap-failed` from a member who could open their wrap changes
 * nothing for a device that took the key up, since that device posts a
 * `key-taken` to the new mailbox, and only a device that holds the new secret
 * can write there. A device reads a new epoch's mailboxes only once it has
 * checked every wrap, so a `key-taken` the attacker posts to a key change
 * nobody honest took up never reaches an honest device's log.
 *
 * Neither counts from a recipient a removal had passed against by the key
 * change's place (#372): once a removal passes, nothing else of theirs counts
 * (#115), and a key change can still wrap to them until a `remove` lands.
 * Ignoring them costs nothing, since every other recipient's device checks
 * their wrap as well. Devices can't split over it: who is ousted there is
 * what the fold already reads at that place for whether each record counts,
 * the same on every device that holds the same log. A removal that passes
 * after the key change doesn't reach back to it; its member's check counts as
 * any recipient's does, and a false one costs the honest recipients a
 * `key-taken`, as above.
 */
import type { GroupEvent, ParsedEvent } from './event';
import { EVENT_VERSION } from './event';

/** One `unwrap-failed` or `key-taken` as the fold reads it ahead: where it sits, who wrote it, for which group. */
export interface KeyCheck {
  readonly seq: number;
  /** The epoch of the mailbox it was read from. */
  readonly epoch: number;
  readonly author: string;
  readonly group: string;
}

/** Every `unwrap-failed` and `key-taken` in the log, by the key change each names. */
export interface KeyChecks {
  readonly failed: ReadonlyMap<string, readonly KeyCheck[]>;
  readonly taken: ReadonlyMap<string, readonly KeyCheck[]>;
}

/** A record as the fold reads it once: its seq, its mailbox's epoch and its event, or null. */
interface Read {
  readonly seq: number;
  readonly epoch: number;
  readonly parsed: ParsedEvent | null;
}

/** An `unwrap-failed` or a `key-taken`. */
type KeyCheckEvent = Extract<GroupEvent, { readonly type: 'unwrap-failed' | 'key-taken' }>;

/** `event` when it is a version-1 `unwrap-failed` or `key-taken`, else null. */
function keyCheckEvent(event: GroupEvent | undefined): KeyCheckEvent | null {
  if (event?.v !== EVENT_VERSION) return null;
  return event.type === 'unwrap-failed' || event.type === 'key-taken' ? event : null;
}

/** Every version-1 `unwrap-failed` and `key-taken` in `reads`, by the key change each names, in relay order. */
export function keyChecksOf(reads: readonly Read[]): KeyChecks {
  const failed = new Map<string, KeyCheck[]>();
  const taken = new Map<string, KeyCheck[]>();
  for (const { seq, epoch, parsed } of reads) {
    const event = keyCheckEvent(parsed?.event);
    if (event === null) continue;
    const map = event.type === 'unwrap-failed' ? failed : taken;
    const { rotation } = event.body;
    const checks = map.get(rotation) ?? [];
    checks.push({ seq, epoch, author: event.author, group: event.group });
    map.set(rotation, checks);
  }
  return { failed, taken };
}

/** No `unwrap-failed` or `key-taken` at all. */
export const NO_KEY_CHECKS: KeyChecks = { failed: new Map(), taken: new Map() };

/** A key change as {@link isRefused} reads it: its id, place, group, epochs and recipients. */
export interface CheckedRotation {
  /** The `key-rotate`'s event id, which the checks name. */
  readonly id: string;
  readonly seq: number;
  readonly group: string;
  /** The epoch whose mailbox it was read from: the one it moves the group out of. */
  readonly from: number;
  /** The epoch it moves the group into. */
  readonly to: number;
  /** Its wraps, by recipient. */
  readonly wraps: Readonly<Record<string, string>>;
  /**
   * The members a removal had passed against by its place (#115; #372). A
   * check from one of them doesn't count, as nothing else of theirs does.
   */
  readonly ousted: readonly string[];
}

/**
 * Whether any of `checks` comes after `rotation`, from one of its recipients
 * no removal had passed against by its place, in its group, read from
 * `epoch`'s mailbox.
 */
function anyFrom(
  checks: readonly KeyCheck[] | undefined,
  rotation: CheckedRotation,
  epoch: number,
): boolean {
  return (checks ?? []).some(
    (check) =>
      check.seq > rotation.seq &&
      check.epoch === epoch &&
      check.group === rotation.group &&
      Object.hasOwn(rotation.wraps, check.author) &&
      !rotation.ousted.includes(check.author),
  );
}

/**
 * Whether `rotation` is refused: a recipient's `unwrap-failed` names it, read
 * from the mailbox it moves the group out of, and no recipient's `key-taken`
 * names it, read from the mailbox it moves the group into.
 */
export function isRefused(checks: KeyChecks, rotation: CheckedRotation): boolean {
  if (!anyFrom(checks.failed.get(rotation.id), rotation, rotation.from)) return false;
  return !anyFrom(checks.taken.get(rotation.id), rotation, rotation.to);
}
