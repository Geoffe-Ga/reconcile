/**
 * A coalition's room (#125) through the app on several devices and a fake
 * relay: Ana made the card from Riverside Tenants and Cy brought it to Oak St
 * Co-op, so both take part in Eastside Housing, and they write to each other
 * in its room; Ben, in Oak St but not taking part, reads the same messages in
 * the same order, and is offered Take part. A
 * device that holds only the coalition, as a follower's does (#124), finds no
 * room and holds no `inner`, and the relay never holds a word of it.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { deriveSealKey, deriveWeekMailboxId, weekOf } from '../crypto/groupKeys';
import { deriveRoomEntryId } from '../crypto/room';
import { BLOB_SIZES, xchachaSeal } from '../crypto/seal';
import { parseRecord } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { newEntry } from '../store/coalitions';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import {
  anaMakesCard,
  closeAll,
  coalitionOn,
  open,
  SLOW,
  syncAll,
  twoGroups,
  vote,
} from '../test/coalitionDevices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { findCanaries, keyCanaries, textCanary } from '../test/scan';
import { containsBytes, scanDb } from '../test/scanDb';
import { App } from './App';
import { messages } from './messages';
import { bringCard, takePart } from './reconcile';

freshIndexedDBPerTest();

afterEach(() => {
  cleanup();
  closeAll();
});

const { room } = messages;

/** Eastside Housing formed from Riverside and Oak St: Ana takes part as Mara Okafor, Cy as Jo. */
async function talking(fake: FakeRelay) {
  const groups = await twoGroups(fake);
  const { ana, ben, cy, riverside, oak } = groups;
  const { proposal, found: card } = await anaMakesCard(ana, cy, riverside, {
    name: 'Eastside Housing',
    statement: 'Everyone on the east side has a safe home.',
    why: 'We share a landlord.',
    yourName: 'Mara Okafor',
  });
  const brought = await bringCard(cy.services, card, oak, 'Jo');
  await syncAll(1);
  await vote(riverside, proposal, [ana, cy]);
  await vote(oak, brought, [ben, cy]);
  await syncAll();
  const coalition = await coalitionOn(ana);
  return { ...groups, coalition, id: coalition.group ?? '' };
}

/** The `inner` Riverside's reconcile Proposal carries, as Ana's device holds it. */
async function innerOf(device: TestDevice): Promise<Uint8Array> {
  const groups = await device.services.store.listGroups();
  for (const group of groups) {
    for (const { bytes } of group.log) {
      const event = parseRecord(bytes)?.event;
      if (event?.type === 'proposal' && 'target' in event.body) {
        const { target } = event.body;
        if (target.kind === 'reconcile') return fromBase64url(target.inner);
      }
    }
  }
  throw new Error('Expected a reconcile Proposal.');
}

/** Opens the coalition's room on `device`, as its home's link would. */
async function openRoom(device: TestDevice, id: string): Promise<HTMLElement> {
  cleanup();
  window.history.replaceState(null, '', `#/c/${id}/room`);
  render(<App services={device.services} />);
  return screen.findByRole('heading', { level: 1, name: 'Eastside Housing' });
}

/** Types `text` in the room's box on the open screen and sends it. */
async function write(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('textbox', { name: room.messageLabel }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: room.send }));
  await screen.findByText(text, { normalizer: (shown) => shown });
}

/** The messages the open room lists, as "name: text". */
function listed(): string[] {
  const list = screen.queryByRole('list', { name: room.listLabel });
  if (list === null) return [];
  return within(list)
    .getAllByRole('listitem')
    .map((item) => {
      const name = item.querySelector('.room-author')?.textContent ?? '';
      const text = item.querySelector('.room-text')?.textContent ?? '';
      return `${name}: ${text}`;
    });
}

/** Every byte a request carried: its URL, then its body. */
function sent(fake: FakeRelay): Uint8Array[] {
  return fake.requests.map((request) => {
    const url = new TextEncoder().encode(request.url);
    const body = request.body ?? new Uint8Array();
    const all = new Uint8Array(url.length + body.length);
    all.set(url);
    all.set(body, url.length);
    return all;
  });
}

describe('a coalition’s room', SLOW, () => {
  it('lets people from two groups write to each other, and every device shows the same messages in the same order', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, oak, id } = await talking(fake);

    await openRoom(ana, id);
    expect(screen.getByText(room.empty)).toBeVisible();
    await write('Can we meet Thursday?');
    await syncAll();

    await openRoom(cy, id);
    expect(listed()).toEqual(['Mara Okafor: Can we meet Thursday?']);
    await write('Thursday works for Oak St.\nAfter six.');
    await syncAll();

    const order = [
      'Mara Okafor: Can we meet Thursday?',
      'Jo: Thursday works for Oak St.\nAfter six.',
    ];
    for (const device of [cy, ana, ben]) {
      await openRoom(device, id);
      expect(listed()).toEqual(order);
    }
    // Ben is in Oak St but hasn't taken part: he reads, and is offered Take part first.
    expect(screen.getByText(room.takePartFirst)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: room.messageLabel })).toBeNull();
    expect(await axeViolations()).toEqual([]);

    const [entry] = await ben.services.store.listCoalitions();
    if (entry === undefined) throw new Error('Expected Ben’s coalition.');
    await takePart(ben.services, entry.groupId, oak, 'Ben O.');
    await syncAll();
    await openRoom(ben, id);
    await write('I can bring chairs.');
    await syncAll();
    await openRoom(ana, id);
    expect(listed()).toEqual([...order, 'Ben O.: I can bring chairs.']);
    expect(await axeViolations()).toEqual([]);
  });

  it('shows a message holding a script as text, and axe passes on the room', async () => {
    const fake = createFakeRelay();
    const { ana, cy, id } = await talking(fake);
    const script = '<script>document.title="pwned"</script><img src=x onerror=alert(1)>';

    await openRoom(ana, id);
    await write(script);
    await syncAll();
    await openRoom(cy, id);

    const text = screen.getByText(script, { normalizer: (shown) => shown });
    expect(text.tagName).toBe('BDI');
    expect(text.childElementCount).toBe(0);
    expect(document.querySelector('main img, main script')).toBeNull();
    expect(document.title).toBe('Room · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('never shows the room to a device that holds only the coalition, which holds no inner', async () => {
    const fake = createFakeRelay();
    const { ana, id } = await talking(fake);
    await openRoom(ana, id);
    await write('For members only.');
    await syncAll();
    const [held] = await ana.services.store.listCoalitions();
    if (held === undefined) throw new Error('Expected Ana’s coalition.');

    // A follower's device (#124): the coalition's secret and log, and no member group.
    const fay = await open(fake, 'fay');
    await fay.services.store.addGroup(newEntry(held.secret));
    await syncAll();
    const state: GroupState = await coalitionOn(fay);
    expect(state.group).toBe(id);
    expect(await fay.services.store.listRooms()).toEqual([]);

    cleanup();
    window.history.replaceState(null, '', `#/c/${id}`);
    render(<App services={fay.services} />);
    await screen.findByRole('heading', { level: 1, name: 'Eastside Housing' });
    expect(screen.queryByRole('region', { name: room.homeTitle })).toBeNull();
    expect(screen.queryByRole('link', { name: /Open the room/ })).toBeNull();

    cleanup();
    window.history.replaceState(null, '', `#/c/${id}/room`);
    render(<App services={fay.services} />);
    expect(await screen.findByRole('heading', { name: room.missingTitle })).toBeVisible();
    expect(screen.queryByText('For members only.')).toBeNull();
    expect(await axeViolations()).toEqual([]);

    const inner = await innerOf(ana);
    const held2 = await scanDb('fay');
    expect(containsBytes(held2.bytes, inner)).toBe(false);
    expect(held2.text).not.toContain(base64url(inner));
    expect(held2.text).not.toContain('For members only.');
    // The control: Ana's device holds it, in her group's reconcile Proposal.
    expect((await scanDb('ana')).text).toContain(base64url(inner));
  });

  it('sends the relay nothing it can read: a canary message is in no request, and every blob is a bucket size', async () => {
    const fake = createFakeRelay();
    const { ana, cy, id } = await talking(fake);
    const canary = 'CANARY-ROOM-0c51d2';
    const before = fake.requests.length;

    await openRoom(ana, id);
    await write(`${canary} Thursday?`);
    await syncAll();
    await openRoom(cy, id);
    expect(listed()).toEqual([`Mara Okafor: ${canary} Thursday?`]);

    const inner = await innerOf(ana);
    const [roomEntry] = await ana.services.store.listRooms();
    const canaries = [
      textCanary('the message', canary),
      textCanary('Ana’s coalition name', 'Mara Okafor'),
      ...keyCanaries('inner', inner),
      ...keyCanaries('the room’s seal key', deriveSealKey(inner)),
      ...keyCanaries('the room’s entry id', fromBase64url(deriveRoomEntryId(inner))),
      ...keyCanaries('the coalition key', roomEntry?.signingKey ?? new Uint8Array(32)),
    ];
    const leaks = sent(fake).flatMap((bytes) => findCanaries(bytes, canaries));
    expect(leaks).toEqual([]);
    const puts = fake.requests.slice(before).filter((r) => r.method === 'PUT');
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((r) => (BLOB_SIZES as readonly number[]).includes(r.body?.length ?? 0))).toBe(
      true,
    );

    // The controls: the room's mailbox holds the blob, and only inner's keys open it.
    const mailbox = deriveWeekMailboxId(inner, weekOf(fake.minute));
    const [blob] = fake.blobs(mailbox);
    expect(puts.some((r) => r.url.includes(mailbox))).toBe(true);
    const opened = xchachaSeal.open(mailbox, deriveSealKey(inner), blob ?? new Uint8Array());
    expect(findCanaries(opened ?? new Uint8Array(), [textCanary('the message', canary)])).toEqual([
      'the message, as bytes',
    ]);
  });
});
