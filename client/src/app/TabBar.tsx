/**
 * The tab bar (#423; ADR-0077 §7, DESIGN.md "Tab bar"): the app's three
 * fixed places, one tap apart. **Groups** is Start, still the opening
 * screen; **Discover** reads across groups and opens a card or link; **Me**
 * is Personal, with Settings reached from it, so Settings is a page of Me's.
 *
 * It shows only on those four pages. Everywhere else the screen's one primary
 * action is the point, a form or a ballot, or the page stands alone (a
 * shared page, a link's page, first run), so the bar stays out of the way.
 * Nothing on it counts anything: no badges, no numbers (DESIGN.md, Don't).
 *
 * The current place is marked three ways, so it never rests on color: its
 * link carries `aria-current`, its word turns semibold, and a `primary` rule
 * sits on its top edge. On Settings, Me is the place but not the page, so
 * its link says `aria-current="true"` rather than `"page"`.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-aria-components';

import { messages } from './messages';
import { type Route, routeHref } from './router';
import { type TabPlace, tabPlaceOf } from './tabPlace';

/** Two people, side by side: the groups this device is in. */
function GroupsGlyph() {
  return (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19.5c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
      <circle cx="16.5" cy="9.5" r="2.5" />
      <path d="M15.5 14.1c.3 0 .7-.1 1-.1 2.5 0 4.5 2 4.5 5" />
    </>
  );
}

/** A compass: finding what's out there. */
function DiscoverGlyph() {
  return (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5 13.6 13.6 8.5 15.5 10.4 10.4Z" />
    </>
  );
}

/** One person: the person's own page. */
function MeGlyph() {
  return (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" />
    </>
  );
}

/** Each tab, in order: its place, where it goes, its word and its glyph. */
const TABS: readonly {
  readonly place: TabPlace;
  readonly route: Route;
  readonly label: string;
  readonly glyph: ReactNode;
}[] = [
  {
    place: 'groups',
    route: { name: 'start' },
    label: messages.tabs.groups,
    glyph: <GroupsGlyph />,
  },
  {
    place: 'discover',
    route: { name: 'discover' },
    label: messages.tabs.discover,
    glyph: <DiscoverGlyph />,
  },
  { place: 'me', route: { name: 'personal' }, label: messages.tabs.me, glyph: <MeGlyph /> },
];

/** What a tab's link says of the current place: the page, the place alone, or nothing. */
function currentOf(route: Route, tab: (typeof TABS)[number]): 'page' | 'true' | undefined {
  if (tabPlaceOf(route) !== tab.place) return undefined;
  return route.name === tab.route.name ? 'page' : 'true';
}

/** Props for {@link TabBar}. */
export interface TabBarProps {
  /** Where the app is: the bar shows only on a place's own pages. */
  readonly route: Route;
}

/** Groups, Discover and Me, on the four pages that are theirs; nothing anywhere else. */
export function TabBar({ route }: TabBarProps) {
  if (tabPlaceOf(route) === null) return null;
  return (
    <nav className="tab-bar" aria-label={messages.tabs.label}>
      <ul className="tab-bar-list">
        {TABS.map((tab) => {
          const current = currentOf(route, tab);
          return (
            <li key={tab.place}>
              <Link
                className={current === undefined ? 'tab-bar-link' : 'tab-bar-link tab-bar-current'}
                href={routeHref(tab.route)}
                {...(current === undefined ? {} : { 'aria-current': current })}
              >
                <svg
                  className="tab-bar-glyph"
                  viewBox="0 0 24 24"
                  width="24"
                  height="24"
                  aria-hidden="true"
                  focusable="false"
                >
                  {tab.glyph}
                </svg>
                <span className="tab-bar-word">{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
