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
 * each under its listing's name. `DiscoverScreen` reads the shelf; this
 * screen only shows it. The section shows only while the shelf holds an
 * entry, so on a relay without the steward's key nothing of it appears.
 */
import { useId } from 'react';
import { Link } from 'react-aria-components';

import { DispatchCard } from '../app/DispatchCard';
import type { FeedItem, FeedPlace } from '../app/discoverFeed';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { PageHeader } from '../app/ui';
import type { ShelfEntry, ShelfState } from '../shelf/fold';

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

/** One shelf entry: its listing's name, then its title and text, as a Dispatch card's. */
function ShelfCard({ entry }: { readonly entry: ShelfEntry }) {
  const heading = useId();
  return (
    <article className="card dispatch" aria-labelledby={heading}>
      <p className="eyebrow dispatch-from">
        <bdi>{entry.name}</bdi>
      </p>
      <h3 id={heading} className="heading-3 dispatch-title">
        <bdi>{entry.title}</bdi>
      </h3>
      {entry.text === '' ? null : (
        <p className="dispatch-text" dir="auto">
          {entry.text}
        </p>
      )}
    </article>
  );
}

/** "On the public shelf": its heading and one line, then each entry, newest first (#484). */
function Shelf({ entries }: { readonly entries: readonly ShelfEntry[] }) {
  const words = messages.discover;
  const heading = useId();
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow section-heading">
        {words.shelfHeading}
      </h2>
      <p>{words.shelfLede}</p>
      <ul className="dispatch-list" aria-labelledby={heading}>
        {entries.map((entry) => (
          <li key={`${entry.address} ${entry.id}`}>
            <ShelfCard entry={entry} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The eyebrow and heading, then the feed; or, with none, the empty state's
 * one sentence and where a card or link opens: the link bar (#444). Then the
 * public shelf, while it holds an entry (#484).
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
      {shelf === null || shelf.entries.length === 0 ? null : <Shelf entries={shelf.entries} />}
    </main>
  );
}
