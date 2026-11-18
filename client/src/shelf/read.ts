/**
 * Reading the public shelf (#484, #431; ADR-0081; docs/spec/listed-doors.md
 * §5.2): what Discover, the listing composer and Group home fold.
 *
 * A read takes the whole shelf from the start, 100 records a page
 * (`net/shelf.ts`), so every device asks for exactly the same thing and a
 * read says nothing about its reader (ADR-0077 §4). No cursor is kept
 * between reads: a listing's later copy takes its first copy's place and seq
 * on the relay (#486), and a final one deletes its entries, so only a whole
 * read sees the shelf as it stands.
 *
 * A fresh read is made at most once each {@link SHELF_READ_MS} (proposed in
 * §5.2), across reloads too: the device keeps the last read (its records,
 * the relay's minute and instance, and the device time it was made) in its
 * own store, so opening Discover again inside the hour shows it without
 * asking the relay, and how often a person looks isn't told to it. The copy
 * also keeps, per address, the earliest relay minute of any record this
 * device read there, since the relay renews a listing in place and keeps no
 * first time: Discover shows it as "Listed since". It is the public shelf,
 * the same for every device, and records nothing about which entries anyone
 * looked at. A new relay instance starts those minutes over, and an address
 * gone from the shelf drops out of them.
 *
 * A read that fails is kept for no one, and the next look asks again. While
 * the relay has no shelf (no steward key), the read is null and the device
 * drops its copy, so nothing of a shelf shows. A device whose store refuses
 * the copy still reads, an hour at a time while the app stays open.
 */
import type { Shelf, ShelfRecord } from '../net/shelf';

/** How long one read of the shelf serves: an hour, in device milliseconds. */
export const SHELF_READ_MS = 60 * 60 * 1000;

/** The device's copy of its last read of the shelf. */
export interface KeptShelf {
  /** The relay database it was read from. */
  readonly instance: string;
  /** The relay minute of the read. */
  readonly now: number;
  readonly records: readonly ShelfRecord[];
  /** The device time of the read, in milliseconds. */
  readonly readAt: number;
  /** The earliest relay minute this device read a record at each address, from this instance. */
  readonly since: Readonly<Record<string, number>>;
}

/** Where the device keeps its copy: one record of its own store (`store/db.ts`). */
export interface ShelfKeep {
  getShelfCopy(): Promise<KeptShelf | undefined>;
  /** Keeps `copy` in place of any earlier one; null drops it. */
  keepShelfCopy(copy: KeptShelf | null): Promise<void>;
}

/** One read of the shelf, as the fold takes it. */
export interface ShelfRead {
  readonly records: readonly ShelfRecord[];
  /** The relay minute of the read. */
  readonly now: number;
  /** The earliest relay minute this device read a record at each address: "Listed since". */
  readonly since: ReadonlyMap<string, number>;
}

/** The shelf the screens fold. */
export interface ShelfReader {
  /** The last read, at most an hour old, or null while the relay has none; rejects when it can't be read. */
  current(): Promise<ShelfRead | null>;
}

/** What the reader needs: the shelf client, the device's keep and its clock in milliseconds. */
export interface ShelfReaderOptions {
  readonly shelf: Pick<Shelf, 'read'>;
  readonly keep: ShelfKeep;
  readonly now: () => number;
}

/** `copy` as a read. */
const readOf = ({ records, now, since }: KeptShelf): ShelfRead => ({
  records,
  now,
  since: new Map(Object.entries(since)),
});

/** Whether `copy` was read in the hour before device time `at`. */
const fresh = (copy: KeptShelf, at: number): boolean =>
  at >= copy.readAt && at - copy.readAt < SHELF_READ_MS;

/**
 * The earliest minute of each address in `records`, kept from `earlier` for
 * an address still on the shelf when it is earlier still.
 */
function sinceOf(
  records: readonly ShelfRecord[],
  earlier: Readonly<Record<string, number>>,
): Record<string, number> {
  const since: Record<string, number> = {};
  for (const { address, received } of records) {
    const first = Math.min(since[address] ?? Infinity, earlier[address] ?? Infinity, received);
    since[address] = first;
  }
  return since;
}

/** A reader over `shelf`, keeping its copy in `keep`. */
export function createShelfReader({ shelf, keep, now }: ShelfReaderOptions): ShelfReader {
  let last: { readonly at: number; readonly read: Promise<ShelfRead | null> } | null = null;

  /** The kept copy, or none when the store can't give it. */
  const kept = (): Promise<KeptShelf | undefined> => keep.getShelfCopy().catch(() => undefined);

  /** Keeps `copy`, or drops the device's for null; a store that refuses it changes nothing. */
  const store = (copy: KeptShelf | null): Promise<void> =>
    keep.keepShelfCopy(copy).catch(() => undefined);

  async function fetchRead(at: number): Promise<ShelfRead | null> {
    const before = await kept();
    if (before !== undefined && fresh(before, at)) return readOf(before);
    const page = await shelf.read();
    if (page === null) {
      if (before !== undefined) await store(null);
      return null;
    }
    const earlier = before?.instance === page.instance ? before.since : {};
    const copy: KeptShelf = {
      instance: page.instance,
      now: page.now,
      records: page.records,
      readAt: at,
      since: sinceOf(page.records, earlier),
    };
    await store(copy);
    return readOf(copy);
  }

  function current(): Promise<ShelfRead | null> {
    const at = now();
    if (last !== null && at >= last.at && at - last.at < SHELF_READ_MS) return last.read;
    const read = fetchRead(at);
    const held = { at, read };
    last = held;
    read.catch(() => {
      if (last === held) last = null;
    });
    return read;
  }

  return { current };
}
