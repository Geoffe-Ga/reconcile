/**
 * The steward's notices (#488, #489; ADR-0081; docs/spec/listed-doors.md
 * §4.3 rules 1 and 8, §6.1).
 *
 * The steward signs each notice with its key (`crypto/steward.ts`), and the
 * relay acts on it so held records aren't downloaded. Every device folds it
 * too, so the relay alone is never trusted: a notice counts only when it was
 * served under the steward's address pinned in `steward.ts` and its
 * signature verifies against that key. With no key pinned, none counts.
 *
 * What each act says, folded in seq order (`fold.ts` applies it):
 *
 * - **release** (#488): the address's listing and its entries may show.
 * - **hold**: an entry, or a whole listing and so its entries, hides for
 *   {@link HOLD_MINUTES} relay minutes from the notice's receipt. The latest
 *   hold on each target stands. Without an uphold it shows again: an absent
 *   steward, or a thief who only holds, fails open (§6.1).
 * - **uphold**: the entry comes down, and a tombstone naming the clause
 *   takes its place until the entry's 30 days end.
 * - **suspend**: the listing comes down with its entries, a tombstone takes
 *   its place, and the door's page says so. The first suspend of an address
 *   names its clause.
 * - **unsuspend** (#490): a suspension that stands ends, its tombstone with
 *   it, and so does every release of the address before it, so the listing
 *   the group posts next waits for a fresh release, as any first listing
 *   does on a held relay. The suspend stays in the log: a suspend after the
 *   lift stands again, under its own clause. One with no suspension
 *   standing lifts nothing.
 * - **pause**: the newest pause decides: `on`, the whole shelf section
 *   hides behind one line; off, it shows again.
 *
 * A notice names a clause and what it acts on, never who reported it
 * (ADR-0013: decisions are public).
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { SigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import { type Clause, type NoticeBody, parseShelfBody, signShelfBody } from './record';
import { STEWARD_PINS, type StewardPins } from './steward';

/** Relay minutes a hold hides what it names (§6.1): 7 relay days. */
export const HOLD_MINUTES = 10_080;

/** `body` signed with the steward's `keys`, ready to PUT under their address. */
export function signNotice(keys: SigningKeys, body: NoticeBody): Uint8Array<ArrayBuffer> {
  return signShelfBody(keys, body);
}

/** A hold as every device folds it: what it hides, why, and until when. */
export interface NoticeHold {
  readonly address: string;
  /** The entry it holds, or null for the whole listing. */
  readonly id: string | null;
  readonly clause: Clause;
  /** The notice's seq. */
  readonly seq: number;
  /** The relay minute it lapses: {@link HOLD_MINUTES} after its receipt. */
  readonly until: number;
}

/** An uphold or a suspend: what came down, and why. */
export interface NoticeRemoval {
  readonly address: string;
  /** The entry an uphold removed, or null for a suspended listing. */
  readonly id: string | null;
  readonly clause: Clause;
  /** The notice's seq and the relay minute it arrived. */
  readonly seq: number;
  readonly received: number;
}

/** What the steward's notices say, as every device folds them. */
export interface NoticeState {
  /** The addresses a release names: their listings may show. */
  readonly released: ReadonlySet<string>;
  /** The latest hold on each entry or listing, standing or lapsed, in seq order. */
  readonly holds: readonly NoticeHold[];
  /** Each upheld entry, in seq order. */
  readonly upheld: readonly NoticeRemoval[];
  /** Each address whose suspension stands, by the first suspend since any lift, in seq order. */
  readonly suspended: readonly NoticeRemoval[];
  /** Whether the newest pause is on. */
  readonly paused: boolean;
}

/** The notice in `record`, when the pinned steward key signed it; else null (rule 1). */
function pinnedNotice(record: ShelfRecord, pins: StewardPins | null): NoticeBody | null {
  if (pins === null || record.address !== pins.sign) return null;
  const message = verifyShelfRecord(record.data, pins.sign);
  const body = message === null ? null : parseShelfBody(message);
  return body?.kind === 'notice' ? body : null;
}

/** The key of what a notice names: an address and an entry, or an address alone. */
const targetOf = (address: string, id: string | null): string => `${address} ${id ?? ''}`;

/** Whether `hold` still hides what it names at relay minute `now`. */
export const holdStands = (hold: NoticeHold, now: number): boolean => now < hold.until;

/** What the notices fold to, as they are gathered. */
interface Gathering {
  readonly released: Set<string>;
  readonly holds: Map<string, NoticeHold>;
  readonly upheld: Map<string, NoticeRemoval>;
  readonly suspended: Map<string, NoticeRemoval>;
  paused: boolean;
}

/** Folds one verified notice from `record` into `into`. */
function gather(into: Gathering, notice: NoticeBody, { seq, received }: ShelfRecord): void {
  switch (notice.act) {
    case 'release':
      into.released.add(notice.address);
      return;
    case 'hold': {
      const { address, clause } = notice;
      const id = notice.id ?? null;
      into.holds.set(targetOf(address, id), {
        address,
        id,
        clause,
        seq,
        until: received + HOLD_MINUTES,
      });
      return;
    }
    case 'uphold': {
      const { address, id, clause } = notice;
      into.upheld.set(targetOf(address, id), { address, id, clause, seq, received });
      return;
    }
    case 'suspend': {
      const { address, clause } = notice;
      if (!into.suspended.has(address)) {
        into.suspended.set(address, { address, id: null, clause, seq, received });
      }
      return;
    }
    case 'unsuspend':
      if (into.suspended.delete(notice.address)) into.released.delete(notice.address);
      return;
    case 'pause':
      into.paused = notice.on;
  }
}

/**
 * The notices among `records` that verify against `pins` (the app's,
 * unless given), folded in seq order, so any order the relay serves them in
 * folds the same.
 */
export function foldNotices(
  records: readonly ShelfRecord[],
  pins: StewardPins | null = STEWARD_PINS,
): NoticeState {
  const into: Gathering = {
    released: new Set(),
    holds: new Map(),
    upheld: new Map(),
    suspended: new Map(),
    paused: false,
  };
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const notice = pinnedNotice(record, pins);
    if (notice !== null) gather(into, notice, record);
  }
  return {
    released: into.released,
    holds: [...into.holds.values()].sort((a, b) => a.seq - b.seq),
    upheld: [...into.upheld.values()],
    suspended: [...into.suspended.values()],
    paused: into.paused,
  };
}

/**
 * The hold that hides `address`'s entry `id` (or, for null, its listing) at
 * relay minute `now`: one on the listing hides every entry under it too.
 */
export function holdOn(
  state: Pick<NoticeState, 'holds'>,
  address: string,
  id: string | null,
  now: number,
): NoticeHold | null {
  const stands = (hold: NoticeHold) =>
    hold.address === address && (hold.id === null || hold.id === id) && holdStands(hold, now);
  return state.holds.find(stands) ?? null;
}

/** Whether a hold hides `address`'s entry `id` (or, for null, its listing) at relay minute `now`. */
export function isHeld(
  state: Pick<NoticeState, 'holds'>,
  address: string,
  id: string | null,
  now: number,
): boolean {
  return holdOn(state, address, id, now) !== null;
}
