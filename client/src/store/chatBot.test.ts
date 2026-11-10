/**
 * The chat bot through the sync loop (#119; docs/spec/phase-1-spec.md §4,
 * Chat bot): devices on one fake relay, each posting to one fake Discord
 * endpoint (src/test/fakeDiscord.ts), so nothing reaches the network. With
 * the bot on, each moment of a Proposal reaches Discord exactly once across
 * every device, two devices holding one key included; with it off, narrowed,
 * or the device leaving, nothing does. A canary in every field of the group
 * shows no post carries anything but the fixed line and the app's address,
 * and the webhook never reaches the relay readable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { type EventBodies, type EventType, signEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { postWebhook } from '../net/discord';
import { TEST_NOW, testDevice, type TestDevice } from '../test/appServices';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { FOUNDING, joinLater, members } from '../test/members';
import { createChatBot } from './chatBot';
import { eventIdOf } from './eventId';
import { channelOf, createSync, openRecords } from './sync';

freshIndexedDBPerTest();

const DAY = 1_440;
const ID = '1199000000000000001';
const TOKEN = 'sEcReT-tokenWXYZ';
const WEBHOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
/** The relay minute the group starts at: Fri 7 Nov 2025, 07:20 UTC. */
const START = 29_375_000;
/** When the Proposal under test opens, so its deadline is Fri 14 Nov 2025, 12:00 UTC. */
const PROPOSED = 29_375_280;
const DEADLINE = PROPOSED + 7 * DAY;
const ORIGIN = 'https://reconcile.test/';
/** A canary in every field of the Proposal under test. */
const CANARY = { title: 'CANARY-title', why: 'CANARY-why', text: 'CANARY-atom' };

const NOTICES = {
  open: `A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.\n${ORIGIN}`,
  closing: `A vote closes within a day in Reconcile.\n${ORIGIN}`,
  result: `A vote has finished in Reconcile.\n${ORIGIN}`,
};

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
  vi.restoreAllMocks();
});

/** What a post said, as Discord would read it. */
function bodies(fake: FakeRelay): unknown[] {
  return fake.discord.requests.map((request) => request.body);
}

/** The body Discord gets for `content`. */
function posted(content: string) {
  return { content, allowed_mentions: { parse: [] } };
}

/** An event a test device says: its type and body, the group and time added by {@link say}. */
type Said = { [K in EventType]: { readonly type: K; readonly body: EventBodies[K] } }[EventType];

/** `device` signs `draft` with its key in `groupId` and queues it, without syncing. */
async function say(device: TestDevice, groupId: string, draft: Said): Promise<string> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  const event = signEvent(group.signingKey, { ...draft, group: groupId, ts: TEST_NOW });
  await device.services.store.enqueue(groupId, event.record);
  return event.id;
}

/** Every device syncs once, in order. */
async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) await device.services.sync.syncOnce();
}

/** Every device syncs `times` times. */
async function syncRounds(devices: readonly TestDevice[], times = 3): Promise<void> {
  for (let round = 0; round < times; round += 1) await syncAll(devices);
}

/** Ana and Ben's group on `fake`, at {@link START}. */
async function group(fake: FakeRelay, names: readonly string[] = ['Ana', 'Ben']) {
  const { groupId, devices } = await members(fake, names);
  opened.push(...devices);
  return { groupId, devices };
}

/** Everyone in `devices` votes the chat bot on, which closes the vote early, and syncs. */
async function turnBotOn(devices: readonly TestDevice[], groupId: string): Promise<string> {
  const [founder] = devices;
  if (founder === undefined) throw new Error('Expected a founder.');
  const on = await say(founder, groupId, {
    type: 'proposal',
    body: {
      target: { kind: 'rules', optIn: 'chatBot', value: { webhook: WEBHOOK } },
      title: 'Turn on the Discord chat bot',
      why: 'Nudges.',
    },
  });
  await syncAll(devices);
  for (const device of devices) {
    await say(device, groupId, { type: 'vote', body: { proposal: on, scores: { [on]: 4 } } });
    await device.services.sync.syncOnce();
  }
  return on;
}

/** Ana proposes the canary edit on the first Atom at {@link PROPOSED}. */
async function proposeCanary(fake: FakeRelay, ana: TestDevice, groupId: string) {
  fake.minute = PROPOSED;
  return say(ana, groupId, {
    type: 'proposal',
    body: { atom: `${groupId}.0`, ...CANARY },
  });
}

/** True when `needle`'s bytes appear anywhere in `haystack`. */
function holds(haystack: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle);
  for (let at = 0; at + bytes.length <= haystack.length; at += 1) {
    if (bytes.every((byte, i) => haystack[at + i] === byte)) return true;
  }
  return false;
}

/** Every relay request that carries the webhook, or any part of it, readable. */
function relayLeaks(fake: FakeRelay): string[] {
  return fake.requests.flatMap((request) =>
    [WEBHOOK, TOKEN, ID]
      .filter(
        (part) =>
          request.url.includes(part) || (request.body !== null && holds(request.body, part)),
      )
      .map((part) => `${request.method} ${request.url}: ${part}`),
  );
}

/** A store-level copy of `device`'s membership on a second device: one key, two devices (#78). */
async function sameKeyDevice(fake: FakeRelay, device: TestDevice, groupId: string, name: string) {
  const kept = await device.services.store.getGroup(groupId);
  if (kept === undefined) throw new Error('Expected the group on the first device.');
  const twin = await testDevice(fake, name);
  opened.push(twin);
  const { secret, signingKey, me } = kept;
  await twin.services.store.addGroup({ groupId, secret, signingKey, me });
  await twin.services.sync.syncOnce();
  return twin;
}

describe('the chat bot, with the bot on', () => {
  it('posts the result of the vote that turned it on, once, as the fixed line and the app’s address', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);

    await turnBotOn(devices, groupId);
    await syncRounds(devices);

    expect(bodies(fake)).toEqual([posted(NOTICES.result)]);
    expect(fake.discord.requests.map((request) => request.url)).toEqual([WEBHOOK]);
  });

  it('posts a new Proposal, its last day and its result exactly once each across both devices, with nothing of the group in them', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    fake.discord.requests.length = 0;

    await proposeCanary(fake, ana, groupId);
    await syncRounds(devices);
    expect(bodies(fake)).toEqual([posted(NOTICES.open)]);

    fake.minute = DEADLINE - DAY - 1;
    await syncRounds(devices);
    expect(bodies(fake)).toHaveLength(1);

    fake.minute = DEADLINE - DAY;
    await syncRounds(devices);
    expect(bodies(fake)).toEqual([posted(NOTICES.open), posted(NOTICES.closing)]);

    fake.minute = DEADLINE;
    await syncRounds(devices);
    fake.minute = DEADLINE + 2 * DAY;
    await syncRounds(devices);
    expect(bodies(fake)).toEqual([
      posted(NOTICES.open),
      posted(NOTICES.closing),
      posted(NOTICES.result),
    ]);

    const everything = JSON.stringify(fake.discord.requests);
    const kept = await ana.services.store.getGroup(groupId);
    const names =
      kept === undefined ? [] : fold(kept.log, kept.relayNow).members.map((m) => m.name);
    expect(names).toEqual(['Ana', 'Ben']);
    for (const canary of [...Object.values(CANARY), FOUNDING.groupName, FOUNDING.title, ...names]) {
      expect(everything).not.toContain(canary);
    }
    for (const section of FOUNDING.text.split('\n\n')) expect(everything).not.toContain(section);
    expect(fake.discord.requests.every((request) => request.url === WEBHOOK)).toBe(true);
    expect(relayLeaks(fake)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    const lines = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    for (const part of [TOKEN, ID]) expect(lines).not.toContain(part);
  });

  it('posts each moment once when two devices hold one key and race in the same millisecond', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana, ben] = devices;
    if (ana === undefined || ben === undefined) throw new Error('Expected two devices.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    const twin = await sameKeyDevice(fake, ana, groupId, 'ana-phone');
    fake.discord.requests.length = 0;

    fake.minute = PROPOSED;
    await say(ben, groupId, {
      type: 'proposal',
      body: { atom: `${groupId}.1`, title: 'Bins', why: 'Smell.', text: 'Bins out on Monday.' },
    });
    await ben.services.sync.syncOnce();
    for (const minute of [PROPOSED, DEADLINE - DAY, DEADLINE]) {
      fake.minute = minute;
      await syncRounds([ana, twin]);
    }

    expect(bodies(fake)).toEqual([
      posted(NOTICES.open),
      posted(NOTICES.closing),
      posted(NOTICES.result),
    ]);
  });

  it('tries a post Discord refuses or never answers once, and never again', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    fake.discord.status = 500;
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    fake.minute += 60;
    await syncRounds(devices);
    expect(bodies(fake)).toEqual([posted(NOTICES.result)]);

    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    fake.discord.offline = true;
    await proposeCanary(fake, ana, groupId);
    await syncRounds(devices);
    fake.minute += 60;
    await syncRounds(devices);
    expect(bodies(fake)).toEqual([posted(NOTICES.result), posted(NOTICES.open)]);
    expect(await Promise.all(devices.map((device) => device.services.sync.syncOnce()))).toEqual([
      true,
      true,
    ]);
  });
});

describe('the chat bot posts nothing', () => {
  it('while the bot is off', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');

    await proposeCanary(fake, ana, groupId);
    for (const minute of [PROPOSED, DEADLINE - DAY, DEADLINE]) {
      fake.minute = minute;
      await syncRounds(devices);
    }

    expect(fake.discord.requests).toEqual([]);
    const kept = await ana.services.store.getGroup(groupId);
    expect(kept?.chatClaims ?? []).toEqual([]);
  });

  it('while a steward’s narrowing holds the bot off, for a new Proposal or for the off-Proposal itself', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    fake.discord.requests.length = 0;

    const off = await say(ana, groupId, {
      type: 'proposal',
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: null },
        title: 'Turn off the Discord chat bot',
        why: 'The webhook leaked.',
      },
    });
    await say(ana, groupId, { type: 'narrow', body: { optIn: 'chatBot', proposal: off } });
    await syncRounds(devices);
    await proposeCanary(fake, ana, groupId);
    for (const minute of [PROPOSED, DEADLINE - DAY - 1]) {
      fake.minute = minute;
      await syncRounds(devices);
    }

    expect(fake.discord.requests).toEqual([]);
  });

  it('for a result a device first syncs two days after, nor for a joiner then', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana, ben] = devices;
    if (ana === undefined || ben === undefined) throw new Error('Expected two devices.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    await proposeCanary(fake, ana, groupId);
    await syncRounds(devices);
    fake.discord.requests.length = 0;

    fake.minute = DEADLINE + 2 * DAY;
    await syncRounds(devices);
    const cal = await joinLater(fake, ana, groupId, 'Cal');
    opened.push(cal);
    await syncRounds([cal, ...devices]);

    expect(fake.discord.requests).toEqual([]);
  });

  it('from a device leaving the group, even for a claim it won', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana, ben] = devices;
    if (ana === undefined || ben === undefined) throw new Error('Expected two devices.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    await proposeCanary(fake, ana, groupId);
    await ana.services.sync.syncOnce();
    fake.discord.requests.length = 0;

    await ana.services.store.markLeaving(groupId, await leaveOf(ana, groupId));
    await ana.services.sync.syncOnce();
    await syncRounds([ben]);

    expect(await ana.services.store.getGroup(groupId)).toBeUndefined();
    expect(fake.discord.requests).toEqual([]);
  });
});

/** Reads `groupId`'s new records into `device`'s store as a sync pass would, posting none of its outbox. */
async function pullOnly(device: TestDevice, groupId: string): Promise<void> {
  const { store, relay } = device.services;
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  const channel = channelOf(group.secret);
  const page = await relay.getBlobs(channel.mailbox, group.cursor);
  const records = openRecords(xchachaSeal, channel, page.records);
  const cursor = page.records.at(-1)?.seq ?? group.cursor;
  const { now: relayNow, instance } = page;
  await store.applyPull(
    groupId,
    { records, cursor, relayNow, instance, lastSyncAt: TEST_NOW },
    eventIdOf,
  );
}

/** `device`'s signed `leave` of `groupId`, not yet queued. */
async function leaveOf(device: TestDevice, groupId: string): Promise<Uint8Array> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  return signEvent(group.signingKey, { type: 'leave', group: groupId, ts: TEST_NOW, body: {} })
    .record;
}

describe('createChatBot over one store', () => {
  /** Ana's group with the bot on and her winning claim of a new Proposal's opening folded, not yet posted. */
  async function wonButUnposted() {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    await proposeCanary(fake, ana, groupId);
    await ana.services.sync.syncOnce();
    // A sync loop with no bot sends the claim and reads it back, so it wins without being posted.
    const { store, relay } = ana.services;
    await createSync({ store, relay, seal: xchachaSeal }).syncOnce();
    fake.discord.requests.length = 0;
    const bot = () =>
      createChatBot({
        store,
        post: (webhook, content) => postWebhook(webhook, content, fake.discord.fetch),
        notice: (moment) => moment,
      });
    return { fake, groupId, ana, bot };
  }

  it('posts a claim it won once, even when two tabs settle it at once', async () => {
    const { fake, groupId, bot } = await wonButUnposted();

    await Promise.all([bot().run(groupId), bot().run(groupId)]);
    await bot().run(groupId);

    expect(bodies(fake)).toEqual([posted('open')]);
  });

  it('posts nothing once the group is leaving this device', async () => {
    const { fake, groupId, ana, bot } = await wonButUnposted();

    await ana.services.store.markLeaving(groupId, await leaveOf(ana, groupId));
    await bot().run(groupId);

    expect(fake.discord.requests).toEqual([]);
    expect((await ana.services.store.getGroup(groupId))?.chatClaims).toHaveLength(1);
  });

  it('holds a claim it won while a steward’s narrowing holds the bot off, and posts it if the bot comes back on while the moment is still due', async () => {
    const { fake, groupId, ana, bot } = await wonButUnposted();
    const { store, relay } = ana.services;
    const quiet = createSync({ store, relay, seal: xchachaSeal });
    const off = await say(ana, groupId, {
      type: 'proposal',
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: null },
        title: 'Turn off the Discord chat bot',
        why: 'The webhook leaked.',
        window: 3,
      },
    });
    await say(ana, groupId, { type: 'narrow', body: { optIn: 'chatBot', proposal: off } });
    await quiet.syncOnce();
    const running = bot();

    await running.run(groupId);
    expect(fake.discord.requests).toEqual([]);
    expect((await store.getGroup(groupId))?.chatClaims).toHaveLength(1);

    // Nobody votes, so the off-Proposal lapses after 3 days and the bot is back on.
    fake.minute = PROPOSED + 3 * DAY;
    await quiet.syncOnce();
    await running.run(groupId);
    await running.run(groupId);
    expect(bodies(fake)).toEqual([posted('open')]);
  });

  it('drops a claim still on its way, posting nothing, once another device’s claim has won', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);
    const [ana, ben] = devices;
    if (ana === undefined || ben === undefined) throw new Error('Expected two devices.');
    await turnBotOn(devices, groupId);
    await syncRounds(devices);
    await proposeCanary(fake, ana, groupId);
    await ana.services.sync.syncOnce();
    await syncRounds([ben], 2);
    expect(bodies(fake).at(-1)).toEqual(posted(NOTICES.open));
    fake.discord.requests.length = 0;
    // Ana's other tab reads the relay while her claim still waits in the outbox.
    await pullOnly(ana, groupId);
    const { store } = ana.services;
    expect((await store.getGroup(groupId))?.outbox).toHaveLength(1);

    await createChatBot({
      store,
      post: (webhook, content) => postWebhook(webhook, content, fake.discord.fetch),
      notice: (moment) => moment,
    }).run(groupId);

    expect(fake.discord.requests).toEqual([]);
    expect((await store.getGroup(groupId))?.chatClaims).toEqual([]);
  });

  it('does nothing for a group that isn’t on the device', async () => {
    const { fake, bot } = await wonButUnposted();

    await bot().run('no-such-group');

    expect(fake.discord.requests).toEqual([]);
  });
});
