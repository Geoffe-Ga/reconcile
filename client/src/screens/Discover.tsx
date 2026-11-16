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
 * at the top, where a card or link opens on every screen (#444). Shelf
 * entries come in a later issue (ADR-0077 §1). Nothing here reaches the
 * network: the feed is a view of logs the device holds.
 */
import { Link } from 'react-aria-components';

import { DispatchCard } from '../app/DispatchCard';
import type { FeedItem, FeedPlace } from '../app/discoverFeed';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { PageHeader } from '../app/ui';

/** Props for {@link Discover}. */
export interface DiscoverProps {
  /** Every Dispatch this device holds, newest first, each from where it's shown (#429). */
  readonly feed: readonly FeedItem[];
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

/**
 * The eyebrow and heading, then the feed; or, with none, the empty state's
 * one sentence and where a card or link opens: the link bar (#444).
 */
export function Discover({ feed }: DiscoverProps) {
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
    </main>
  );
}
