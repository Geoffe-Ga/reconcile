/**
 * A coalition's room (#125) through the app on several devices and a fake
 * relay: Ana made the card from Riverside Tenants and Cy brought it to Oak St
 * Co-op, so both take part in Eastside Housing, and they write to each other
 * in its room; Ben, in Oak St but not taking part, reads the same messages in
 * the same order, and is offered Take part. A
 * device that holds only the coalition, as a follower's does (#124), finds no
 * room and holds no `inner`, and the relay never holds a word of it.
 *
 * Then Dee's Elm Row asks in with a card Ana makes from Riverside's row
 * (#313). That card carries no `inner`, so while the coalition decides,
 * nothing on Dee's device opens a room message, those written before the
 * card and during the vote alike. Once Elm Row is seated, a participant from
 * a seated group wraps `inner` to its seat, and Dee reads the room and
 * writes in it.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { type Card, parseCardLink } from '../coalition/card';
import { base64url, fromBase64url } from '../crypto/base64url';
import {
  deriveSealKey,
  deriveWeekMailboxId,
  GROUP_SECRET_BYTES,
  weekOf,
} from '../crypto/groupKeys';
import { deriveRoomEntryId, wrapInner } from '../crypto/room';
import { BLOB_SIZES, xchachaSeal } from '../crypto/seal';
import { HORIZON_STEP_MINUTES } from '../engine/coalition';
import { parseRecord, signEvent } from '../engine/event';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import { newEntry } from '../store/coalitions';
import type { TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import {
  anaMakesCard,
  closeAll,
  coalitionOn,
  found,
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
import { admitCard, bringCard, lookupCard, postCard, takePart } from './reconcile';

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

/** The `inner` a founding group's reconcile Proposal on `device` carries, as Ana's Riverside's does. */
async function innerOf(device: TestDevice): Promise<Uint8Array> {
  const groups = await device.services.store.listGroups();
  for (const group of groups) {
    for (const { bytes } of group.log) {
      const event = parseRecord(bytes)?.event;
      if (event?.type === 'proposal' && 'target' in event.body) {
        const { target } = event.body;
        if (target.kind === 'reconcile' && 'inner' in target) {
          return fromBase64url(target.inner);
        }
      }
    }
  }
  throw new Error('Expected a reconcile Proposal with inner.');
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

/** Relay time an hour past a vote's level-1 horizon, a day after its deadline, by which every pass on it is final (#387). */
const PAST_FINAL = DEFAULT_RULES.windows.ordinary.default * DAY_MINUTES + HORIZON_STEP_MINUTES + 60;

const BEFORE = 'CANARY-BEFORE-313 Should we let Elm Row in?';
const DURING = 'CANARY-DURING-313 Their landlord is ours too.';

/**
 * Eastside Housing formed, with Mara's message in its room; then Dee's Elm
 * Row brings a card Ana makes from Riverside's row, passes its own vote, and
 * its admit motion is up. `change` alters the card before it's posted.
 */
async function elmRowAsks(fake: FakeRelay, change: (card: Card) => Card = (card) => card) {
  const groups = await talking(fake);
  const { ana, riverside, id } = groups;
  await openRoom(ana, id);
  await write(BEFORE);
  // Unmounted, so no sync the screen starts runs beside the ones the test steps through.
  cleanup();
  await syncAll();

  const dee = await open(fake, 'dee');
  const elm = await found(dee, 'Elm Row', 'Dee');
  const [entry] = await ana.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected Ana’s coalition.');
  const card = await admitCard(ana.services, entry.groupId, riverside);
  const seed = parseCardLink(await postCard(ana.services, change(card), ana.services.origin));
  const lookup = await lookupCard(dee.services, seed ?? new Uint8Array());
  if (lookup.kind !== 'found') throw new Error(`Expected the card to open, not ${lookup.kind}.`);
  const proposal = await bringCard(dee.services, lookup.found, elm, 'Dee M.');
  await syncAll(1);
  await vote(elm, proposal, [dee]);
  await syncAll();
  const motion = (await coalitionOn(ana)).proposals.find((p) => p.target.kind === 'admit');
  if (motion === undefined) throw new Error('Expected the admit motion.');
  return { ...groups, card, found: lookup.found, dee, elm, motion: motion.id };
}

/** Every room blob the relay holds for `inner` in the last 5 weeks, each with its mailbox. */
function roomBlobs(fake: FakeRelay, inner: Uint8Array) {
  const week = weekOf(fake.minute);
  return [4, 3, 2, 1, 0].flatMap((back) => {
    const mailbox = deriveWeekMailboxId(inner, week - back);
    return fake.blobs(mailbox).map((blob) => ({ mailbox, blob }));
  });
}

/**
 * Every 32 bytes a device's database holds that could be a secret: each
 * 32-byte array, and each run of 43 base64url characters in its text, which
 * is how a log's records spell a key.
 */
function secretsIn(held: { text: string; bytes: Uint8Array[] }): Uint8Array[] {
  const raw = held.bytes.filter((bytes) => bytes.length === GROUP_SECRET_BYTES);
  const spelled = [...held.text.matchAll(/[A-Za-z0-9_-]{43}/g)].map(([text]) =>
    fromBase64url(text),
  );
  return [...raw, ...spelled];
}

/** Whether `blob` opens under the seal key `key` in `mailbox`. */
function opens(mailbox: string, key: Uint8Array, blob: Uint8Array): boolean {
  return xchachaSeal.open(mailbox, key, blob) !== null;
}

/**
 * Shows Dee's device can't read the room, whose messages are `written`: it
 * keeps no room and holds no inner or message, no secret it holds opens any
 * of the room's blobs, and the room's address shows no room.
 */
async function expectShut(
  fake: FakeRelay,
  dee: TestDevice,
  { inner, id, written }: { inner: Uint8Array; id: string; written: readonly string[] },
) {
  expect(await dee.services.store.listRooms()).toEqual([]);
  const held = await scanDb('dee');
  expect(containsBytes(held.bytes, inner)).toBe(false);
  expect(held.text).not.toContain(base64url(inner));
  for (const text of written) expect(held.text).not.toContain(text);

  const blobs = roomBlobs(fake, inner);
  const candidates = secretsIn(held);
  // The controls: the room holds every message, which inner's seal key opens, and the scan
  // reads what Dee holds, the coalition secret and Elm Row's group secret among it.
  expect(blobs.length).toBeGreaterThanOrEqual(written.length);
  for (const { mailbox, blob } of blobs)
    expect(opens(mailbox, deriveSealKey(inner), blob)).toBe(true);
  const [entry] = await dee.services.store.listCoalitions();
  const [elm] = await dee.services.store.listGroups();
  for (const known of [entry?.secret, elm?.secret]) {
    const spelled = base64url(known ?? new Uint8Array());
    expect(candidates.some((secret) => base64url(secret) === spelled)).toBe(true);
  }
  expect(candidates.length).toBeGreaterThan(20);
  const opened = candidates.filter((secret) =>
    blobs.some(({ mailbox, blob }) => opens(mailbox, deriveSealKey(secret), blob)),
  );
  expect(opened).toEqual([]);

  cleanup();
  window.history.replaceState(null, '', `#/c/${id}/room`);
  render(<App services={dee.services} />);
  expect(await screen.findByRole('heading', { name: room.missingTitle })).toBeVisible();
  expect(screen.queryByText(BEFORE)).toBeNull();
}

/**
 * Posts, as `device`'s participant in the coalition `id`, a wrap to `seat`
 * of a room of their own: a forged `inner` the genesis doesn't commit to,
 * sealed to the seat's key as an honest wrap is (#371). Returns its author
 * and the forged `inner`.
 */
async function forgeWrap(
  fake: FakeRelay,
  device: TestDevice,
  id: string,
  seat: { readonly key: string; readonly kx: string },
) {
  const [entry] = await device.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected the coalition.');
  const forged = new Uint8Array(GROUP_SECRET_BYTES).fill(0x6b);
  const wrap = wrapInner({ coalitionId: id, seat: seat.key, kx: seat.kx, inner: forged });
  const draft = { type: 'room-wrap', group: id, ts: 0, body: { seat: seat.key, wrap } } as const;
  const { record } = signEvent(entry.signingKey, draft);
  const mailbox = deriveWeekMailboxId(entry.secret, weekOf(fake.minute));
  const sealed = xchachaSeal.seal(mailbox, deriveSealKey(entry.secret), record);
  await device.services.relay.putBlob(mailbox, sealed, 30);
  return { author: entry.me.author, forged };
}

describe('a group asking into a coalition, and its room (#313)', SLOW, () => {
  it('can’t open the room’s messages from before or during its admission vote, and reads the room once seated', async () => {
    const fake = createFakeRelay();
    const {
      ana,
      ben,
      cy,
      dee,
      riverside,
      oak,
      id,
      card,
      found: brought,
      motion,
    } = await elmRowAsks(fake);
    expect(card.inner).toBeUndefined();
    expect(brought.card.inner).toBeUndefined();

    // During the vote the seated groups talk about it in the room, and both pass it.
    await openRoom(cy, id);
    await write(DURING);
    cleanup();
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    // Three rounds: a group's result goes once a pass has read its closing ballot.
    await syncAll(3);
    const results = (await coalitionOn(dee)).coalition?.results.filter((r) => r.motion === motion);
    expect(results?.map((r) => r.result)).toEqual(['pass', 'pass']);
    const inner = await innerOf(ana);
    // Every seat has passed, but the pass is final only a day after the deadline (#387).
    expect((await coalitionOn(dee)).coalition?.seats).toHaveLength(2);
    await expectShut(fake, dee, { inner, id, written: [BEFORE, DURING] });

    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll(3);

    const coalition = (await coalitionOn(dee)).coalition;
    expect(coalition?.seats.map((seat) => seat.name)).toEqual([
      'Riverside Tenants',
      'Oak St Co-op',
      'Elm Row',
    ]);
    // One wrap from each seated group, each sealed to Elm Row's seat.
    const [river, oakSeat, elmSeat] = coalition?.seats.map((seat) => seat.key) ?? [];
    expect(coalition?.wraps.map((w) => [w.from, w.seat])).toEqual([
      [river, elmSeat],
      [oakSeat, elmSeat],
    ]);
    await openRoom(dee, id);
    expect(listed()).toEqual([`Mara Okafor: ${BEFORE}`, `Jo: ${DURING}`]);
    await write('Thank you. Elm Row is glad to be here.');
    await syncAll();
    await openRoom(ana, id);
    expect(listed()).toEqual([
      `Mara Okafor: ${BEFORE}`,
      `Jo: ${DURING}`,
      'Dee M.: Thank you. Elm Row is glad to be here.',
    ]);
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Reconcile with another coalition only once a wrap gives the device inner (#122)', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, dee, elm, riverside, oak, id, motion } = await elmRowAsks(fake);
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    await syncAll(3);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    // Only Dee's device syncs: Elm Row takes its seat and Dee joins, but no one has wrapped yet.
    for (let pass = 0; pass < 3; pass += 1) await dee.services.sync.syncOnce();
    const seated = (await coalitionOn(dee)).coalition;
    expect(seated?.seats).toHaveLength(3);
    expect(seated?.bindings).toHaveLength(3);
    expect(seated?.wraps).toEqual([]);
    const link = { name: /Reconcile with another coalition/ };

    cleanup();
    window.history.replaceState(null, '', `#/g/${elm}`);
    render(<App services={dee.services} />);
    const rows = await screen.findByRole('region', { name: 'Coalitions' });
    expect(within(rows).getByRole('link', { name: /Open the coalition/ })).toBeVisible();
    expect(within(rows).queryByRole('link', link)).toBeNull();
    cleanup();
    window.history.replaceState(null, '', `#/c/${id}/reconcile`);
    render(<App services={dee.services} />);
    expect(await screen.findByText(messages.card.coalitionKeyWaits)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(await axeViolations()).toEqual([]);
    cleanup();

    // Once a seated group's device wraps inner to Elm Row's seat, both open.
    await syncAll(3);
    expect((await coalitionOn(dee)).coalition?.wraps).toHaveLength(2);
    window.history.replaceState(null, '', `#/g/${elm}`);
    render(<App services={dee.services} />);
    const after = await screen.findByRole('region', { name: 'Coalitions' });
    expect(await within(after).findByRole('link', link)).toBeVisible();
    cleanup();
    window.history.replaceState(null, '', `#/c/${id}/reconcile`);
    render(<App services={dee.services} />);
    const name = await screen.findByRole('textbox', { name: messages.card.nameLabel });
    expect(name).toBeVisible();
    expect(screen.queryByText(messages.card.coalitionKeyWaits)).toBeNull();
  });

  it('refuses a seated participant’s wrap of a room of their own, takes an honest one after it, and reads the real room (#371)', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, dee, riverside, oak, id, motion } = await elmRowAsks(fake);
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy]);
    await syncAll(3);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    // Dee's device alone syncs: Elm Row takes its seat, and Dee joins under it.
    for (let pass = 0; pass < 3; pass += 1) await dee.services.sync.syncOnce();
    const [elmSeat] = (await coalitionOn(dee)).coalition?.admitted ?? [];
    if (elmSeat === undefined) throw new Error('Expected Elm Row’s seat.');

    // Cy, seated through Oak St, wraps a room of his own to Elm Row's seat before anyone else.
    const { author, forged } = await forgeWrap(fake, cy, id, elmSeat);
    for (let pass = 0; pass < 2; pass += 1) await dee.services.sync.syncOnce();
    expect((await coalitionOn(dee)).coalition?.wraps.map((w) => w.by)).toEqual([author]);
    // The wrap opens with Elm Row's seat secret, but its inner isn't the one the genesis commits to.
    expect(await dee.services.store.listRooms()).toEqual([]);

    await syncAll(3);
    const inner = await innerOf(ana);
    const wraps = (await coalitionOn(dee)).coalition?.wraps ?? [];
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(wraps[0]?.by).toBe(author);
    const rooms = await dee.services.store.listRooms();
    expect(rooms.map((held) => held.groupId)).toEqual([deriveRoomEntryId(inner)]);
    expect(rooms.map((held) => held.groupId)).not.toContain(deriveRoomEntryId(forged));
    await openRoom(dee, id);
    expect(listed()).toEqual([`Mara Okafor: ${BEFORE}`]);
    await write('Elm Row reads the room everyone else does.');
    await syncAll();
    await openRoom(ana, id);
    expect(listed()).toEqual([
      `Mara Okafor: ${BEFORE}`,
      'Dee M.: Elm Row reads the room everyone else does.',
    ]);
  });

  it('never opens the room to a group the coalition didn’t admit: no wrap is made for it', async () => {
    const fake = createFakeRelay();
    const { ana, ben, cy, dee, riverside, oak, id, motion } = await elmRowAsks(fake);
    await vote(riverside, motion, [ana, cy]);
    await vote(oak, motion, [ben, cy], 0);
    await syncAll(3);
    act(() => {
      fake.minute += PAST_FINAL;
    });
    await syncAll(3);

    const coalition = (await coalitionOn(dee)).coalition;
    expect(coalition?.seats).toHaveLength(2);
    expect(coalition?.wraps).toEqual([]);
    await expectShut(fake, dee, { inner: await innerOf(ana), id, written: [BEFORE] });
  });

  it('keeps no inner from a card that carries one anyway, as an older app’s would', async () => {
    const fake = createFakeRelay();
    const leaked = new Uint8Array(32).fill(0x5a);
    const {
      dee,
      elm,
      found: brought,
    } = await elmRowAsks(fake, (card) => ({
      ...card,
      inner: leaked,
    }));
    expect(brought.card.inner).toEqual(leaked);

    const group = await dee.services.store.getGroup(elm);
    const reconcile = [...(group?.log ?? []).map((r) => r.bytes), ...(group?.outbox ?? [])]
      .map((bytes) => parseRecord(bytes)?.event)
      .find((event) => event?.type === 'proposal' && 'target' in event.body);
    expect(reconcile?.body).toMatchObject({ target: { kind: 'reconcile' } });
    expect(JSON.stringify(reconcile?.body)).not.toContain('"inner"');
    const held = await scanDb('dee');
    expect(containsBytes(held.bytes, leaked)).toBe(false);
    expect(held.text).not.toContain(base64url(leaked));
  });
});
