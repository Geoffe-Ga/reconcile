/**
 * Group home's word about a stray entry (#431; listed-doors.md §4.5): an
 * entry posted under the group's listed door that the group's log never
 * published, which a member's device withdrew (`shelf/keeper.ts`). It reads
 * the shelf as Discover does, at most once an hour, and only while the group
 * lists its door, and shows the stray's title with one line on what
 * happened. Nothing shows for a group that isn't listed, or on a relay with
 * no shelf.
 */
import type { GroupState } from '../engine/fold';
import { publishedBy } from '../engine/dispatches';
import { listedAddress, straysOf } from '../shelf/keeper';
import type { ShelfReader } from '../shelf/read';
import { messages } from './messages';
import { usePublicShelf } from './usePublicShelf';

/** Props for {@link ShelfStrays}. */
export interface ShelfStraysProps {
  readonly state: GroupState;
  readonly shelf?: ShelfReader | undefined;
}

/** The stray entries a member's device took down, as a quiet card; nothing when there are none. */
export function ShelfStrays({ state, shelf }: ShelfStraysProps) {
  const address = listedAddress(state);
  const read = usePublicShelf(address === null ? undefined : shelf);
  if (address === null || read === null) return null;
  const strays = straysOf(read.withdrawn, address, publishedBy(state));
  if (strays.length === 0) return null;
  const words = messages.shelfEntry;
  return (
    <section className="card backup-slot" aria-label={words.strayHeading}>
      <h2 className="eyebrow">{words.strayHeading}</h2>
      <ul>
        {strays.map((stray) => (
          <li key={stray.id}>
            <bdi>{stray.title}</bdi>
          </li>
        ))}
      </ul>
      <p>{words.stray}</p>
    </section>
  );
}
