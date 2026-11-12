/**
 * Following a coalition (#124), through the app's actions on several devices
 * and a fake relay: Riverside Tenants and Oak St Co-op reconcile, Ana shares
 * a follow link from the coalition, and Fay, on a fresh device in neither
 * group, follows it. Fay reads its Documents, and a Dispatch a motion
 * carries once that pass is final, while her device posts nothing, holds no
 * member group, no `inner` and no seat secret, and every request the relay
 * saw is free of the coalition's secret and the link's seed and key. Then
 * Fay unfollows, which leaves nothing of the coalition on her device, and
 * the coalition carries on for its groups.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { parseFollowLink } from '../coalition/follow';
import { base64url, fromBase64url } from '../crypto/base64url';
import { followChannelOf } from '../crypto/follow';
import { RESULT_GRACE_MINUTES } from '../engine/coalition';
import { fold } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import {
  CARD_VALUES,
  closeAll,
  coalitionOn,
  formedCoalition,
  open,
  SLOW,
  syncAll,
  vote,
} from '../test/coalitionDevices';
import type { FakeRelay } from '../test/fakeRelay';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { type Canary, findCanaries, keyCanaries, textCanary } from '../test/scan';
import { containsBytes, scanDb } from '../test/scanDb';
import { App } from './App';
import { followCoalition, lookupFollow, shareFollowLink, unfollow } from './follow';
import { messages } from './messages';
import { propose } from './proposals';

freshIndexedDBPerTest();

afterEach(() => {
  cleanup();
  closeAll();
});

/** A coalition name no other test plants, so a scan for it can't find anything else. */
const CANARY_NAME = 'CANARY Eastside Followed';

/** Relay time a week past a vote's deadline, by which every pass on it is final. */
const PAST_FINAL = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES + RESULT_GRACE_MINUTES + 60;

/** The one coalition entry `device` keeps. */
async function entryOn(device: TestDevice) {
  const [entry] = await device.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected a coalition entry.');
  return entry;
}

/** How many requests posted anything to the relay so far. */
function puts(fake: FakeRelay): number {
  return fake.requests.filter((request) => request.method !== 'GET').length;
}

/** Every leak of `canaries` in any request the relay got: its URL or its body. */
function leaks(fake: FakeRelay, canaries: readonly Canary[]): string[] {
  const encoder = new TextEncoder();
  return fake.requests.flatMap((request) => [
    ...findCanaries(encoder.encode(request.url), canaries).map((hit) => `${request.url}: ${hit}`),
    ...findCanaries(request.body ?? new Uint8Array(), canaries).map(
      (hit) => `${request.method} ${request.url} body: ${hit}`,
    ),
  ]);
}

/** Each member group's seat secret, as `device` reads it from `groupId`'s own log. */
async function seatSecretIn(device: TestDevice, groupId: string): Promise<Uint8Array> {
  const group = await device.services.store.getGroup(groupId);
  const target = fold(group?.log ?? [], null).proposals.find(
    (p) => p.target.kind === 'reconcile',
  )?.target;
  if (target?.kind !== 'reconcile' || !('seat' in target)) {
    throw new Error('Expected a group’s reconcile Proposal.');
  }
  return fromBase64url(target.seat);
}

/** Opens `device`'s app at `hash`. */
function openApp(device: TestDevice, hash: string): void {
  cleanup();
  window.history.replaceState(null, '', hash);
  render(<App services={device.services} />);
}

/**
 * The axe violations on the screen whose page title is `page`, once it is
 * that page's title. PageHeader sets the title in an effect that can run
 * after the heading is in the document, and axe's document-title rule reads
 * the title as it stands: with none yet, or a stale one, it checks the wrong
 * page.
 */
async function axeOn(page: string): Promise<string[]> {
  // A loaded machine can run the effect late (#260); a longer wait for the right title hides nothing.
  await waitFor(
    () => {
      expect(document.title).toBe(messages.app.pageTitle(page));
    },
    { timeout: 5_000 },
  );
  return axeViolations();
}

/** The coalition formed, Ana's follow link to it, and Fay following it on a fresh device. */
async function fayFollows(fake: FakeRelay) {
  const groups = await formedCoalition(fake, { ...CARD_VALUES, name: CANARY_NAME });
  const { ana } = groups;
  const anaEntry = await entryOn(ana);
  const link = await shareFollowLink(ana.services, anaEntry.groupId, ana.services.origin);
  const seed = parseFollowLink(link);
  if (seed === null) throw new Error('Expected a follow link.');
  const fay = await open(fake, 'fay');
  const posted = puts(fake);
  const lookup = await lookupFollow(fay.services, seed);
  if (lookup.kind !== 'found') throw new Error(`Expected the link to open, not ${lookup.kind}.`);
  const coalitionId = await followCoalition(fay.services, lookup.found);
  await fay.services.sync.syncOnce();
  return { ...groups, anaEntry, link, seed, fay, posted, lookup: lookup.found, coalitionId };
}

describe('following a coalition (#124)', SLOW, () => {
  it('lets Fay read it, and a Dispatch sent afterwards, from no member group, posting nothing', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const following = await fayFollows(fake);
    const { ana, ben, cy, fay, riverside, oak, anaEntry, link, lookup, coalitionId } = following;

    expect(link).toMatch(/^https:\/\/reconcile\.test\/#follow\/[A-Za-z0-9_-]{43}$/);
    expect(lookup.preview).toEqual({
      name: CANARY_NAME,
      groups: ['Riverside Tenants', 'Oak St Co-op'],
      excerpt: 'Everyone on the east side has a safe home.',
    });
    expect(coalitionId).toBe((await coalitionOn(ana)).group);
    expect(puts(fake)).toBe(following.posted);
    expect(await fay.services.store.listGroups()).toEqual([]);
    const entry = await entryOn(fay);
    expect(entry.following).toBe(true);
    expect(entry.outbox).toEqual([]);
    expect((await coalitionOn(fay)).coalition?.status).toBe('formed');

    openApp(fay, `#/c/${coalitionId}`);
    expect(await screen.findByRole('heading', { level: 1, name: CANARY_NAME })).toBeVisible();
    expect(screen.getByText('Following')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Dispatches' })).toHaveTextContent(
      'No Dispatches yet.',
    );
    expect(screen.queryByRole('button', { name: /Take part|Share/ })).not.toBeInTheDocument();
    expect(await axeOn(messages.coalitions.homePageTitle)).toEqual([]);
    await user.click(
      within(screen.getByRole('region', { name: 'Documents' })).getByRole('link', {
        name: /Mission statement/,
      }),
    );
    expect(await screen.findByText('Everyone on the east side has a safe home.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Propose/ })).not.toBeInTheDocument();
    expect(await axeOn(messages.document.pageTitle)).toEqual([]);

    const proposed = await propose(
      ana.services,
      anaEntry.groupId,
      {
        atom: `${coalitionId}.0`,
        title: 'Homes for all',
        why: 'Say it plainly.',
        text: 'Everyone on the east side has a safe, fair home.',
        link: null,
        dispatch: { title: 'Updated: Mission statement', text: 'Fair homes, now in writing.' },
      },
      coalitionId,
    );
    if (proposed.outcome !== 'proposed') throw new Error('Expected the motion.');
    await syncAll();
    await vote(riverside, proposed.proposalId, [ana, cy]);
    await vote(oak, proposed.proposalId, [ben, cy]);
    await syncAll();
    expect((await coalitionOn(fay)).dispatches).toEqual([]);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll();

    expect((await coalitionOn(fay)).dispatches.map((d) => d.title)).toEqual([
      'Updated: Mission statement',
    ]);
    openApp(fay, `#/c/${coalitionId}`);
    const dispatches = await screen.findByRole('region', { name: 'Dispatches' });
    expect(await within(dispatches).findByRole('article')).toHaveTextContent(
      'Fair homes, now in writing.',
    );
    expect(await axeOn(messages.coalitions.homePageTitle)).toEqual([]);
    expect(puts(fake)).toBeGreaterThan(following.posted);
    expect((await entryOn(fay)).outbox).toEqual([]);
  });

  it('keeps no inner or seat secret on Fay’s device, and the relay never sees a secret or the seed', async () => {
    const fake = createFakeRelay();
    const { ana, cy, riverside, oak, card, seed } = await fayFollows(fake);
    await syncAll();

    // A founding card carries `inner` (#313): the scan must find none of it on Fay's device.
    if (card.inner === undefined) throw new Error('Expected the founding card’s inner.');
    const held = await scanDb('fay');
    const seats = [await seatSecretIn(ana, riverside), await seatSecretIn(cy, oak)];
    for (const secret of [card.inner, ...seats]) {
      expect(containsBytes(held.bytes, secret)).toBe(false);
      expect(held.text).not.toContain(base64url(secret));
    }
    // A positive control: the scan reads what Fay's device does hold.
    expect(containsBytes(held.bytes, card.secret)).toBe(true);

    const canaries: Canary[] = [
      ...keyCanaries('the coalition secret', card.secret),
      ...keyCanaries('inner', card.inner),
      ...keyCanaries('the follow seed', seed),
      ...keyCanaries('the follow key', followChannelOf(seed).key),
      ...seats.flatMap((secret, i) => keyCanaries(`seat secret ${String(i)}`, secret)),
      textCanary('the coalition’s name', CANARY_NAME),
    ];
    expect(fake.requests.length).toBeGreaterThan(20);
    expect(leaks(fake, canaries)).toEqual([]);
    const control = new TextEncoder().encode(`/v1/mailbox/${base64url(seed)}`);
    expect(findCanaries(control, canaries)).toContain(
      'the follow seed (raw), as base64url at offset 0',
    );
    expect(fake.requests.some((r) => r.url.includes(followChannelOf(seed).mailbox))).toBe(true);
  });

  it('leaves nothing of the coalition on Fay’s device once she unfollows, and it carries on', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana, ben, fay, card, coalitionId } = await fayFollows(fake);
    const entry = await entryOn(fay);
    const posted = puts(fake);

    openApp(fay, `#/c/${coalitionId}`);
    await user.click(await screen.findByRole('button', { name: 'Unfollow' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Unfollow this coalition?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unfollow' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your groups' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Following' })).not.toBeInTheDocument();

    expect(await fay.services.store.listCoalitions()).toEqual([]);
    const held = await scanDb('fay');
    for (const word of [entry.groupId, coalitionId, CANARY_NAME, base64url(card.secret)]) {
      expect(held.text).not.toContain(word);
    }
    expect(containsBytes(held.bytes, card.secret)).toBe(false);
    await syncAll();
    expect(puts(fake)).toBe(posted);
    for (const device of [ana, ben]) {
      const coalition = await coalitionOn(device);
      expect(coalition.coalition?.status).toBe('formed');
      expect(coalition.name).toBe(CANARY_NAME);
    }
    await expect(unfollow(fay.services, entry.groupId)).rejects.toThrow(/No followed coalition/);
  });

  it('lists a followed coalition on Start, and opens it from there', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { fay, coalitionId } = await fayFollows(fake);
    openApp(fay, '#/');
    const section = await screen.findByRole('region', { name: 'Following' });
    const link = within(section).getByRole('link', { name: new RegExp(CANARY_NAME) });
    expect(link).toHaveTextContent('Riverside Tenants·Oak St Co-op');
    expect(await axeOn(messages.start.pageTitle)).toEqual([]);
    await user.click(link);
    expect(window.location.hash).toBe(`#/c/${coalitionId}`);
    expect(await screen.findByRole('heading', { level: 1, name: CANARY_NAME })).toBeVisible();
  });

  it('opens an already-followed coalition from its link again, merging, with nothing new kept', async () => {
    const fake = createFakeRelay();
    const { fay, seed, coalitionId } = await fayFollows(fake);
    const again = await lookupFollow(fay.services, seed);
    expect(again).toEqual({ kind: 'held', coalitionId });
    expect(await fay.services.store.listCoalitions()).toHaveLength(1);
  });

  it('refuses to share a link from a coalition the device doesn’t hold, or to unfollow one it takes part in', async () => {
    const fake = createFakeRelay();
    const { ana, anaEntry } = await fayFollows(fake);
    await expect(shareFollowLink(ana.services, 'no-such-entry', 'https://x.test')).rejects.toThrow(
      /No formed coalition/,
    );
    await expect(unfollow(ana.services, anaEntry.groupId)).rejects.toThrow(/No followed coalition/);
    expect(await ana.services.store.listCoalitions()).toHaveLength(1);
  });

  it('follows from the link through the app, the seed leaving the address bar', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana } = await formedCoalition(fake, { ...CARD_VALUES, name: CANARY_NAME });
    const link = await shareFollowLink(
      ana.services,
      (await entryOn(ana)).groupId,
      'https://x.test',
    );
    const gus = await open(fake, 'gus');

    openApp(gus, new URL(link).hash);
    const follow = await screen.findByRole('button', { name: 'Follow' });
    expect(window.location.hash).toBe('#/follow');
    await user.click(follow);

    // The preview's heading is the coalition's name too: wait for the follower's home itself.
    expect(await screen.findByRole('region', { name: 'Dispatches' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: CANARY_NAME })).toBeVisible();
    expect(window.location.hash).toBe(`#/c/${(await coalitionOn(ana)).group ?? ''}`);
    expect((await entryOn(gus)).following).toBe(true);
  });

  it('opens a follow link pasted on Start, and Not now keeps nothing', async () => {
    const user = userEvent.setup();
    const fake = createFakeRelay();
    const { ana } = await formedCoalition(fake, { ...CARD_VALUES, name: CANARY_NAME });
    const link = await shareFollowLink(
      ana.services,
      (await entryOn(ana)).groupId,
      'https://x.test',
    );
    const gus = await open(fake, 'gus');

    openApp(gus, '#/');
    await user.click(await screen.findByRole('textbox', { name: 'Invite link' }));
    await user.paste(link);
    await user.click(screen.getByRole('button', { name: 'Join with an invite link' }));
    expect(await screen.findByRole('heading', { level: 1, name: CANARY_NAME })).toBeVisible();
    expect(window.location.hash).toBe('#/follow');
    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Your groups' })).toBeVisible();
    expect(await gus.services.store.listCoalitions()).toEqual([]);
  });
});
