/**
 * Group home's word about a steward's hold or removal (#489, #490;
 * listed-doors.md §6.1, §6.3): while a hold on the group's listed door, or
 * on one of its entries, stands, the group's own members see "Held: {clause
 * in words}", what it holds (the listing, or an entry by its Dispatch's
 * title) and the day it shows again unless the steward removes it. Once the
 * steward suspends the listing, they see "Removed: {clause in words}" in
 * their place. It reads the shelf as Discover does, at most once an hour,
 * and only while the group lists its door. Group home shows only to
 * members, and a hold or removal names only a clause, never who reported
 * it. Nothing shows for a group that isn't listed, once the hold lapses, or
 * on a relay with no shelf.
 *
 * Beside each, a member who may propose sees "Ask the steward to look again"
 * (#490), where there's a steward to send it to: an appeal about the held
 * entry, or about the whole listing, signed with the door's key, so it
 * names the group's door and not the member.
 */
import { useMemo } from 'react';

import { can } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { CLAUSE_WORDS } from '../shelf/covenant';
import { doorListing, foldShelf, type ShelfHold } from '../shelf/fold';
import { listedAddress } from '../shelf/keeper';
import type { ShelfReader } from '../shelf/read';
import type { Clause } from '../shelf/record';
import { messages } from './messages';
import { AppealDialog, type SendOutcome } from './StewardDialogs';
import { formatDate } from './time';
import { useShelfRead } from './usePublicShelf';

/** Sends an appeal about entry `id`, or the whole listing for null, with `note`. */
export type OnAppeal = (id: string | null, note: string) => Promise<SendOutcome>;

/** Props for {@link ShelfHolds}. */
export interface ShelfHoldsProps {
  readonly state: GroupState;
  readonly shelf?: ShelfReader | undefined;
  /** This device's member in the group: an appeal is theirs to send only while they may propose. */
  readonly me?: string | undefined;
  /** Sends an appeal (#490); without one, there's no steward to send it to. */
  readonly onAppeal?: OnAppeal | undefined;
}

/** What may appeal: the send, only for a member who may propose. */
interface AppealProps {
  readonly onAppeal?: OnAppeal | undefined;
}

/** The appeal for entry `id`, or the listing, when `onAppeal` is there to send it. */
function Appeal({ id, onAppeal }: AppealProps & { readonly id: string | null }) {
  if (onAppeal === undefined) return null;
  return <AppealDialog onAppeal={(note) => onAppeal(id, note)} />;
}

/** What one hold holds: the listing, or an entry by its Dispatch's title. */
function Held({
  hold,
  state,
  onAppeal,
}: AppealProps & { readonly hold: ShelfHold; readonly state: GroupState }) {
  const words = messages.shelfEntry;
  const title = state.dispatches.find((dispatch) => dispatch.id === hold.id)?.title;
  return (
    <li>
      <p>
        <strong>{words.held(CLAUSE_WORDS[hold.clause])}</strong>
      </p>
      <p>{hold.id === null || title === undefined ? words.heldListing : <bdi>{title}</bdi>}</p>
      <p className="meta">{words.heldUntil(formatDate(hold.until))}</p>
      <Appeal id={hold.id} onAppeal={onAppeal} />
    </li>
  );
}

/** The removed listing's card: its clause in words, and the appeal. */
function Removed({ clause, onAppeal }: AppealProps & { readonly clause: Clause }) {
  const words = messages.shelfEntry;
  return (
    <section className="card backup-slot" aria-label={words.removedHeading}>
      <h2 className="eyebrow">{words.removedHeading}</h2>
      <p>
        <strong>{words.removed(CLAUSE_WORDS[clause])}</strong>
      </p>
      <p>{words.removedListing}</p>
      <Appeal id={null} onAppeal={onAppeal} />
    </section>
  );
}

/** What the shelf says of the door at `address`: its standing holds, and its removal's clause. */
function useDoorStanding(address: string | null, shelf: ShelfReader | undefined) {
  const read = useShelfRead(address === null ? undefined : shelf);
  return useMemo(() => {
    if (read === undefined || read === null || address === null) return null;
    const removed = doorListing(read.records, address, read.now)?.removed ?? null;
    const holds = foldShelf(read.records, read.now).holds.filter(
      (hold) => hold.address === address,
    );
    return { removed, holds };
  }, [read, address]);
}

/**
 * Each standing hold on the group's listed door as a quiet card, or the
 * removed listing's card; nothing when there are none. Each offers an
 * appeal to a member who may propose.
 */
export function ShelfHolds({ state, shelf, me, onAppeal }: ShelfHoldsProps) {
  const standing = useDoorStanding(listedAddress(state), shelf);
  const mayAppeal = me !== undefined && can(state, me, 'propose');
  const appeal = mayAppeal ? onAppeal : undefined;
  if (standing === null) return null;
  if (standing.removed !== null) return <Removed clause={standing.removed} onAppeal={appeal} />;
  if (standing.holds.length === 0) return null;
  const words = messages.shelfEntry;
  return (
    <section className="card backup-slot" aria-label={words.heldHeading}>
      <h2 className="eyebrow">{words.heldHeading}</h2>
      <ul>
        {standing.holds.map((hold) => (
          <Held
            key={`${hold.address} ${hold.id ?? ''}`}
            hold={hold}
            state={state}
            onAppeal={appeal}
          />
        ))}
      </ul>
    </section>
  );
}
