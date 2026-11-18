/**
 * The chat bot through the sync loop (#119; docs/spec/phase-1-spec.md §4,
 * Chat bot): devices on one fake relay, each posting to one fake Discord
 * endpoint (src/test/fakeDiscord.ts), so nothing reaches the network. The
 * fake's webhook is a text channel's, which refuses a thread (#123), so each
 * device falls back once and then posts as #119 does. With
 * the bot on, each moment of a Proposal reaches Discord exactly once across
 * every device, two devices holding one key included; with it off, narrowed,
 * the device leaving, or the group dissolved (#108), nothing does. A canary in every field of the group
 * shows no post carries anything but the fixed line and the app's address,
 * and the webhook never reaches the relay readable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { weekOf } from '../crypto/groupKeys';
import { xchachaSeal } from '../crypto/seal';
import { voteToken } from '../crypto/voteLink';
import { type EventBodies, type EventType, signEvent } from '../engine/event';
import { fold } from '../engine/fold';
import { getWebhook, postWebhook } from '../net/discord';
import { TEST_NOW, testDevice, type TestDevice } from '../test/appServices';
import { delivered } from '../test/fakeDiscord';
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
const ORIGIN = 'https://reconcile.test';
/** A canary in every field of the Proposal under test. */
const CANARY = { title: 'CANARY-title', why: 'CANARY-why', text: 'CANARY-atom' };

/** What the bot posts for each moment of a Proposal whose vote link is `link` (#472). */
function notices(link: string) {
  return {
    open: `A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.\n${link}`,
    closing: `A vote closes within a day in Reconcile.\n${link}`,
    result: `A vote has finished in Reconcile.\n${link}`,
  };
}

/** The vote link of `proposal` in `groupId`, from the group's secret on `device` (#472, ADR-0079). */
async function linkOf(device: TestDevice, groupId: string, proposal: string): Promise<string> {
  const kept = await device.services.store.getGroup(groupId);
  if (kept === undefined) throw new Error('Expected the group on this device.');
  return `${ORIGIN}/#vote/${voteToken(kept.secret, proposal)}`;
}

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
  vi.restoreAllMocks();
});

/** What reached the channel: each post Discord took, as it read it. */
function bodies(fake: FakeRelay): unknown[] {
  return delivered(fake.discord).map((request) => request.body);
}

/** Every post a device tried, taken or not, as Discord would read it. */
function attempts(fake: FakeRelay): unknown[] {
  return fake.discord.requests.map((request) => request.body);
}

/** A bot over `store` that posts to `fake`'s Discord, each notice its moment's name. */
function testBot(store: TestDevice['services']['store'], fake: FakeRelay) {
  const discord = fake.discord.fetch;
  return createChatBot({
    store,
    post: (webhook, content, place) => postWebhook(webhook, content, { ...place, fetch: discord }),
    getWebhook: (webhook) => getWebhook(webhook, { fetch: discord }),
    notice: (moment) => moment,
    threadName: (number) => `Proposal ${String(number)}`,
  });
}

/** The body Discord gets for `content`, opening thread `threadName` when given. */
function posted(content: string, threadName?: string) {
  const thread = threadName === undefined ? {} : { thread_name: threadName };
  return { content, ...thread, allowed_mentions: { parse: [] } };
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

/** Every device syncs once, in order, each waiting for the posts its bot started. */
async function syncAll(devices: readonly TestDevice[]): Promise<void> {
  for (const device of devices) {
    await device.services.sync.syncOnce();
    await device.chatBot.idle();
  }
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
  it('posts the result of the vote that turned it on, once, as the fixed line and the vote’s link', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await group(fake);

    const on = await turnBotOn(devices, groupId);
    await syncRounds(devices);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');

    expect(bodies(fake)).toEqual([posted(notices(await linkOf(ana, groupId, on)).result)]);
    expect(delivered(fake.discord).map((request) => request.url)).toEqual([WEBHOOK]);
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

    const canary = await proposeCanary(fake, ana, groupId);
    await syncRounds(devices);
    const NOTICES = notices(await linkOf(ana, groupId, canary));
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
    // The vote link names neither the group nor the Proposal (#472).
    expect(everything).not.toContain(groupId);
    expect(everything).not.toContain(canary);
    const paths = fake.discord.requests.map((request) => request.url.split('?')[0]);
    expect(paths.every((path) => path === WEBHOOK)).toBe(true);
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
    const bins = await say(ben, groupId, {
      type: 'proposal',
      body: { atom: `${groupId}.1`, title: 'Bins', why: 'Smell.', text: 'Bins out on Monday.' },
    });
    const NOTICES = notices(await linkOf(ben, groupId, bins));
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
    const on = await turnBotOn(devices, groupId);
    await syncRounds(devices);
    fake.minute += 60;
    await syncRounds(devices);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    // A 500 isn't a text channel's refusal of a thread, so nothing goes again.
    const result = posted(
      notices(await linkOf(ana, groupId, on)).result,
      'Proposal 1 in Reconcile',
    );
    expect(attempts(fake)).toEqual([result]);

    fake.discord.offline = true;
    const canary = await proposeCanary(fake, ana, groupId);
    await syncRounds(devices);
    fake.minute += 60;
    await syncRounds(devices);
    const open = notices(await linkOf(ana, groupId, canary)).open;
    expect(attempts(fake)).toEqual([result, posted(open, 'Proposal 2 in Reconcile')]);
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

  it('from a device whose group has dissolved, even for a claim it won before the dissolve (#108)', async () => {
    const { fake, groupId, ana } = await dissolvedAfterAWin();

    await ana.services.sync.syncOnce();
    await ana.services.sync.syncOnce();

    expect(fake.discord.requests).toEqual([]);
    const kept = await ana.services.store.getGroup(groupId);
    expect(kept?.archived).toEqual({ reason: 'dissolved' });
    expect(kept?.chatClaims).toBeUndefined();
    expect(kept?.outbox).toEqual([]);
  });
});

/** Reads `groupId`'s new records into `device`'s store as a sync pass would, posting none of its outbox. */
async function pullOnly(device: TestDevice, groupId: string): Promise<void> {
  const { store, relay } = device.services;
  const group = await store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  // The week of its last relay minute: these tests stay in one relay week (#110).
  const channel = channelOf(group.secret, weekOf(group.relayNow ?? START));
  const after = group.cursors?.[channel.mailbox] ?? group.cursor;
  const page = await relay.getBlobs(channel.mailbox, after);
  const records = openRecords(xchachaSeal, channel, page.records);
  const cursors = { ...group.cursors, [channel.mailbox]: page.records.at(-1)?.seq ?? after };
  const { now: relayNow, instance } = page;
  await store.applyPull(
    groupId,
    { records, cursors, relayNow, instance, lastSyncAt: TEST_NOW },
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

/** A sync loop for `device` that runs no chat bot, so nothing it reads is posted. */
function quietSync(device: TestDevice) {
  const { store, relay } = device.services;
  return createSync({ store, relay, seal: xchachaSeal, clock: () => TEST_NOW });
}

/**
 * Ana's group with the bot on, her winning claim of the canary Proposal's
 * opening folded and not yet posted, and a dissolve Proposal (#108) both
 * pass, so Ben's `dissolve` is at the relay. Ana's device hasn't read it:
 * the claim's moment is still due at the dissolve's receipt.
 */
async function dissolvedAfterAWin() {
  const fake = createFakeRelay({ minute: START });
  const { groupId, devices } = await group(fake);
  const [ana, ben] = devices;
  if (ana === undefined || ben === undefined) throw new Error('Expected two devices.');
  await turnBotOn(devices, groupId);
  await syncRounds(devices);
  await proposeCanary(fake, ana, groupId);
  await ana.services.sync.syncOnce();
  const [quietAna, quietBen] = [quietSync(ana), quietSync(ben)];
  // The claim goes up and comes back the winner, unposted, before the dissolve Proposal.
  await quietAna.syncOnce();
  const motion = await say(ana, groupId, {
    type: 'proposal',
    body: { target: { kind: 'dissolve', wipe: false }, title: 'Dissolve', why: 'We moved out.' },
  });
  await say(ana, groupId, { type: 'vote', body: { proposal: motion, scores: { [motion]: 4 } } });
  await quietAna.syncOnce();
  await say(ben, groupId, { type: 'vote', body: { proposal: motion, scores: { [motion]: 4 } } });
  // Ben's pass reads the final pass and queues his dissolve; the next sends it.
  await quietBen.syncOnce();
  await quietBen.syncOnce();
  expect((await ben.services.store.getGroup(groupId))?.archived).toEqual({ reason: 'dissolved' });
  expect((await ana.services.store.getGroup(groupId))?.chatClaims).toHaveLength(1);
  fake.discord.requests.length = 0;
  return { fake, groupId, ana };
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
    const bot = () => testBot(store, fake);
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
    const canary = await proposeCanary(fake, ana, groupId);
    await ana.services.sync.syncOnce();
    await syncRounds([ben], 2);
    expect(bodies(fake).at(-1)).toEqual(posted(notices(await linkOf(ana, groupId, canary)).open));
    fake.discord.requests.length = 0;
    // Ana's other tab reads the relay while her claim still waits in the outbox.
    await pullOnly(ana, groupId);
    const { store } = ana.services;
    expect((await store.getGroup(groupId))?.outbox).toHaveLength(1);

    await testBot(store, fake).run(groupId);

    expect(fake.discord.requests).toEqual([]);
    expect((await store.getGroup(groupId))?.chatClaims).toEqual([]);
  });

  it('posts and claims nothing once a dissolve has folded, before the group is archived (#108)', async () => {
    const { fake, groupId, ana } = await dissolvedAfterAWin();
    const { store } = ana.services;
    await pullOnly(ana, groupId);
    const before = await store.getGroup(groupId);
    expect(before?.archived).toBeUndefined();

    await testBot(store, fake).run(groupId);

    expect(fake.discord.requests).toEqual([]);
    expect(await store.getGroup(groupId)).toEqual(before);
  });

  it('does nothing for a group that isn’t on the device', async () => {
    const { fake, bot } = await wonButUnposted();

    await bot().run('no-such-group');

    expect(fake.discord.requests).toEqual([]);
  });
});
