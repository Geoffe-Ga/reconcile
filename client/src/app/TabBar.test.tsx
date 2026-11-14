/**
 * The tab bar (#423; ADR-0077 §7, DESIGN.md "Tab bar"): Groups, Discover and
 * Me, one tap apart, on the four places that are the app's own, and nowhere a
 * form, a ballot or a shared page is the point.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../test/axe';
import type { Route } from './router';
import { TabBar } from './TabBar';
import { tabPlaceOf } from './tabPlace';

const GROUP = 'g'.repeat(43);
const PROPOSAL = 'p'.repeat(43);

/** The bar's links, by their words, with where each goes and how it's marked. */
function tabs() {
  const nav = screen.getByRole('navigation', { name: 'Main' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => ({
      name: link.textContent,
      href: link.getAttribute('href'),
      current: link.getAttribute('aria-current'),
    }));
}

describe('tabPlaceOf', () => {
  it.each<[Route, ReturnType<typeof tabPlaceOf>]>([
    [{ name: 'start' }, 'groups'],
    [{ name: 'discover' }, 'discover'],
    [{ name: 'personal' }, 'me'],
    [{ name: 'settings' }, 'me'],
  ])('puts %j in its place', (route, place) => {
    expect(tabPlaceOf(route)).toBe(place);
  });

  it.each<[string, Route]>([
    ['a ballot', { name: 'proposal', groupId: GROUP, proposalId: PROPOSAL }],
    ['the shared page', { name: 'shared', payload: 'x' }],
    ['a personal Document’s editor', { name: 'personalDocument', id: 'A'.repeat(22) }],
    ['Create group', { name: 'create' }],
    ['Join', { name: 'join', payload: null }],
    ['a composer', { name: 'propose', groupId: GROUP, atomId: `${GROUP}.0` }],
    ['Group home', { name: 'group', groupId: GROUP }],
    ['a front door', { name: 'door', payload: 'x' }],
    ['Bring a card', { name: 'card', payload: null }],
  ])('has no place on %s, so no bar shows there', (_name, route) => {
    expect(tabPlaceOf(route)).toBeNull();
    const { container } = render(<TabBar route={route} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TabBar', () => {
  it('links to Groups, Discover and Me, each a glyph and a word, with no count or badge', async () => {
    document.title = 'Your groups · Reconcile';
    render(<TabBar route={{ name: 'start' }} />);

    expect(tabs()).toEqual([
      { name: 'Groups', href: '#/', current: 'page' },
      { name: 'Discover', href: '#/discover', current: null },
      { name: 'Me', href: '#/me', current: null },
    ]);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const link of within(nav).getAllByRole('link')) {
      const glyph = link.querySelector('svg');
      expect(glyph).not.toBeNull();
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(await axeViolations()).toEqual([]);
  });

  it('marks the current place by more than color: aria-current and its own mark', () => {
    render(<TabBar route={{ name: 'discover' }} />);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const current = within(nav).getByRole('link', { current: 'page' });
    expect(current).toHaveTextContent('Discover');
    expect(current).toHaveClass('tab-bar-current');
    for (const other of within(nav).getAllByRole('link')) {
      if (other !== current) expect(other).not.toHaveClass('tab-bar-current');
    }
  });

  it('keeps its own class names, apart from the Write and Preview tabs in MarkdownField', () => {
    render(<TabBar route={{ name: 'start' }} />);

    // Write and Preview style `.tab-list` and `.tab`; sharing them would restyle both.
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('list')).not.toHaveClass('tab-list');
    for (const link of within(nav).getAllByRole('link')) expect(link).not.toHaveClass('tab');
  });

  it('marks Me on Personal as the page, and on Settings as the place without claiming the page', () => {
    const { unmount } = render(<TabBar route={{ name: 'personal' }} />);
    expect(tabs().map((tab) => tab.current)).toEqual([null, null, 'page']);
    unmount();

    render(<TabBar route={{ name: 'settings' }} />);
    expect(tabs().map((tab) => tab.current)).toEqual([null, null, 'true']);
    expect(screen.getByRole('link', { name: 'Me' })).toHaveClass('tab-bar-current');
  });
});
