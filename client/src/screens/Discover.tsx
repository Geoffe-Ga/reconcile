/**
 * Discover (`#/discover`; #423, ADR-0077 §6–§7, DESIGN.md "Discover"): one of
 * the tab bar's three places.
 *
 * Its feed (#429) lists every Dispatch this device already holds, newest
 * first (`discoverFeed`): from each group the person is in, each coalition
 * they're in or follow, and the Dispatches that rose from a member group,
 * each once. Each is a Dispatch card under an eyebrow naming the group or
 * coalition it's shown from, which links to that place's home; a dissolved
 * group's adds "Ended". No count, badge or reaction. With none, the empty
 * state's one sentence shows instead, and one line pointing to the link bar
 * at the top, where a card or link opens on every screen (#444). Nothing
 * here reaches the network: the feed is a view of logs the device holds.
 *
 * Below it, "On the public shelf" (#484; ADR-0081; listed-doors.md §5.2)
 * lists the entries the shelf's fold shows (`shelf/fold.ts`), newest first,
 * each under its listing's name (`ShelfCard`), with "Listed since" and, on a
 * device in the entry's own group before its relay day has passed, "Shows
 * publicly tomorrow", and a link to the entry's own page, whose Share and
 * Copy pass its link along (#431). `DiscoverScreen` reads the shelf; this
 * screen only shows it. A tombstone (#489) takes the place of what the
 * steward removed, "Removed: {clause in words}", naming neither the group
 * nor anyone who reported it, and while the steward's pause stands the
 * section shows one line and nothing else. The section shows only while the
 * shelf holds an entry or a tombstone, or is paused, so on a relay without
 * the steward's key nothing of it appears.
 */
import { useId } from 'react';
import { Link } from 'react-aria-components';

import { DispatchCard } from '../app/DispatchCard';
import type { FeedItem, FeedPlace } from '../app/discoverFeed';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { ShelfCard } from '../app/ShelfCard';
import { PageHeader } from '../app/ui';
import { CLAUSE_WORDS } from '../shelf/covenant';
import type { ShelfEntry, ShelfState, ShelfTombstone } from '../shelf/fold';

/** Props for {@link Discover}. */
export interface DiscoverProps {
  /** Every Dispatch this device holds, newest first, each from where it's shown (#429). */
  readonly feed: readonly FeedItem[];
  /** The public shelf as folded, or null while there is none to show (#484). */
  readonly shelf?: ShelfState | null;
}

/** The home of the group or coalition a Dispatch is shown from. */
function homeOf({ kind, id }: FeedPlace): string {
  return routeHref(
    kind === 'group' ? { name: 'group', groupId: id } : { name: 'coalition', coalitionId: id },
  );
}

/** The eyebrow over a Dispatch: where it's shown from, linking home, and "Ended" for a dissolved group. */
function From({ from }: { readonly from: FeedPlace }) {
  const words = messages.discover;
  return (
    <>
      <Link href={homeOf(from)}>
        <bdi>{from.state.name}</bdi>
      </Link>
      {from.ended ? ` ${words.endedSeparator} ${words.ended}` : null}
    </>
  );
}

/** The feed: one Dispatch card each, newest first. */
function Feed({ feed }: { readonly feed: readonly FeedItem[] }) {
  return (
    <ul className="dispatch-list discover-feed" aria-label={messages.discover.feedLabel}>
      {feed.map(({ dispatch, from }) => (
        <li key={dispatch.id}>
          <DispatchCard
            state={from.state}
            dispatch={dispatch}
            level={2}
            place={from.kind}
            eyebrow={<From from={from} />}
          />
        </li>
      ))}
    </ul>
  );
}

/** A tombstone (#489): "Removed: {clause in words}", and what came down, an entry or a listing. */
function Tombstone({ tombstone }: { readonly tombstone: ShelfTombstone }) {
  const words = messages.discover;
  const heading = useId();
  return (
    <article className="card dispatch tombstone" aria-labelledby={heading}>
      <h3 id={heading} className="heading-3 dispatch-title">
        {words.removed(CLAUSE_WORDS[tombstone.clause])}
      </h3>
      <p className="meta">{tombstone.id === null ? words.removedListing : words.removedEntry}</p>
    </article>
  );
}

/** One place in the shelf's list: an entry, or the tombstone in place of what came down. */
type Shelved =
  | { readonly key: string; readonly seq: number; readonly entry: ShelfEntry }
  | { readonly key: string; readonly seq: number; readonly tombstone: ShelfTombstone };

/** The entries and tombstones in one list, newest first, each in its place in the shelf's order. */
function shelvedOf({ entries, tombstones }: ShelfState): Shelved[] {
  const shelved: Shelved[] = [
    ...entries.map((entry) => ({ key: `${entry.address} ${entry.id}`, seq: entry.seq, entry })),
    ...tombstones.map((tombstone) => ({
      key: `removed ${tombstone.address} ${tombstone.id ?? ''}`,
      seq: tombstone.seq,
      tombstone,
    })),
  ];
  return shelved.sort((a, b) => b.seq - a.seq);
}

/** One entry's card, with the link to its own page. */
function EntryItem({ entry }: { readonly entry: ShelfEntry }) {
  return (
    <ShelfCard entry={entry} level={3}>
      <Link href={routeHref({ name: 'shelfEntry', address: entry.address, id: entry.id })}>
        {messages.discover.passAlong}
      </Link>
    </ShelfCard>
  );
}

/**
 * "On the public shelf": its heading and one line, then each entry and
 * tombstone, newest first (#484, #489); or, while paused, one line alone.
 */
function Shelf({ shelf }: { readonly shelf: ShelfState }) {
  const words = messages.discover;
  const heading = useId();
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow section-heading">
        {words.shelfHeading}
      </h2>
      {shelf.paused ? (
        <p>{words.paused}</p>
      ) : (
        // One body beside the heading: `.section` lays out two columns.
        <div className="stack">
          <p>{words.shelfLede}</p>
          <ul className="dispatch-list" aria-labelledby={heading}>
            {shelvedOf(shelf).map((item) => (
              <li key={item.key}>
                {'entry' in item ? (
                  <EntryItem entry={item.entry} />
                ) : (
                  <Tombstone tombstone={item.tombstone} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Whether the shelf has anything to show: an entry, a tombstone, or its pause. */
const showsShelf = (shelf: ShelfState | null): shelf is ShelfState =>
  shelf !== null && (shelf.paused || shelf.entries.length > 0 || shelf.tombstones.length > 0);

/**
 * The eyebrow and heading, then the feed; or, with none, the empty state's
 * one sentence and where a card or link opens: the link bar (#444). Then the
 * public shelf, while it holds an entry or a tombstone, or is paused (#484, #489).
 */
export function Discover({ feed, shelf = null }: DiscoverProps) {
  const words = messages.discover;
  return (
    <main className="shell" data-scene="treetops">
      <PageHeader eyebrow={messages.app.name} title={words.title} pageTitle={words.pageTitle} />
      {feed.length === 0 ? (
        <>
          <p className="lede">{words.empty}</p>
          <p>{words.pasteInBar}</p>
        </>
      ) : (
        <Feed feed={feed} />
      )}
      {showsShelf(shelf) ? <Shelf shelf={shelf} /> : null}
    </main>
  );
}
