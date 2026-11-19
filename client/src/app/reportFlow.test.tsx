/**
 * Reports and appeals through the whole app (#490; listed-doors.md §6.3,
 * §6.4), on real devices sharing one fake relay and one fake shelf.
 *
 * Anaquill and Benquill list their group's front door by vote. The steward
 * holds one of its entries; Ana asks the steward to look again from Group
 * home. Kim, in no group, reports another entry from its own page. The
 * steward's device then lists both in the console, newest first, beside the
 * entries they name.
 *
 * Every request the relay got is captured: none carries the group secret, a
 * member's name or key, or either person's personal Document, and neither
 * does any report or appeal the steward opens. The steward's inbox is named
 * (a control), and each opened box holds the words its sender typed.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf, openPadded } from '../crypto/door';
import { APPEAL_INFO, REPORT_INFO, stewardInboxOf } from '../crypto/shelf';
import { addressOf, newFrontDoor } from '../door/page';
import { fold } from '../engine/fold';
import { type FrontDoor, isFrontDoor } from '../engine/optIns';
import { createShelf, type Shelf } from '../net/shelf';
import { COVENANT_HASH } from '../shelf/covenant';
import { signNotice } from '../shelf/notices';
import { createShelfReader } from '../shelf/read';
import { signShelfBody } from '../shelf/record';
import { openAppeal, parseReport } from '../shelf/report';
import { nameSkeleton } from '../shelf/skeleton';
import { newPersonalId } from '../store/personal';
import { type TestDevice, testDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { createFakeShelf, release } from '../test/fakeShelf';
import { freshIndexedDBPerTest } from '../test/idb';
import { go, members, type MountedApp, mountApp } from '../test/members';
import { type Canary, findCanaries, keyCanaries, textCanary } from '../test/scan';
import { STEWARD_ADDRESS, TEST_STEWARD, TEST_STEWARD_SECRET } from '../test/steward';
import { messages } from './messages';
import { castBallot, proposeRules } from './proposals';

freshIndexedDBPerTest();

const NAMES = ['Anaquill', 'Benquill'];
const ANA_STATEMENT = 'Fair rents for every tenant, canary-490-ana.';
const KIM_STATEMENT = 'I fix bikes on Sundays, canary-490-kim.';
const APPEAL_NOTE = 'It was our own rally, appeal-490-note.';
const REPORT_NOTE = 'Not the real union, report-490-note.';
const HELD_ID = base64url(new Uint8Array(32).fill(4));
const SHOWN_ID = base64url(new Uint8Array(32).fill(5));
const words = messages.shelfEntry;

const mounted: MountedApp[] = [];
const opened: TestDevice[] = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  for (const device of opened.splice(0)) {
    device.services.sync.stop();
    device.services.store.close();
  }
  window.history.replaceState(null, '', '#/');
});

/** Mounts `services` at `hash`, unmounting whatever was mounted. */
function show(services: TestDevice['services'], hash: string, prefix: string) {
  for (const app of mounted.splice(0)) app.unmount();
  go(hash);
  const app = mountApp(services, prefix);
  mounted.push(app);
  return within(app.container);
}

/** Each device scores `proposalId` 4 and sends it, then every device syncs. */
async function everyoneVotes(devices: readonly TestDevice[], groupId: string, proposalId: string) {
  for (const device of devices) {
    const scores = { [proposalId]: 4 as const };
    await castBallot(device.services, groupId, { proposal: proposalId, scores, note: '' });
    await act(() => device.services.sync.syncOnce());
  }
  for (const device of devices) await act(() => device.services.sync.syncOnce());
}

/** The listed door the group's rules hold, read from a member's log. */
async function standingDoor(device: TestDevice, groupId: string): Promise<FrontDoor> {
  const group = await device.services.store.getGroup(groupId);
  const door = fold(group?.log ?? [], group?.relayNow ?? null).rules.optIns.frontDoor;
  if (!isFrontDoor(door)) throw new Error('Expected an open front door.');
  return door;
}

/** Saves a personal Document holding `text` on `device`. */
async function statement(device: TestDevice, text: string): Promise<void> {
  const at = Date.now();
  await device.services.store.savePersonal({
    id: newPersonalId(),
    title: 'What I stand for',
    text,
    createdAt: at,
    updatedAt: at,
  });
}

/** The group, its door listed by vote, on the shelf with two entries: one held, one shown. */
async function listedGroup(fake: FakeRelay) {
  const { groupId, devices } = await members(fake, NAMES);
  opened.push(...devices);
  const [ana] = devices;
  if (ana === undefined) throw new Error('Expected Ana.');
  const value = { ...newFrontDoor(false), listed: true, covenant: COVENANT_HASH };
  const proposed = await proposeRules(ana.services, groupId, {
    optIn: 'frontDoor',
    value,
    title: 'List our front door',
    why: 'So people can find us.',
    narrow: false,
  });
  if (proposed.outcome !== 'proposed') throw new Error('Expected a Proposal.');
  await act(() => ana.services.sync.syncOnce());
  await everyoneVotes(devices, groupId, proposed.proposalId);
  const door = await standingDoor(ana, groupId);
  const keys = doorKeysOf(fromBase64url(door.sign), fromBase64url(door.box)).signing;
  const address = base64url(addressOf(door));
  const shelfFake = createFakeShelf();
  const shelf = createShelf({ fetch: shelfFake.fetch });
  const name = 'Riverside Tenants';
  await shelf.put(
    address,
    signShelfBody(keys, {
      v: 1,
      kind: 'listing',
      open: true,
      name,
      skeleton: nameSkeleton(name),
      covenant: COVENANT_HASH,
    }),
  );
  await release(shelf, address);
  for (const [id, title] of [
    [HELD_ID, 'Rally Saturday'],
    [SHOWN_ID, 'Rent strike vote'],
  ] as const) {
    await shelf.put(address, signShelfBody(keys, { v: 1, kind: 'entry', id, title, text: '' }));
    // The relay takes one entry a day from a listing.
    shelfFake.minute += 1440;
  }
  const hold = { v: 1, kind: 'notice', act: 'hold', address, id: HELD_ID, clause: 'C2' } as const;
  await shelf.put(STEWARD_ADDRESS, signNotice(TEST_STEWARD.signing, hold));
  // A relay day passes, so every device shows the entry that isn't held.
  return { groupId, devices, door, address, shelf };
}

/** `device`'s services with a reader of `shelf`. */
const reading = (device: TestDevice, shelf: Shelf) => ({
  ...device.services,
  shelf: createShelfReader({ shelf, keep: device.services.store, now: () => 0 }),
});

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

/** Every canary a report or appeal must never carry: the group's secret, its members' names and keys, and both Documents. */
async function canariesOf(devices: readonly TestDevice[], groupId: string): Promise<Canary[]> {
  const found: Canary[] = [
    textCanary('Ana’s Document', ANA_STATEMENT),
    textCanary('Kim’s Document', KIM_STATEMENT),
    ...NAMES.map((name) => textCanary(`name ${name}`, name)),
  ];
  for (const device of devices) {
    const group = await device.services.store.getGroup(groupId);
    if (group === undefined) throw new Error('Expected the group.');
    found.push(
      ...keyCanaries('group secret', group.secret),
      ...keyCanaries('signing key', group.signingKey),
      ...keyCanaries('member key', fromBase64url(group.me.author)),
      ...(group.kxKey === undefined ? [] : keyCanaries('kx key', group.kxKey)),
    );
  }
  return found;
}

describe('reports and appeals through the app (#490)', { timeout: 60_000 }, () => {
  it('a member appeals, a reader reports, the steward lists both, and nothing names anyone', async () => {
    const fake = createFakeRelay();
    const { groupId, devices, door, address, shelf } = await listedGroup(fake);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana.');
    await statement(ana, ANA_STATEMENT);
    const user = userEvent.setup();
    const inbox = stewardInboxOf(TEST_STEWARD.box.publicKey);

    // Ana appeals the hold from Group home.
    const home = show(reading(ana, shelf), `#/g/${groupId}`, 'a');
    const held = await home.findByRole('region', { name: words.heldHeading });
    await user.click(within(held).getByRole('button', { name: words.appeal }));
    const appealDialog = await screen.findByRole('dialog', { name: words.appealTitle });
    await user.click(within(appealDialog).getByRole('textbox', { name: words.appealLabel }));
    await user.paste(APPEAL_NOTE);
    await user.click(within(appealDialog).getByRole('button', { name: words.send }));
    expect(await within(held).findByText(words.appealSent)).toBeVisible();

    // Kim, in no group, reports the entry that shows.
    const kim = await testDevice(fake, 'kim');
    opened.push(kim);
    await statement(kim, KIM_STATEMENT);
    fake.minute += 5;
    const page = show(reading(kim, shelf), `#/discover/${address}/${SHOWN_ID}`, 'k');
    await user.click(await page.findByRole('button', { name: words.report }));
    const reportDialog = await screen.findByRole('dialog', { name: words.reportTitle });
    await user.click(within(reportDialog).getByRole('radio', { name: /^C3:/ }));
    await user.click(within(reportDialog).getByRole('textbox', { name: words.noteLabel }));
    await user.paste(REPORT_NOTE);
    await user.click(within(reportDialog).getByRole('button', { name: words.send }));
    expect(await page.findByText(words.reportSent)).toBeVisible();

    // Each went as one 4,096-byte PUT to the steward's inbox, for 30 days, with no wake.
    const puts = fake.requests.filter((request) => request.url.includes(inbox));
    expect(puts.map((request) => [request.method, request.url, request.body?.length])).toEqual([
      ['PUT', `/v1/mailbox/${inbox}?ttl_days=30`, 4096],
      ['PUT', `/v1/mailbox/${inbox}?ttl_days=30`, 4096],
    ]);

    // The steward opens both: the appeal verifies under the door's address.
    const [appealBlob, reportBlob] = fake.blobs(inbox);
    const secret = TEST_STEWARD.box.secretKey;
    const appealPlain = openPadded(secret, appealBlob ?? new Uint8Array(), APPEAL_INFO, inbox);
    const reportPlain = openPadded(secret, reportBlob ?? new Uint8Array(), REPORT_INFO, inbox);
    if (appealPlain === null || reportPlain === null) throw new Error('Expected both to open.');
    expect(openAppeal(appealPlain)).toEqual({ address, id: HELD_ID, note: APPEAL_NOTE });
    expect(parseReport(reportPlain)).toEqual({
      address,
      id: SHOWN_ID,
      clause: 'C3',
      note: REPORT_NOTE,
    });
    expect(base64url(addressOf(door))).toBe(address);

    // No request, and nothing either box holds, carries a secret, a name, a key or a Document.
    const canaries = await canariesOf(devices, groupId);
    expect(leaks(fake, canaries)).toEqual([]);
    expect(findCanaries(appealPlain, canaries)).toEqual([]);
    expect(findCanaries(reportPlain, canaries)).toEqual([]);
    // The scan's controls: it finds what each sender typed in the box they sent.
    expect(findCanaries(appealPlain, [textCanary('appeal', APPEAL_NOTE)])).toContain(
      'appeal, as bytes',
    );
    expect(findCanaries(reportPlain, [textCanary('report', REPORT_NOTE)])).toContain(
      'report, as bytes',
    );

    // The steward's device lists both, newest first, beside what each names.
    const steward = await testDevice(fake, 'steward');
    opened.push(steward);
    await steward.services.store.keepStewardKey(TEST_STEWARD_SECRET, 0);
    const console = show({ ...reading(steward, shelf), stewardShelf: shelf }, '#/steward', 's');
    const section = await console.findByRole('region', {
      name: messages.shelfSteward.inboxHeading,
    });
    const items = await within(section).findAllByRole('listitem');
    const top = items.filter((item) => item.parentElement?.parentElement === section);
    expect(top.map((item) => within(item).getAllByRole('heading')[0]?.textContent)).toEqual([
      messages.shelfSteward.reportOf('impersonation of another group or person'),
      messages.shelfSteward.appealOf,
    ]);
    expect(
      within(section).getByText(messages.shelfSteward.aboutEntry('Rent strike vote')),
    ).toBeVisible();
    expect(
      within(section).getByText(messages.shelfSteward.aboutEntry('Rally Saturday')),
    ).toBeVisible();
    expect(await axeViolations()).toEqual([]);

    // The steward dismisses the report: it stays gone after a reload, and the inbox hears nothing.
    const asked = fake.requests.length;
    const [report] = top;
    if (report === undefined) throw new Error('Expected the report.');
    await user.click(within(report).getByRole('button', { name: messages.shelfSteward.dismiss }));
    await waitFor(() => {
      expect(within(section).queryByText(REPORT_NOTE)).toBeNull();
    });
    const sent = fake.requests.slice(asked).filter((request) => request.method !== 'GET');
    expect(sent.filter((request) => request.url.includes(inbox))).toEqual([]);
    const reloaded = show({ ...reading(steward, shelf), stewardShelf: shelf }, '#/steward', 's');
    const again = await reloaded.findByRole('region', {
      name: messages.shelfSteward.inboxHeading,
    });
    expect(await within(again).findByText(APPEAL_NOTE)).toBeVisible();
    expect(within(again).queryByText(REPORT_NOTE)).toBeNull();
  });
});
