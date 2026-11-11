/**
 * Dispatches through the whole app (#112), on two devices that share one
 * fake relay. Ana, a Co-Creator, sends a Dispatch from Send a Dispatch; Kim,
 * who follows as a Member, reads it on her own device after sync, with its
 * Document link, and her Group home leads with it. A Proposal carrying a
 * Dispatch reaches her once it passes. The relay's record of every request
 * shows the Dispatch's words never left a device readable, and its PUT asked
 * for the content-free wake.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { castBallot, propose } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';

freshIndexedDBPerTest();

const [FOLLOWING] = LEVELS;
const TITLE = 'Canary garden day';
const TEXT = 'Canary bring gloves.\nWe start at 10.';

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) device.services.store.close();
  window.history.replaceState(null, '', '#/');
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

/** True when `needle`'s UTF-8 bytes appear anywhere in `haystack`. */
function holds(haystack: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle);
  for (let at = 0; at + bytes.length <= haystack.length; at += 1) {
    if (bytes.every((byte, i) => haystack[at + i] === byte)) return true;
  }
  return false;
}

/** Every request the relay received that carries one of `words` readable, in its URL or body. */
function leaks(fake: FakeRelay, words: readonly string[]): string[] {
  return fake.requests.flatMap((request) =>
    words
      .filter(
        (word) =>
          request.url.includes(word) || (request.body !== null && holds(request.body, word)),
      )
      .map((word) => `${request.method} ${request.url}: ${word}`),
  );
}

/** Ana founds; Kim joins as a Member, following the group. */
async function group() {
  const fake = createFakeRelay();
  const { groupId, devices } = await members(fake, ['Ana', 'Kim'], null, { Kim: FOLLOWING });
  opened.push(...devices);
  return { fake, groupId, devices };
}

describe('Dispatches in the app (#112)', () => {
  it('sends a Dispatch from one device, and a follower reads it on hers after sync, with its Document link', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices } = await group();
    const [ana, kim] = devices;
    go(`#/g/${groupId}/dispatch/new`);
    const a = mount(ana, 'a');
    const k = mount(kim, 'k');
    expect(
      await within(k).findByRole('heading', { level: 1, name: 'You can’t send Dispatches here' }),
    ).toBeVisible();

    await user.click(await within(a).findByRole('textbox', { name: 'Title' }));
    await user.paste(TITLE);
    await user.click(within(a).getByRole('textbox', { name: 'Text (optional)' }));
    await user.paste(TEXT);
    await user.click(within(a).getByText('House rules'));
    const before = fake.requests.length;
    await user.click(within(a).getByRole('button', { name: 'Send Dispatch' }));
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/g/${groupId}/dispatches`);
    });
    await sync(ana);
    await sync(kim);

    const card = await within(k).findByRole('article');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(TITLE);
    expect(card).toHaveTextContent('From Ana');
    expect(within(card).getByText(/Canary bring gloves\./).textContent).toBe(TEXT);
    expect(within(card).getByRole('link', { name: 'Open House rules' })).toHaveAttribute(
      'href',
      `#/g/${groupId}/doc`,
    );

    go(`#/g/${groupId}`);
    const lead = await within(k).findAllByRole('region');
    expect(lead[0]?.querySelector('h2')?.textContent).toBe('Dispatches');
    expect(within(lead[0] ?? k).getByRole('article')).toHaveTextContent(TITLE);

    const puts = fake.requests
      .slice(before)
      .filter((request) => request.method === 'PUT' && request.url.startsWith('/v1/mailbox/'));
    expect(puts.map((request) => request.url.endsWith('&wake=1'))).toContain(true);
    // The scan's control: the words do sit in the follower's own signed log, where the scan finds them.
    const kept = await kim?.services.store.getGroup(groupId);
    expect(kept?.log.some((record) => holds(record.bytes, TITLE))).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(10);
    expect(leaks(fake, [TITLE, 'Canary bring gloves', 'Canary'])).toEqual([]);
  });

  it('brings a passed Proposal’s Dispatch to the follower, from the Proposal', async () => {
    const { fake, groupId, devices } = await group();
    const [ana, kim] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const proposed = await propose(ana.services, groupId, {
      atom: `${groupId}.0`,
      title: 'Canary later quiet hours',
      why: 'Weekends run late.',
      text: 'Quiet hours start at eleven.',
      link: null,
      dispatch: { title: 'Updated: House rules', text: 'Canary quiet hours moved.' },
    });
    if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
    await sync(ana);
    const scores = { [proposed.proposalId]: 4 as const };
    await castBallot(ana.services, groupId, { proposal: proposed.proposalId, scores, note: '' });
    await sync(ana);
    await sync(kim);

    go(`#/g/${groupId}/dispatches`);
    const k = mount(kim, 'k');
    const card = await within(k).findByRole('article');
    expect(card).toHaveTextContent('Updated: House rules');
    expect(card).toHaveTextContent('From the Proposal ‘Canary later quiet hours’');
    expect(within(card).getByRole('link', { name: 'Open House rules' })).toBeVisible();
    expect(leaks(fake, ['Canary quiet hours moved', 'Updated: House rules'])).toEqual([]);
  });
});
