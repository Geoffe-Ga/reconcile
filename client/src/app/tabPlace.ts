/**
 * Which of the tab bar's three places a page belongs to (#423; ADR-0077 §7):
 * Start is Groups', Discover its own, and Personal and Settings are Me's.
 * Every other page has none, so the bar stays off it (`TabBar.tsx`).
 */
import type { Route } from './router';

/** One of the three places. */
export type TabPlace = 'groups' | 'discover' | 'me';

/** The place `route` belongs to, or null on every page that shows no bar. */
export function tabPlaceOf(route: Route): TabPlace | null {
  switch (route.name) {
    case 'start':
      return 'groups';
    case 'discover':
      return 'discover';
    case 'personal':
    case 'settings':
      return 'me';
    default:
      return null;
  }
}
