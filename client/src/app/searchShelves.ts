/**
 * Search results by eyebrow (#445): which kind of result goes under which,
 * their order, and how many show before "Show all". Pure, for the listbox
 * (`SearchResults`) and the link bar's actions.
 */
import type { Key } from 'react-aria-components';

import type { messages } from './messages';
import type { ResultKind, SearchResult } from './search';

/** A kind of result's eyebrow. */
export type Shelf = keyof typeof messages.search.shelves;

/** The eyebrows, in the order they show. */
const ORDER: readonly Shelf[] = [
  'groups',
  'documents',
  'proposals',
  'dispatches',
  'yours',
  'places',
];

/** Which eyebrow each kind of result goes under. */
const SHELF: Readonly<Record<ResultKind, Shelf>> = {
  group: 'groups',
  coalition: 'groups',
  document: 'documents',
  section: 'documents',
  proposal: 'proposals',
  dispatch: 'dispatches',
  personal: 'yours',
  place: 'places',
};

/** How many of a kind show before "Show all". */
const SHOWN = 5;

/** The key of the row that shows the rest of `shelf`. */
export const MORE = 'more:';

/** The shelf `key` shows the rest of, when it's a "Show all" row's; else null. */
export function moreOf(key: Key): Shelf | null {
  const text = String(key);
  return text.startsWith(MORE) ? (text.slice(MORE.length) as Shelf) : null;
}

/** `results` by eyebrow, in order, each cut to {@link SHOWN} unless `expanded` holds it. */
export function shelvesOf(results: readonly SearchResult[], expanded: ReadonlySet<Shelf>) {
  return ORDER.flatMap((shelf) => {
    const all = results.filter((result) => SHELF[result.record.kind] === shelf);
    if (all.length === 0) return [];
    const rows = expanded.has(shelf) ? all : all.slice(0, SHOWN);
    return [{ shelf, rows, total: all.length }];
  });
}
