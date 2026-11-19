/**
 * Group home's word about a steward's hold (#489; listed-doors.md §6.1):
 * while a hold on the group's listed door, or on one of its entries, stands,
 * the group's own members see "Held: {clause in words}", what it holds (the
 * listing, or an entry by its Dispatch's title) and the day it shows again
 * unless the steward removes it. It reads the shelf as Discover does, at
 * most once an hour, and only while the group lists its door. Group home
 * shows only to members, and the hold names only a clause, never who
 * reported it. Nothing shows for a group that isn't listed, once the hold
 * lapses, or on a relay with no shelf.
 */
import type { GroupState } from '../engine/fold';
import { CLAUSE_WORDS } from '../shelf/covenant';
import type { ShelfHold } from '../shelf/fold';
import { listedAddress } from '../shelf/keeper';
import type { ShelfReader } from '../shelf/read';
import { messages } from './messages';
import { formatDate } from './time';
import { usePublicShelf } from './usePublicShelf';

/** Props for {@link ShelfHolds}. */
export interface ShelfHoldsProps {
  readonly state: GroupState;
  readonly shelf?: ShelfReader | undefined;
}

/** What one hold holds: the listing, or an entry by its Dispatch's title. */
function Held({ hold, state }: { readonly hold: ShelfHold; readonly state: GroupState }) {
  const words = messages.shelfEntry;
  const title = state.dispatches.find((dispatch) => dispatch.id === hold.id)?.title;
  return (
    <li>
      <p>
        <strong>{words.held(CLAUSE_WORDS[hold.clause])}</strong>
      </p>
      <p>{hold.id === null || title === undefined ? words.heldListing : <bdi>{title}</bdi>}</p>
      <p className="meta">{words.heldUntil(formatDate(hold.until))}</p>
    </li>
  );
}

/** Each standing hold on the group's listed door, as a quiet card; nothing when there are none. */
export function ShelfHolds({ state, shelf }: ShelfHoldsProps) {
  const address = listedAddress(state);
  const read = usePublicShelf(address === null ? undefined : shelf);
  const holds = read?.holds.filter((hold) => hold.address === address) ?? [];
  if (holds.length === 0) return null;
  const words = messages.shelfEntry;
  return (
    <section className="card backup-slot" aria-label={words.heldHeading}>
      <h2 className="eyebrow">{words.heldHeading}</h2>
      <ul>
        {holds.map((hold) => (
          <Held key={`${hold.address} ${hold.id ?? ''}`} hold={hold} state={state} />
        ))}
      </ul>
    </section>
  );
}
