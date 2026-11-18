/**
 * Vote links through the whole app (#472, ADR-0079): Copy link to this vote
 * on a Proposal's page copies its link, and a `#vote/` link opened on
 * another member's device lands on that Proposal's ballot in the link's
 * place, so Back skips it, even when the vote reaches the device only with
 * the sync pass the link waits for. A device in no group says the vote isn't
 * on it, and only once that pass is done.
 */
import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { voteToken } from '../crypto/voteLink';
import { eventIdOf } from '../store/eventId';
import type { TestDevice } from '../test/appServices';
import { TEST_ORIGIN, testDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { APP_USER, go, members, type MountedApp, mountApp, proposeFrom } from '../test/members';
import { messages } from './messages';
import type { AppServices } from './services';

freshIndexedDBPerTest();

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
});

function mount(services: AppServices, prefix: string): HTMLElement {
  const app = mountApp(services, prefix);
  mounted.push(app);
  return app.container;
}

/** Ana and Ben's group, and Ana's Proposal on its first section from her app: its id and vote link. */
async function anaProposes() {
  const user = userEvent.setup(APP_USER);
  const fake = createFakeRelay();
  const { groupId, devices } = await members(fake, ['Ana', 'Ben']);
  opened.push(...devices);
  const [ana, ben] = devices;
  if (ana === undefined || ben === undefined) throw new Error('Expected two devices.');
  go(`#/g/${groupId}/doc`);
  const a = mount(ana.services, 'a');
  await proposeFrom(within(a), user, 1, { title: 'Quiet hours', text: 'Quiet after 10pm.' });
  await within(a).findByRole('button', { name: 'Tell your group' });
  const stored = await ana.services.store.getGroup(groupId);
  const record = stored?.log.at(-1);
  const proposalId = record === undefined ? null : eventIdOf(record.bytes);
  if (stored === undefined || proposalId === null) throw new Error('Expected the Proposal.');
  const token = voteToken(stored.secret, proposalId);
  return { user, fake, groupId, ana, ben, a, proposalId, token };
}

describe('vote links (#472)', () => {
  it('copies the vote’s link from Copy link to this vote, with the line on who can open it', async () => {
    const { user, ana, a, token } = await anaProposes();

    expect(within(a).getByText(messages.vote.copyHint)).toBeVisible();
    await user.click(within(a).getByRole('button', { name: 'Copy link to this vote' }));

    await waitFor(() => {
      expect(ana.copied).toEqual([`${TEST_ORIGIN}/#vote/${token}`]);
    });
  });

  it('opens the vote on another member’s device in the link’s place, once its sync pass brings it', async () => {
    const { groupId, ben, proposalId, token, a } = await anaProposes();
    mounted.shift()?.unmount();
    expect(a.isConnected).toBe(false);
    window.history.replaceState(null, '', '#/');
    window.history.pushState(null, '', `#vote/${token}`);
    const depth = window.history.length;

    // Ben's device hasn't synced since Ana proposed: the link waits for the pass that brings it.
    const b = mount(ben.services, 'b');

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/g/${groupId}/p/${proposalId}`);
    });
    expect(await within(b).findByRole('heading', { level: 1, name: 'Quiet hours' })).toBeVisible();
    expect(window.history.length).toBe(depth);
    expect(within(b).queryByText(messages.vote.missing)).toBeNull();
  });

  it('says the vote isn’t on a device in no group, only once its sync pass is done', async () => {
    const { token } = await anaProposes();
    // Ana's app would open the link itself: only the stranger's is on the page.
    mounted.shift()?.unmount();
    const stranger = await testDevice(createFakeRelay(), 'stranger');
    opened.push(stranger);
    let passes = 0;
    const services: AppServices = {
      ...stranger.services,
      sync: {
        ...stranger.services.sync,
        syncOnce: async () => {
          passes += 1;
          return stranger.services.sync.syncOnce();
        },
      },
    };
    go(`#vote/${token}`);

    const s = mount(services, 's');

    expect(await within(s).findByText(messages.vote.missing)).toBeVisible();
    expect(passes).toBe(1);
    expect(window.location.hash).toBe(`#vote/${token}`);
  });
});
