/**
 * Start's and Discover's word that a door this device sent to was removed
 * from the public shelf (#491; ADR-0081; listed-doors.md §6.5).
 *
 * Once this device holds an application or card it sent, it reads the shelf
 * as Discover does, at most once an hour (`shelf/read.ts`), folds it, and matches the fold's tombstones against the
 * applications and reconcile cards this device sent, by door address
 * (`shelf/affected.ts`). Each match shows one line: "A group you asked to
 * join on {date} was removed from the shelf: {clause in words}.", or, for a
 * card, "A group you proposed reconciling with…", and "A Dispatch from a
 * group…" when the steward upheld a report on one of its entries rather
 * than suspending its listing. Dismiss keeps the line's tombstone in the
 * device's own store, so it stays dismissed across reloads and never shows
 * twice for one tombstone.
 *
 * The match makes no request and sends nothing: the tombstone is public, the
 * same for every device, and the comparison happens here. No record is kept
 * of which entries the reader looked at. Nothing shows while the steward's
 * pause stands, as no tombstone does then, nor on a relay with no shelf.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from 'react-aria-components';

import { type Affected, affectedBy, type Removals, removalLines } from '../shelf/affected';
import { CLAUSE_WORDS } from '../shelf/covenant';
import type { ShelfReader } from '../shelf/read';
import { SENT_CHANGED } from '../store/applications';
import { REMOVALS_CHANGED, type Store } from '../store/db';
import { messages } from './messages';
import { formatDay } from './time';
import { useShelfState } from './usePublicShelf';

/** What the lines read and write in the device's store. */
export type RemovalsStore = Pick<Store, 'removalsAt' | 'dismissRemoval' | 'subscribe'>;

/** Props for {@link ShelfRemovals}. */
export interface ShelfRemovalsProps {
  readonly store: RemovalsStore;
  /** The public shelf; without one, nothing shows. */
  readonly shelf?: ShelfReader | undefined;
  /** The device clock in milliseconds: when a line was dismissed, and what is old enough to forget. */
  readonly now: () => number;
}

/**
 * What the device holds for these lines, kept current as applications,
 * cards and dismissals change; null until the store answers.
 */
function useRemovals(store: RemovalsStore, now: () => number): Removals | null {
  const [removals, setRemovals] = useState<{
    readonly store: RemovalsStore;
    readonly held: Removals;
  } | null>(null);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (): void => {
      latest += 1;
      const ticket = latest;
      store.removalsAt(now()).then(
        (held) => {
          // Only the newest read counts: an older one may answer last.
          if (live && ticket === latest) setRemovals({ store, held });
        },
        // A failed read keeps the last lines shown; the next change reads again.
        () => undefined,
      );
    };
    load();
    const unsubscribe = store.subscribe((changed) => {
      if (changed === SENT_CHANGED || changed === REMOVALS_CHANGED) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [store, now]);
  return removals?.store === store ? removals.held : null;
}

/** One line's words: what was sent, and whether a listing or one of its Dispatches came down. */
function lineOf({ kind, entry, sentAt, clause }: Affected): string {
  const words = messages.removals;
  const date = formatDay(sentAt);
  const why = CLAUSE_WORDS[clause];
  if (kind === 'application') {
    return entry === null ? words.asked(date, why) : words.askedEntry(date, why);
  }
  return entry === null ? words.proposed(date, why) : words.proposedEntry(date, why);
}

/** One line and its Dismiss, which names the line it hides. */
function Line({ line, onDismiss }: { readonly line: Affected; readonly onDismiss: () => void }) {
  const id = useId();
  return (
    <li>
      <p id={id}>{lineOf(line)}</p>
      <div>
        <Button className="button button-secondary" aria-describedby={id} onPress={onDismiss}>
          {messages.removals.dismiss}
        </Button>
      </div>
    </li>
  );
}

/** The lines this device's reader hasn't dismissed, as a quiet card; nothing when there are none. */
export function ShelfRemovals({ store, shelf, now }: ShelfRemovalsProps) {
  const removals = useRemovals(store, now);
  // A device that sent nothing has no door to hear about, so it reads no shelf: a fresh
  // Start calls no one (#491). Discover reads the shelf anyway, for its own entries.
  const sentSomething = removals !== null && removals.sent.length > 0;
  const state = useShelfState(sentSomething ? shelf : undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const lines = useMemo(() => {
    if (state === undefined || state === null || state.paused || removals === null) return [];
    const dismissed = new Set([...removals.dismissed, ...hidden]);
    return removalLines(affectedBy(state.tombstones, removals.sent), dismissed);
  }, [state, removals, hidden]);
  const dismiss = useCallback(
    (line: Affected) => {
      setHidden((held) => new Set([...held, line.key]));
      // Hidden at once; a store that refuses it shows the line again only after a reload.
      store.dismissRemoval({ key: line.key, door: line.door, at: now() }).catch(() => undefined);
    },
    [store, now],
  );
  if (lines.length === 0) return null;
  const words = messages.removals;
  return (
    <section className="card backup-slot" aria-label={words.heading}>
      <h2 className="eyebrow">{words.heading}</h2>
      <ul>
        {lines.map((line) => (
          <Line
            key={line.key}
            line={line}
            onDismiss={() => {
              dismiss(line);
            }}
          />
        ))}
      </ul>
    </section>
  );
}
