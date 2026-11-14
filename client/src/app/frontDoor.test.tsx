/**
 * A group's front door through the whole app (#121), on devices that share
 * one fake relay whose clock the test moves: Ana, Ben and Cal pass the
 * opt-in from Group rules; Kim, on a fresh store, opens the link and asks to
 * join; Ana sends an invite from Applications, Ben reads "Invited by Ana";
 * Kim's Your groups says the group invited her, and she joins; and she can't
 * vote until two people vouch and 14 days have passed, in relay time.
 *
 * Every request the relay got is scanned: none carries a door secret, Kim's
 * reply seed or key, or the words she wrote. The published page's plaintext
 * holds no member's name, though every name is a canary.
 */
import { act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { fromBase64url } from '../crypto/base64url';
import { doorChannelsOf, openDoorRecord, replyMailboxOf } from '../crypto/door';
import { xchachaSeal } from '../crypto/seal';
import { apply } from '../door/apply';
import { sendInvite } from '../door/inbox';
import { addressOf, doorLinkOf, newFrontDoor, parseDoorLink, readDoor } from '../door/page';
import { can } from '../engine/capabilities';
import { fold } from '../engine/fold';
import { isFrontDoor } from '../engine/optIns';
import { DAY_MINUTES } from '../engine/rules';
import { createRelay } from '../net/relay';
import { TEST_ORIGIN, testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { type Canary, findCanaries, keyCanaries, textCanary } from '../test/scan';
import { makeInvite as makeInviteLink } from './actions';
import { castBallot, proposeRules, vouch } from './proposals';

freshIndexedDBPerTest();

/** Every member's name is a canary: none may reach the page. */
const NAMES = ['Anaquill', 'Benquill', 'Calquill'];
const APPLICANT = 'Kimwren-applicant';
const MESSAGE = 'I live at number 12 and fix bikes on Sundays, canary-7f3c.';

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

/** Each device scores `proposalId` 4 and sends it, then every device syncs. */
async function everyoneVotes(devices: readonly TestDevice[], groupId: string, proposalId: string) {
  for (const device of devices) {
    const scores = { [proposalId]: 4 as const };
    await castBallot(device.services, groupId, { proposal: proposalId, scores, note: '' });
    await sync(device);
  }
  for (const device of devices) await sync(device);
}

/** The door the group's standing rules hold, read from a member's log. */
async function standingDoor(device: TestDevice | undefined, groupId: string) {
  const group = await device?.services.store.getGroup(groupId);
  const door = fold(group?.log ?? [], group?.relayNow ?? null).rules.optIns.frontDoor;
  if (!isFrontDoor(door)) throw new Error('Expected an open front door.');
  return door;
}

/** Every page copy's plaintext in the door's page mailbox, as anyone with the link opens it. */
async function pagePlaintexts(fake: FakeRelay, address: Uint8Array): Promise<string[]> {
  const { page, pageKey } = doorChannelsOf(address);
  const { records } = await createRelay({ fetch: fake.fetch }).getBlobs(page, 0);
  return records.flatMap(({ data }) => {
    const record = xchachaSeal.open(page, pageKey, data);
    const bytes = record && openDoorRecord(record, address);
    return bytes === null ? [] : [new TextDecoder().decode(bytes)];
  });
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

/** Ana opens the front door from Group rules, and everyone votes it through. */
async function openTheDoor(devices: readonly TestDevice[], groupId: string): Promise<string> {
  const user = userEvent.setup();
  const [ana] = devices;
  go(`#/g/${groupId}/rules`);
  const a = mount(ana, 'a');
  await user.click(
    await within(a).findByRole('link', { name: 'Propose turning this on for the front door' }),
  );
  await user.click(await within(a).findByRole('textbox', { name: 'Why' }));
  await user.paste('People keep asking how to join.');
  await user.click(within(a).getByRole('button', { name: 'Propose this change' }));
  await waitFor(() => {
    expect(window.location.hash).toMatch(/\/p\/[A-Za-z0-9_-]{43}$/);
  });
  const proposalId = window.location.hash.split('/').at(-1) ?? '';
  await sync(ana);
  await everyoneVotes(devices, groupId, proposalId);
  expect(await within(a).findByText('This passed. Your group’s front door is open.')).toBeVisible();
  go(`#/g/${groupId}/rules`);
  const field = await within(a).findByRole('textbox', { name: 'Front door link' });
  return (field as HTMLInputElement).value;
}

/** Kim, on a fresh store, opens `link` and asks to join. */
async function kimApplies(kim: TestDevice, link: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  go(new URL(link).hash);
  const k = mount(kim, 'k');
  expect(
    await within(k).findByRole('heading', { level: 1, name: 'Riverside Tenants' }),
  ).toBeVisible();
  expect(within(k).getByText('Quiet hours start at ten.')).toBeVisible();
  await user.click(within(k).getByRole('textbox', { name: 'Name you’d like to use' }));
  await user.paste(APPLICANT);
  await user.click(within(k).getByRole('textbox', { name: 'Why you’d like to join' }));
  await user.paste(MESSAGE);
  expect(
    within(k).getByText('Don’t include anything you wouldn’t want this group to read.'),
  ).toBeVisible();
  await user.click(within(k).getByRole('button', { name: 'Send' }));
  // The page's own status, not the link bar's (#444).
  expect(await within(within(k).getByRole('main')).findByRole('status')).toHaveTextContent(
    'Sent. If someone in Riverside Tenants invites you, it shows on Your groups.',
  );
  return k;
}

/** Ana, Ben and Cal's group on a fresh fake relay, with its front door opened by their votes. */
async function openGroup() {
  const fake = createFakeRelay();
  const { groupId, devices } = await members(fake, NAMES);
  opened.push(...devices);
  const [ana] = devices;
  if (ana === undefined) throw new Error('Expected Ana.');
  const proposed = await proposeRules(ana.services, groupId, {
    optIn: 'frontDoor',
    value: newFrontDoor(false),
    title: 'Open a front door',
    why: 'People keep asking how to join.',
    narrow: false,
  });
  if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
  await sync(ana);
  await everyoneVotes(devices, groupId, proposed.proposalId);
  const door = await standingDoor(ana, groupId);
  const address = addressOf(door);
  return { fake, groupId, devices, door, address, link: doorLinkOf(TEST_ORIGIN, address) };
}

/** Kim's device on `fake`, a fresh store. */
async function newcomer(fake: FakeRelay): Promise<TestDevice> {
  const kim = await testDevice(fake, 'kim');
  opened.push(kim);
  return kim;
}

/** Kim asks to join at `address` without the screen, as Send does. */
async function applyQuietly(fake: FakeRelay, kim: TestDevice, address: Uint8Array) {
  const view = await readDoor(
    { relay: createRelay({ fetch: fake.fetch }), seal: xchachaSeal },
    address,
  );
  if (view.kind !== 'open') throw new Error('Expected an open door.');
  expect(await apply(kim.services, address, view.page, { name: APPLICANT, message: MESSAGE })).toBe(
    'sent',
  );
}

/** `device` syncs, then sends an invite to the one application its inbox holds. */
async function inviteQuietly(device: TestDevice | undefined, groupId: string) {
  await sync(device);
  const group = await device?.services.store.getGroup(groupId);
  const [application] = group?.door?.applications ?? [];
  if (device === undefined || application === undefined) throw new Error('Expected one.');
  const makeInvite = () => makeInviteLink(device.services, groupId, device.services.origin);
  const outcome = await sendInvite({ ...device.services, makeInvite }, groupId, application.id);
  expect(outcome).toBe('sent');
  await sync(device);
}

/** The text of the one element of `className` inside `within`, once it shows. */
async function textOf(inside: HTMLElement, className: string): Promise<string> {
  let text = '';
  await waitFor(() => {
    text = inside.querySelector(`.${className}`)?.textContent ?? '';
    expect(text).not.toBe('');
  });
  return text.replace(/\s+/g, ' ');
}

describe('a group’s front door in the app', () => {
  it('1. a group passes the opt-in from Group rules, and its page names no member', async () => {
    const fake = createFakeRelay();
    const { groupId, devices } = await members(fake, NAMES);
    opened.push(...devices);
    const [ana] = devices;

    const link = await openTheDoor(devices, groupId);
    const address = parseDoorLink(link);
    if (address === null) throw new Error('Expected a front door link.');
    const door = await standingDoor(ana, groupId);
    expect(Array.from(address)).toEqual(Array.from(addressOf(door)));
    const pages = await pagePlaintexts(fake, address);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('"name":"Riverside Tenants"');
    expect(pages[0]).toContain('"excerpt":"Quiet hours start at ten."');
    for (const name of NAMES) expect(pages[0]).not.toContain(name);
    expect(pages[0]).not.toContain('"count"');
  });

  it('2. a fresh store opens the link and applies, and a member invites them from Applications', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices, link } = await openGroup();
    const [ana, ben] = devices;
    const kim = await newcomer(fake);
    const k = await kimApplies(kim, link);
    for (const name of NAMES) expect(k.textContent).not.toContain(name);
    expect(await kim.services.store.listSent()).toHaveLength(1);
    for (const app of mounted.splice(0)) app.unmount();

    go(`#/g/${groupId}`);
    await sync(ana);
    const a = mount(ana, 'a');
    const applications = await within(a).findByRole('region', { name: 'Applications' });
    expect(within(applications).getByText(APPLICANT)).toBeVisible();
    expect(within(applications).getByText(MESSAGE)).toBeVisible();
    await user.click(
      within(applications).getByRole('button', { name: `Send an invite to ${APPLICANT}` }),
    );
    expect(
      await within(applications).findByText('Invite sent. It waits 2 days for their device.'),
    ).toBeVisible();
    await sync(ana);
    await sync(ben);
    const b = mount(ben, 'b');
    const theirs = await within(b).findByRole('region', { name: 'Applications' });
    expect(await textOf(theirs, 'application-invited')).toBe('Invited by Anaquill');
    expect(
      within(theirs).queryByRole('button', { name: `Send an invite to ${APPLICANT}` }),
    ).toBeNull();
    // Dismiss hides it on Ben's device alone.
    await user.click(
      within(theirs).getByRole('button', { name: `Dismiss ${APPLICANT}’s application` }),
    );
    expect(await within(theirs).findByText('No one has asked to join yet.')).toBeVisible();
    expect(within(applications).getByText(APPLICANT)).toBeVisible();
  });

  it('3. the applicant joins from the invite on Your groups, and 4. can’t vote until vouched and 14 days have passed', async () => {
    const user = userEvent.setup();
    const { fake, groupId, devices, address } = await openGroup();
    const [ana, ben] = devices;
    const kim = await newcomer(fake);
    await applyQuietly(fake, kim, address);
    await inviteQuietly(ana, groupId);

    await sync(kim);
    go('#/');
    const k = mount(kim, 'k');
    const asked = await within(k).findByRole('region', { name: 'Asked to join' });
    expect(await textOf(asked, 'request-invited')).toBe('Riverside Tenants invited you');
    await user.click(within(asked).getByRole('button', { name: 'Open your invite' }));
    await user.click(await within(k).findByRole('textbox', { name: 'Your name' }));
    await user.paste('Kim');
    await user.click(within(k).getByRole('button', { name: 'Join group' }));
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/g/${groupId}`);
    });
    expect(await kim.services.store.listSent()).toEqual([]);

    const kimAuthor = (await kim.services.store.getGroup(groupId))?.me.author ?? '';
    const votes = async () => {
      await sync(ana);
      const group = await ana?.services.store.getGroup(groupId);
      return can(fold(group?.log ?? [], group?.relayNow ?? null), kimAuthor, 'vote');
    };
    await sync(kim);
    expect(await votes()).toBe(false);
    for (const voucher of [ana, ben]) {
      if (voucher === undefined) throw new Error('Expected a voucher.');
      await vouch(voucher.services, groupId, kimAuthor);
      await sync(voucher);
    }
    expect(await votes()).toBe(false);
    fake.minute += 14 * DAY_MINUTES;
    expect(await votes()).toBe(true);
  });

  it('carries no door secret, reply seed or key, or the applicant’s words in any request', async () => {
    const { fake, groupId, devices, door, address } = await openGroup();
    const [ana, ben] = devices;
    const kim = await newcomer(fake);
    await applyQuietly(fake, kim, address);
    await sync(ben);
    await inviteQuietly(ana, groupId);
    await sync(kim);
    const [sent] = await kim.services.store.listSent();
    if (sent?.invite === undefined) throw new Error('Expected Kim’s invite.');

    const canaries: Canary[] = [
      ...keyCanaries('door sign secret', fromBase64url(door.sign)),
      ...keyCanaries('door box secret', fromBase64url(door.box)),
      ...keyCanaries('reply seed', sent.seed),
      ...keyCanaries('reply secret key', sent.replyKey),
      textCanary('application name', APPLICANT),
      textCanary('application message', MESSAGE),
    ];
    expect(fake.requests.length).toBeGreaterThan(30);
    expect(leaks(fake, canaries)).toEqual([]);
    // The scan's controls: the inbox and the reply mailbox are named, and Ben's
    // device holds the application's words, which the scan would find.
    const { inbox } = doorChannelsOf(address);
    expect(fake.requests.some((request) => request.url.includes(inbox))).toBe(true);
    expect(fake.requests.some((request) => request.url.includes(replyMailboxOf(sent.seed)))).toBe(
      true,
    );
    const held = (await ben?.services.store.getGroup(groupId))?.door?.applications ?? [];
    const words = new TextEncoder().encode(JSON.stringify(held));
    expect(findCanaries(words, canaries)).toContain('application message, as bytes');
  });
});
