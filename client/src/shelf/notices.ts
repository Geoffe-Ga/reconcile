/**
 * The steward's notices (#488; ADR-0081; docs/spec/listed-doors.md §4.3
 * rules 1 and 8, §6.1).
 *
 * The steward signs each notice with its key (`crypto/steward.ts`), and the
 * relay acts on it so held records aren't downloaded. Every device folds it
 * too, so the relay alone is never trusted: a notice counts only when it was
 * served under the steward's address pinned in `steward.ts` and its
 * signature verifies against that key. With no key pinned, none counts.
 *
 * Built here: `release`, which lets a listing and its entries show (the fold
 * shows only a released listing, `fold.ts` rule 8). Every later act (`hold`,
 * `uphold`, `suspend` and `pause`) parses (`record.ts`) and is ignored, as a
 * named stub, until #489 folds it ({@link laterNotice}).
 */
import { verifyShelfRecord } from '../crypto/shelf';
import type { SigningKeys } from '../crypto/sign';
import type { ShelfRecord } from '../net/shelf';
import {
  type LaterAct,
  type LaterNoticeBody,
  type NoticeBody,
  parseShelfBody,
  signShelfBody,
} from './record';
import { STEWARD_PINS, type StewardPins } from './steward';

/** The acts #489 folds, in §6.1's order. */
export const LATER_NOTICE_ACTS: readonly LaterAct[] = ['hold', 'uphold', 'suspend', 'pause'];

/** `body` signed with the steward's `keys`, ready to PUT under their address. */
export function signNotice(keys: SigningKeys, body: NoticeBody): Uint8Array<ArrayBuffer> {
  return signShelfBody(keys, body);
}

/** What the steward's notices say, as every device folds them. */
export interface NoticeState {
  /** The addresses a release names: their listings may show. */
  readonly released: ReadonlySet<string>;
  /** The later notices that verified, in seq order: parsed, and acted on by nothing until #489. */
  readonly later: readonly LaterNoticeBody[];
}

/** The notice in `record`, when the pinned steward key signed it; else null (rule 1). */
function pinnedNotice(record: ShelfRecord, pins: StewardPins | null): NoticeBody | null {
  if (pins === null || record.address !== pins.sign) return null;
  const message = verifyShelfRecord(record.data, pins.sign);
  const body = message === null ? null : parseShelfBody(message);
  return body?.kind === 'notice' ? body : null;
}

/**
 * The stub for every later act (#489): it parsed, so a newer relay's notices
 * read without error, and it is only noted in `later`, which nothing reads:
 * no listing, entry or pause changes until #489 says what each does.
 */
export function laterNotice(notice: LaterNoticeBody, state: NoticeState): NoticeState {
  return { ...state, later: [...state.later, notice] };
}

/**
 * The notices among `records` that verify against `pins` (the app's,
 * unless given), folded in any order: each release adds its address.
 */
export function foldNotices(
  records: readonly ShelfRecord[],
  pins: StewardPins | null = STEWARD_PINS,
): NoticeState {
  const released = new Set<string>();
  let state: NoticeState = { released, later: [] };
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const notice = pinnedNotice(record, pins);
    if (notice === null) continue;
    if (notice.act === 'release') released.add(notice.address);
    else state = laterNotice(notice, state);
  }
  return state;
}
