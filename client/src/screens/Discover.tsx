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
 * state's one sentence shows instead.
 *
 * Then "Open a card or link", the field Start shares (`OpenLink`), which
 * reads an invite, a reconcile card, a follow link or a front door link and
 * opens each exactly as Start does. Shelf entries come in a later issue
 * (ADR-0077 §1). Nothing here reaches the network until a link opens its own
 * page: the feed is a view of logs the device holds.
 */
import { Link } from 'react-aria-components';

import { DispatchCard } from '../app/DispatchCard';
import type { FeedItem, FeedPlace } from '../app/discoverFeed';
import { messages } from '../app/messages';
import { OpenLink, type OpenLinkWords } from '../app/OpenLink';
import { routeHref } from '../app/router';
import { PageHeader } from '../app/ui';

/** Discover's field: every kind of link the app opens. */
const OPEN_WORDS: OpenLinkWords = {
  heading: messages.discover.openHeading,
  label: messages.discover.openLabel,
  hint: messages.discover.openHint,
  button: messages.discover.open,
  badLink: messages.discover.badLink,
};

/** Props for {@link Discover}: the feed, and what opens each kind of link, as Start's field has. */
export interface DiscoverProps {
  /** Every Dispatch this device holds, newest first, each from where it's shown (#429). */
  readonly feed: readonly FeedItem[];
  /** Opens a pasted invite's seed, held in memory. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** Opens a pasted reconcile card's seed (#114), held in memory. */
  readonly onOpenCard: (seed: Uint8Array) => void;
  /** Opens a pasted follow link's seed (#124), held in memory. */
  readonly onOpenFollow: (seed: Uint8Array) => void;
  /** Opens a pasted front door link's page (#121), by the address after `#door/`. */
  readonly onOpenDoor: (payload: string) => void;
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
      {from.ended ? `${words.endedSeparator}${words.ended}` : null}
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

/** The eyebrow and heading, the feed or the empty state's one sentence, and Open a card or link. */
export function Discover({ feed, ...open }: DiscoverProps) {
  const words = messages.discover;
  return (
    <main className="shell">
      <PageHeader eyebrow={messages.app.name} title={words.title} pageTitle={words.pageTitle} />
      {feed.length === 0 ? <p className="lede">{words.empty}</p> : <Feed feed={feed} />}
      <OpenLink words={OPEN_WORDS} name="link" primary {...open} />
    </main>
  );
}
