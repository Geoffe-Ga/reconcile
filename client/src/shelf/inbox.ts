/**
 * The steward's inbox, on the steward's device (#490; ADR-0081;
 * docs/spec/listed-doors.md §6.3, §6.4).
 *
 * The console reads the inbox (`crypto/shelf.ts`) after the cursor this
 * device keeps for it, opens each box with the steward's box secret, as a
 * report or as an appeal, and keeps what it found beside the cursor in the
 * device's own store, so each blob is fetched once. A box that opens as
 * neither, a report or appeal out of bounds, and an appeal whose signature
 * doesn't verify against the address it names are dropped, and the cursor
 * passes them. A blob the relay serves twice is kept once, by its SHA-256.
 *
 * A new relay instance is read again from the start, and what the device
 * held stays; another inbox, after the steward's keys rotate, starts afresh.
 * Each item is kept until {@link INBOX_KEEP_MINUTES} after it arrived, by
 * the relay's minute, when the relay has surely deleted it too.
 *
 * What the device keeps names only listings and entries, which are public,
 * a clause and a note; nothing about whoever sent them.
 */
import { base64url } from '../crypto/base64url';
import { openPadded } from '../crypto/door';
import { sha256 } from '../crypto/hash';
import { APPEAL_INFO, REPORT_INFO, stewardInboxOf } from '../crypto/shelf';
import { kxPublicKeyOf } from '../crypto/box';
import type { Relay, RelayPage } from '../net/relay';
import type { Clause } from './record';
import { openAppeal, parseReport, STEWARD_TTL_DAYS } from './report';

/**
 * How long the device keeps an item, in relay minutes: the relay keeps a
 * blob until the UTC day of its arrival plus its 30 days plus one has
 * begun, so at most 32 days.
 */
export const INBOX_KEEP_MINUTES = (STEWARD_TTL_DAYS + 2) * 1440;

/** One report or appeal, as the console lists it. */
export interface InboxItem {
  /** The SHA-256 of its blob, in unpadded base64url: one copy per blob. */
  readonly key: string;
  readonly kind: 'report' | 'appeal';
  readonly seq: number;
  /** The relay minute it arrived. */
  readonly received: number;
  /** The listing's address. */
  readonly address: string;
  /** The entry it names, or null for an appeal about the whole listing. */
  readonly id: string | null;
  /** A report's clause; null for an appeal. */
  readonly clause: Clause | null;
  /** Its note, or null for a report without one. */
  readonly note: string | null;
}

/** What the steward's device keeps of the inbox: where, how far it read, and what it found. */
export interface KeptInbox {
  readonly inbox: string;
  /** The relay instance it read from, or null before the first read. */
  readonly instance: string | null;
  readonly cursor: number;
  readonly items: readonly InboxItem[];
}

/** Where the device keeps it: one record of its own store (`store/db.ts`). */
export interface InboxKeep {
  getStewardInbox(): Promise<KeptInbox | undefined>;
  /** Keeps `kept` in place of any earlier copy; null forgets it. */
  keepStewardInbox(kept: KeptInbox | null): Promise<void>;
}

/** What reading the inbox reaches. */
export interface InboxReadServices {
  readonly relay: Pick<Relay, 'getBlobs'>;
  readonly keep: InboxKeep;
}

/** The item `data` holds, opened with `secret` from `inbox`, or null. */
function itemOf(
  inbox: string,
  secret: Uint8Array,
  { seq, received, data }: RelayPage['records'][number],
): InboxItem | null {
  const at = { key: base64url(sha256(data)), seq, received };
  const asReport = openPadded(secret, data, REPORT_INFO, inbox);
  const report = asReport === null ? null : parseReport(asReport);
  if (report !== null) {
    const { address, id, clause, note } = report;
    return { ...at, kind: 'report', address, id, clause, note: note ?? null };
  }
  const asAppeal = openPadded(secret, data, APPEAL_INFO, inbox);
  const appeal = asAppeal === null ? null : openAppeal(asAppeal);
  if (appeal === null) return null;
  const { address, id, note } = appeal;
  return { ...at, kind: 'appeal', address, id: id ?? null, clause: null, note };
}

/** `held` and `found`, one per blob, without what arrived {@link INBOX_KEEP_MINUTES} before `now`. */
function merged(held: readonly InboxItem[], found: readonly InboxItem[], now: number): InboxItem[] {
  const byKey = new Map<string, InboxItem>();
  for (const item of [...held, ...found]) if (!byKey.has(item.key)) byKey.set(item.key, item);
  return [...byKey.values()].filter((item) => now - item.received < INBOX_KEEP_MINUTES);
}

/** Newest first: by arrival, then by seq. */
const newestFirst = (a: InboxItem, b: InboxItem): number =>
  b.received - a.received || b.seq - a.seq;

/**
 * Reads the steward's inbox after the cursor this device keeps, with the
 * steward's box `secret`, keeps what it found, and resolves to every item
 * held, newest first.
 *
 * @throws {Error} when the relay can't be reached or the store refuses.
 */
export async function readStewardInbox(
  services: InboxReadServices,
  secret: Uint8Array,
): Promise<InboxItem[]> {
  const inbox = stewardInboxOf(kxPublicKeyOf(secret));
  const held = await services.keep.getStewardInbox();
  const start: KeptInbox =
    held?.inbox === inbox ? held : { inbox, instance: null, cursor: 0, items: [] };
  let page = await services.relay.getBlobs(inbox, start.cursor);
  if (start.instance !== null && page.instance !== start.instance) {
    page = await services.relay.getBlobs(inbox, 0);
  }
  const found = page.records.map((record) => itemOf(inbox, secret, record));
  const items = merged(
    start.items,
    found.filter((item) => item !== null),
    page.now,
  );
  const cursor = page.records.at(-1)?.seq ?? (page.instance === start.instance ? start.cursor : 0);
  await services.keep.keepStewardInbox({ inbox, instance: page.instance, cursor, items });
  return items.sort(newestFirst);
}
