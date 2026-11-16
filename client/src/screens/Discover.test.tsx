/**
 * Discover (#423; ADR-0077 §6, DESIGN.md "Discover"): the eyebrow and
 * heading, the empty state's one sentence, and one line pointing to the
 * link bar, where a card or link opens (#444). It has no field of its own.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../test/axe';
import { Discover } from './Discover';

describe('Discover', () => {
  it('with no Dispatch, shows the eyebrow, the heading, the empty state’s sentence and where a card or link opens', async () => {
    render(<Discover feed={[]} />);

    expect(screen.getByText('Reconcile', { selector: '.eyebrow' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Discover' })).toHaveFocus();
    expect(document.title).toBe('Discover · Reconcile');
    expect(
      screen.getByText(
        'Dispatches from your groups, and from the coalitions you’re in or follow, show up here.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('To open a card or link, paste it into the bar at the top.'),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
