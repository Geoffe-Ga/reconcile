/**
 * A score chosen on a coalition motion's ballot survives the device syncing
 * (#354). On #297's CI, WebKit lost one click on Riverside's ballot while
 * Ana's device synced Oak St's pass. Either the click landed while the
 * ballot was disabled or re-rendering, or `Ballot` remounted and its
 * `useState(initialScores)` started over, which would wipe a voter's unsent
 * choice as their device syncs. Here Ana chooses a score, sends nothing, and
 * her device syncs Oak St's pass while the ballot is on screen: the same
 * radio, never disabled, keeps her choice.
 *
 * Neither happens: `Ballot` is keyed by the Proposal's id alone, which no
 * sync changes, and nothing it is given turns it off. What does move is the
 * layout. "Across the coalition" loses a group from its waiting line when a
 * group's pass arrives, which in the real app (Chromium) lifts the pills by
 * a line, 25 px. A click aimed just before that lands where a pill was, so it
 * chooses nothing, and nothing is lost: the voter sees no choice and picks
 * again, as #297's `pick` now does.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../app/App';
import { propose } from '../app/proposals';
import { bringCard } from '../app/reconcile';
import {
  anaMakesCard,
  closeAll,
  coalitionOn,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER } from '../test/members';

freshIndexedDBPerTest();

afterEach(() => {
  // Unmount the app before its device's store closes.
  cleanup();
  closeAll();
});

/** What Ana proposes for the coalition's first section. */
const CHANGE = {
  title: 'Paths and banks too',
  why: 'We all walk the river paths.',
  text: 'Everyone on the east side has a safe home, and safe paths to it.',
  link: null,
};

/** Each radio on the ballot, by its name, and whether it's disabled, as one line. */
function radios(ballot: HTMLElement): string[] {
  return within(ballot)
    .getAllByRole('radio')
    .map((radio) => {
      const input = radio as HTMLInputElement;
      return `${input.getAttribute('aria-label') ?? input.value}${input.disabled ? ' (disabled)' : ''}`;
    });
}

describe('a score chosen on a coalition motion while the device syncs (#354)', SLOW, () => {
  it('stays chosen on the same radio, which is never disabled, as another group’s pass arrives', async () => {
    const user = userEvent.setup(APP_USER);
    const fake = createFakeRelay();
    const { ana, ben, cy, riverside, oak } = await twoGroups(fake);
    const { proposal, found: card } = await anaMakesCard(ana, cy, riverside);
    const brought = await bringCard(cy.services, card, oak, 'Cy');
    await syncAll(1);
    await vote(riverside, proposal, [ana, cy]);
    await vote(oak, brought, [ben, cy]);
    await syncAll();
    const coalition = (await coalitionOn(ana)).group;
    const [entry] = await ana.services.store.listCoalitions();
    if (coalition === null || entry === undefined) throw new Error('Expected the coalition.');
    const atom = `${coalition}.0`;
    const motion = await propose(ana.services, entry.groupId, { ...CHANGE, atom }, coalition);
    if (motion.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
    await syncAll(3);
    // Oak St passes it, and Cy's device, bound to Oak St's seat, reports that up. Ana's doesn't sync.
    await vote(oak, motion.proposalId, [ben, cy]);
    for (let pass = 0; pass < 3; pass += 1) {
      for (const device of [ben, cy]) await device.services.sync.syncOnce();
    }

    window.history.replaceState(null, '', `#/g/${riverside}/p/${motion.proposalId}`);
    render(<App services={ana.services} />);
    const progress = await screen.findByRole('region', { name: 'Across the coalition' });
    expect(progress).toHaveTextContent('0 of 2 groups have passed.');
    const ballot = screen.getByRole('region', { name: 'Changes to section 1' });
    const four = within(ballot).getByRole('radio', { name: /4 · Strongly supportive/ });
    const enabled = radios(ballot);
    expect(enabled.some((line) => line.endsWith('(disabled)'))).toBe(false);
    const flips: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records)
        flips.push(`${record.attributeName ?? ''} on ${(record.target as Element).tagName}`);
    });
    watch.observe(ballot, {
      attributes: true,
      attributeFilter: ['disabled', 'data-disabled'],
      subtree: true,
    });

    await user.click(four);
    expect(four).toBeChecked();
    // Ana's device syncs Oak St's pass while her choice is unsent.
    await act(async () => {
      for (let pass = 0; pass < 3; pass += 1) await ana.services.sync.syncOnce();
    });
    expect(
      await screen.findByText(/1 of 2 groups has passed/, undefined, { timeout: 5_000 }),
    ).toBeVisible();
    watch.disconnect();

    const after = within(screen.getByRole('region', { name: 'Changes to section 1' })).getByRole(
      'radio',
      { name: /4 · Strongly supportive/ },
    );
    expect(after).toBe(four);
    expect(after).toBeChecked();
    expect(flips).toEqual([]);
    expect(radios(screen.getByRole('region', { name: 'Changes to section 1' }))).toEqual(enabled);
  });
});
