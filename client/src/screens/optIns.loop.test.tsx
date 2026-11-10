/**
 * Opt-ins through the whole app (#117), on two devices that share one fake
 * relay. Ana proposes turning the chat bot on from Group rules, both vote
 * it through at the entrenched bar, and Group rules reads it on by its
 * webhook's last 4. With the bot on, Ana, the steward, turns it off now, and
 * Ben reads who did. In both, a spy on `fetch` and the relay's record of every
 * request it got show the webhook never left a device readable: it is in no
 * request URL and no request body, in any of its parts.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { castBallot, proposeRules } from '../app/proposals';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';

freshIndexedDBPerTest();

const ID = '1199000000000000001';
const TOKEN = 'sEcReT-tokenWXYZ';
const WEBHOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const PROPOSAL_PAGE = /^#\/g\/[A-Za-z0-9_-]{43}\/p\/[A-Za-z0-9_-]{43}$/;

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
  vi.restoreAllMocks();
});

function mount(device: TestDevice | undefined, prefix: string): HTMLElement {
  if (device === undefined) throw new Error('Expected a device.');
  const app = mountApp(device.services, prefix);
  mounted.push(app);
  return app.container;
}

async function sync(device: TestDevice | undefined): Promise<void> {
  await act(() => device?.services.sync.syncOnce());
}

/** True when `needle`'s bytes appear anywhere in `haystack`. */
function holds(haystack: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle);
  for (let at = 0; at + bytes.length <= haystack.length; at += 1) {
    if (bytes.every((byte, i) => haystack[at + i] === byte)) return true;
  }
  return false;
}

/** Every request the relay received that carries the webhook, or any part of it, readable. */
function leaks(fake: FakeRelay): string[] {
  return fake.requests.flatMap((request) =>
    [WEBHOOK, TOKEN, ID]
      .filter(
        (part) =>
          request.url.includes(part) || (request.body !== null && holds(request.body, part)),
      )
      .map((part) => `${request.method} ${request.url}: ${part}`),
  );
}

/** Ana and Ben's group on one fake relay, with a spy on the page's own `fetch`. */
async function group() {
  const network = vi.spyOn(globalThis, 'fetch');
  const fake = createFakeRelay();
  const { groupId, devices } = await members(fake, ['Ana', 'Ben']);
  opened.push(...devices);
  return { network, fake, groupId, devices };
}

/** Each device scores `proposalId` 4 through the app's action and sends it, then every device syncs. */
async function everyoneVotes(devices: readonly TestDevice[], groupId: string, proposalId: string) {
  for (const device of devices) {
    const scores = { [proposalId]: 4 as const };
    await castBallot(device.services, groupId, { proposal: proposalId, scores, note: '' });
    await sync(device);
  }
  for (const device of devices) await sync(device);
}

/** The chat bot's card on an app's Group rules. */
function botOf(app: HTMLElement) {
  return within(app).findByRole('region', { name: 'Discord chat bot' });
}

/** The scan's control: it finds the webhook where it does sit, in a device's own signed log. */
async function keptLocally(device: TestDevice | undefined, groupId: string): Promise<boolean> {
  const kept = await device?.services.store.getGroup(groupId);
  return kept?.log.some((record) => holds(record.bytes, WEBHOOK)) ?? false;
}

describe('opt-ins in the app', () => {
  it('turns the chat bot on from Group rules by a vote, and the webhook never reaches the relay readable', async () => {
    const user = userEvent.setup();
    const { network, fake, groupId, devices } = await group();
    const [ana] = devices;
    go(`#/g/${groupId}/rules`);
    const a = mount(ana, 'a');

    const propose = 'Propose turning this on for the Discord chat bot';
    await user.click(await within(a).findByRole('link', { name: propose }));
    await user.click(await within(a).findByRole('textbox', { name: 'Discord webhook URL' }));
    await user.paste(WEBHOOK);
    await user.click(within(a).getByRole('textbox', { name: 'Why' }));
    await user.paste('A nudge in the chat when a vote opens.');
    await user.click(within(a).getByRole('button', { name: 'Propose this change' }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(PROPOSAL_PAGE);
    });
    const proposalId = window.location.hash.split('/').at(-1) ?? '';
    // The relay must have the Proposal before anyone's ballot on it.
    await sync(ana);
    await everyoneVotes(devices, groupId, proposalId);
    expect(await within(a).findByText('This passed. The Discord chat bot is on.')).toBeVisible();

    go(`#/g/${groupId}/rules`);
    expect(within(await botOf(a)).getByText('WXYZ')).toBeVisible();

    expect(await keptLocally(ana, groupId)).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(10);
    expect(leaks(fake)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('lets the steward turn the bot off now, tells everyone who did, and keeps the webhook off the relay', async () => {
    const user = userEvent.setup();
    const { network, fake, groupId, devices } = await group();
    const [ana, ben] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const on = await proposeRules(ana.services, groupId, {
      optIn: 'chatBot',
      value: { webhook: WEBHOOK },
      title: 'Turn on the Discord chat bot',
      why: 'Nudges.',
      narrow: false,
    });
    if (on.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    await sync(ana);
    await everyoneVotes(devices, groupId, on.proposalId);
    go(`#/g/${groupId}/rules`);
    const a = mount(ana, 'a');
    const b = mount(ben, 'b');

    await user.click(
      within(await botOf(a)).getByRole('link', { name: 'Turn off now for the Discord chat bot' }),
    );
    await user.click(await within(a).findByRole('textbox', { name: 'Why' }));
    await user.paste('Someone posted the webhook in public.');
    await user.click(within(a).getByRole('button', { name: 'Turn off now' }));
    await waitFor(() => {
      expect(window.location.hash).toMatch(PROPOSAL_PAGE);
    });
    await sync(ana);
    await sync(ben);
    expect(
      await within(b).findByText(/turned this off at once\. It stays off while your group votes\./),
    ).toHaveTextContent('Steward Ana turned this off at once.');
    go(`#/g/${groupId}/rules`);
    expect(within(await botOf(b)).getByText(/turned it off while your group votes/)).toBeVisible();

    expect(await keptLocally(ana, groupId)).toBe(true);
    expect(leaks(fake)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
});
