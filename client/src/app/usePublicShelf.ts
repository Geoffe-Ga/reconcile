/**
 * The public shelf as a screen reads it (#484, #487, #431): Discover's
 * section, a shelf entry's page, the listing composer's warning and Group
 * home's word about a stray entry, each through the shelf's reader, which
 * asks the relay at most once an hour (`shelf/read.ts`).
 */
import { useEffect, useMemo, useState } from 'react';

import { foldShelf, type ShelfState } from '../shelf/fold';
import type { ShelfRead, ShelfReader } from '../shelf/read';

/**
 * The shelf's last read once `reader` answers; undefined until then, and
 * null without a reader, while the relay has none, and when it can't be
 * read, so a shelf that isn't there never shows an error.
 */
export function useShelfRead(reader: ShelfReader | undefined): ShelfRead | null | undefined {
  const [answered, setAnswered] = useState<{
    readonly reader: ShelfReader;
    readonly read: ShelfRead | null;
  } | null>(null);
  useEffect(() => {
    if (reader === undefined) return;
    let live = true;
    reader.current().then(
      (read) => {
        if (live) setAnswered({ reader, read });
      },
      () => {
        if (live) setAnswered({ reader, read: null });
      },
    );
    return () => {
      live = false;
    };
  }, [reader]);
  if (reader === undefined) return null;
  return answered?.reader === reader ? answered.read : undefined;
}

/** No addresses: a device whose groups list no door. */
const NONE: readonly string[] = [];

/**
 * The shelf as folded (`foldShelf`), with the entries of `own`, the listed
 * doors of this device's groups, shown at once (#431); undefined until the
 * reader answers, and null as {@link useShelfRead} says.
 */
export function useShelfState(
  reader: ShelfReader | undefined,
  own: readonly string[] = NONE,
): ShelfState | null | undefined {
  const read = useShelfRead(reader);
  const key = [...own].sort().join(' ');
  return useMemo(() => {
    if (read === undefined || read === null) return read;
    const addresses = new Set(key === '' ? [] : key.split(' '));
    return foldShelf(read.records, read.now, { own: addresses, since: read.since });
  }, [read, key]);
}

/** The shelf as folded once it answers, or null before then and while there is none. */
export function usePublicShelf(
  reader: ShelfReader | undefined,
  own: readonly string[] = NONE,
): ShelfState | null {
  return useShelfState(reader, own) ?? null;
}
