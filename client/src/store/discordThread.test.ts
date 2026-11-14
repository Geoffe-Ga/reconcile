/**
 * A Discord thread per Proposal (#123; ADR-0011, ADR-0039 step 1;
 * docs/spec/phase-1-spec.md §4, Chat bot), through the sync loop: devices on
 * one fake relay, posting to one fake Discord webhook (src/test/fakeDiscord.ts)
 * that answers as a forum channel or a text channel would, so nothing reaches
 * the network. With a forum, a Proposal's first notice that lands opens a
 * thread named by its number, the device that won that notice's claim records
 * the thread's link once (#245: a later notice's, when the opening never
 * landed), and its later notices go into the thread, the result as the
 * concluded line.
 * With a text channel, the device falls back once and posts as #119 does. No
 * thread name or post carries a title, a name or any other word of the group.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { xchachaSeal } from '../crypto/seal';
import { type EventBodies, type EventType, parseRecord, signEvent } from '../engine/event';
import { fold, type GroupState } from '../engine/fold';
import type { Answer, WebhookHome } from '../net/discord';
import { TEST_NOW, type TestDevice } from '../test/appServices';
import {
  type DiscordRequest,
  FAKE_CHANNEL,
  FAKE_GUILD,
  type FakeChannel,
} from '../test/fakeDiscord';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { FOUNDING, members } from '../test/members';
import { createChatBot } from './chatBot';
import type { Store } from './db';
import { createSync } from './sync';

freshIndexedDBPerTest();

const DAY = 1_440;
const WEBHOOK = 'https://discord.com/api/webhooks/1199000000000000001/sEcReT-tokenWXYZ';
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
  concluded: `The argument has concluded. A vote has finished in Reconcile.\n${ORIGIN}`,
};

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

/** A post's body as Discord reads it: `content`, then `thread_name` when it opens a thread. */
function body(content: unknown, threadName?: string) {
  return {
    content,
    ...(threadName === undefined ? {} : { thread_name: threadName }),
    allowed_mentions: { parse: [] },
  };
}

/** Each request as `METHOD url`, with its body. */
function requests(fake: FakeRelay): { readonly sent: string; readonly body: unknown }[] {
  return fake.discord.requests.map((request: DiscordRequest) => ({
    sent: `${request.method} ${request.url}`,
    body: request.body,
  }));
}

/** An event a test device says: its type and body. */
type Said = { [K in EventType]: { readonly type: K; readonly body: EventBodies[K] } }[EventType];

/** `device` signs `draft` with its key in `groupId` and queues it, without syncing. */
async function say(device: TestDevice, groupId: string, draft: Said): Promise<string> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  const event = signEvent(group.signingKey, { ...draft, group: groupId, ts: TEST_NOW });
  await device.services.store.enqueue(groupId, event.record);
  return event.id;
}

/** Every device syncs `times` times, in order, each waiting for the posts its bot started. */
async function syncRounds(devices: readonly TestDevice[], times = 3): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    for (const device of devices) {
      await device.services.sync.syncOnce();
      await device.chatBot.idle();
    }
  }
}

/** `device`'s folded view of `groupId`. */
async function stateOn(device: TestDevice, groupId: string): Promise<GroupState> {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  return fold(group.log, group.relayNow);
}

/** Everyone in `devices` scores `proposal` 4, which closes its vote early, and syncs. */
async function voteThrough(devices: readonly TestDevice[], groupId: string, proposal: string) {
  for (const device of devices) {
    await say(device, groupId, { type: 'vote', body: { proposal, scores: { [proposal]: 4 } } });
    await device.services.sync.syncOnce();
  }
  await syncRounds(devices);
}

/**
 * A group of `names` on a fake relay whose Discord webhook posts into a
 * `channel`, with the bot voted on (Proposal 1), and the second member's edit
 * of the second section (Proposal 2) opened and voted through, every post so
 * far forgotten.
 */
async function botOnWith(channel: FakeChannel, names: readonly string[] = ['Ana', 'Ben']) {
  const fake = createFakeRelay({ minute: START });
  fake.discord.channel = channel;
  const { groupId, devices } = await members(fake, names);
  opened.push(...devices);
  const [founder, second = founder] = devices;
  if (founder === undefined || second === undefined) throw new Error('Expected a founder.');
  const on = await say(founder, groupId, {
    type: 'proposal',
    body: {
      target: { kind: 'rules', optIn: 'chatBot', value: { webhook: WEBHOOK } },
      title: 'Turn on the Discord chat bot',
      why: 'Nudges.',
    },
  });
  await syncRounds(devices, 1);
  await voteThrough(devices, groupId, on);
  const bins = await say(second, groupId, {
    type: 'proposal',
    body: { atom: `${groupId}.1`, title: 'Bins', why: 'Smell.', text: 'Bins out on Monday.' },
  });
  await syncRounds(devices);
  await voteThrough(devices, groupId, bins);
  fake.discord.requests.length = 0;
  return { fake, groupId, devices, founder };
}

/** The founder proposes the canary edit, Proposal 3, at {@link PROPOSED}, and everyone syncs. */
async function proposeCanary(fake: FakeRelay, founder: TestDevice, groupId: string) {
  fake.minute = PROPOSED;
  const id = await say(founder, groupId, {
    type: 'proposal',
    body: { atom: `${groupId}.0`, ...CANARY },
  });
  return id;
}

/** The threads the fold kept from `device`'s log, and how many `chat-thread` events name `proposal`. */
async function threadRecords(device: TestDevice, groupId: string, proposal = '') {
  const group = await device.services.store.getGroup(groupId);
  if (group === undefined) throw new Error('Expected the group on this device.');
  const logged = group.log.filter(({ bytes }) => {
    const event = parseRecord(bytes)?.event;
    return event?.type === 'chat-thread' && event.body.proposal === proposal;
  });
  return { kept: fold(group.log, group.relayNow).chatThreads, logged: logged.length };
}

describe('a forum channel’s webhook', () => {
  it('opens the Proposal’s thread with its first post, as Proposal 3 in Reconcile with ?wait=true, and records it exactly once', async () => {
    const { fake, groupId, devices, founder } = await botOnWith('forum');

    const proposal = await proposeCanary(fake, founder, groupId);
    await syncRounds(devices);

    const [first, ...rest] = requests(fake);
    expect(first).toEqual({
      sent: `POST ${WEBHOOK}?wait=true`,
      body: body(NOTICES.open, 'Proposal 3 in Reconcile'),
    });
    const thread = fake.discord.threads.at(-1);
    // Ana's device posts it, and reads the webhook once: Ben's device opened Proposal 2's thread.
    expect(rest).toEqual([{ sent: `GET ${WEBHOOK}`, body: null }]);
    for (const device of devices) {
      const { kept, logged } = await threadRecords(device, groupId, proposal);
      expect(kept.filter((t) => t.proposal === proposal)).toEqual([
        expect.objectContaining({
          proposal,
          url: `https://discord.com/channels/${FAKE_GUILD}/${String(thread)}`,
        }),
      ]);
      expect(logged).toBe(1);
    }
  });

  it('posts the closing and result notices into the thread, the result as the concluded line', async () => {
    const { fake, groupId, devices, founder } = await botOnWith('forum');
    await proposeCanary(fake, founder, groupId);
    await syncRounds(devices);
    const thread = String(fake.discord.threads.at(-1));
    fake.discord.requests.length = 0;

    fake.minute = DEADLINE - DAY;
    await syncRounds(devices);
    fake.minute = DEADLINE;
    await syncRounds(devices);

    expect(requests(fake)).toEqual([
      { sent: `POST ${WEBHOOK}?thread_id=${thread}`, body: body(NOTICES.closing) },
      { sent: `POST ${WEBHOOK}?thread_id=${thread}`, body: body(NOTICES.concluded) },
    ]);
    expect(fake.discord.requests.map((request) => request.status)).toEqual([204, 204]);
  });

  it('reads the webhook’s server and channel once per group', async () => {
    const { fake, groupId, devices } = await botOnWith('forum', ['Ana']);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    // Ana alone posts everything, so her device read the webhook for Proposal 2's thread.
    expect(fake.discord.threads).toHaveLength(2);
    fake.discord.requests.length = 0;

    await proposeCanary(fake, ana, groupId);
    await syncRounds(devices);

    expect(requests(fake).map((request) => request.sent)).toEqual([`POST ${WEBHOOK}?wait=true`]);
    expect((await ana.services.store.getGroup(groupId))?.chatChannel).toEqual({
      webhook: '1199000000000000001',
      home: { guild: FAKE_GUILD, channel: FAKE_CHANNEL },
    });
  });

  it('opens a thread for the vote that turned the bot on, whose result is its only post, and its result claimant records it, though nobody claimed its opening (#245)', async () => {
    const fake = createFakeRelay({ minute: START });
    fake.discord.channel = 'forum';
    const { groupId, devices } = await members(fake, ['Ana']);
    opened.push(...devices);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const on = await say(ana, groupId, {
      type: 'proposal',
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: { webhook: WEBHOOK } },
        title: 'Turn on the Discord chat bot',
        why: 'Nudges.',
      },
    });
    await syncRounds(devices, 1);
    await say(ana, groupId, { type: 'vote', body: { proposal: on, scores: { [on]: 4 } } });
    await syncRounds(devices);

    const thread = String(fake.discord.threads.at(-1));
    expect(requests(fake)).toEqual([
      { sent: `POST ${WEBHOOK}?wait=true`, body: body(NOTICES.result, 'Proposal 1 in Reconcile') },
      { sent: `GET ${WEBHOOK}`, body: null },
    ]);
    const { kept, logged } = await threadRecords(ana, groupId, on);
    expect(kept).toEqual([
      expect.objectContaining({
        proposal: on,
        url: `https://discord.com/channels/${FAKE_GUILD}/${thread}`,
      }),
    ]);
    expect(logged).toBe(1);
  });

  it('lets the closing claimant record the thread when the opening post never landed, so the result goes into it: one thread, not two (#245)', async () => {
    const { fake, groupId, devices, founder } = await botOnWith('forum');
    const threads = fake.discord.threads.length;
    // Discord can't be reached while the opening is posted, and a post is never retried.
    fake.discord.offline = true;
    const proposal = await proposeCanary(fake, founder, groupId);
    await syncRounds(devices);
    fake.discord.offline = false;
    expect(fake.discord.threads).toHaveLength(threads);
    // The opening was due, claimed and tried, and never landed.
    expect(fake.discord.requests.filter((r) => r.method === 'POST').map((r) => r.status)).toEqual([
      null,
    ]);

    // Ben's device syncs first as the vote's last day starts, so another member wins its claim.
    fake.minute = DEADLINE - DAY;
    await syncRounds([...devices].reverse());
    fake.minute = DEADLINE;
    await syncRounds(devices);
    const claims = (await stateOn(founder, groupId)).chatPosts.filter(
      (claim) => claim.proposal === proposal,
    );
    const [open, closing] = claims;
    expect(claims.map((claim) => claim.moment)).toEqual(['open', 'closing', 'result']);
    expect(closing?.by).not.toBe(open?.by);

    expect(fake.discord.threads).toHaveLength(threads + 1);
    const thread = String(fake.discord.threads.at(-1));
    const posts = requests(fake).filter((request) => request.sent.startsWith('POST'));
    expect(posts.slice(-2)).toEqual([
      { sent: `POST ${WEBHOOK}?wait=true`, body: body(NOTICES.closing, 'Proposal 3 in Reconcile') },
      { sent: `POST ${WEBHOOK}?thread_id=${thread}`, body: body(NOTICES.concluded) },
    ]);
    for (const device of devices) {
      const { kept, logged } = await threadRecords(device, groupId, proposal);
      expect(kept.filter((t) => t.proposal === proposal)).toEqual([
        expect.objectContaining({
          proposal,
          url: `https://discord.com/channels/${FAKE_GUILD}/${thread}`,
        }),
      ]);
      expect(logged).toBe(1);
    }
  });

  it('puts nothing of the group in a thread name or a post: only the number and fixed text', async () => {
    const { fake, groupId, devices, founder } = await botOnWith('forum');
    await proposeCanary(fake, founder, groupId);
    for (const minute of [PROPOSED, DEADLINE - DAY, DEADLINE]) {
      fake.minute = minute;
      await syncRounds(devices);
    }

    const everything = JSON.stringify(fake.discord.requests);
    const names = (await stateOn(founder, groupId)).members.map((member) => member.name);
    expect(names).toEqual(['Ana', 'Ben']);
    for (const canary of [...Object.values(CANARY), FOUNDING.groupName, FOUNDING.title, ...names]) {
      expect(everything).not.toContain(canary);
    }
    for (const section of FOUNDING.text.split('\n\n')) expect(everything).not.toContain(section);
    const threadNames = fake.discord.requests.flatMap((request) => {
      const sent = request.body as { thread_name?: unknown } | null;
      return sent?.thread_name === undefined ? [] : [sent.thread_name];
    });
    expect(threadNames).toEqual(['Proposal 3 in Reconcile']);
  });
});

describe('a text channel’s webhook', () => {
  it('sends a group’s posts one after another, so a second post in the same sync already knows the channel takes no threads', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await members(fake, ['Ana']);
    opened.push(...devices);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    await say(ana, groupId, {
      type: 'proposal',
      body: { atom: `${groupId}.1`, title: 'Bins', why: 'Smell.', text: 'Bins out on Monday.' },
    });
    const on = await say(ana, groupId, {
      type: 'proposal',
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: { webhook: WEBHOOK } },
        title: 'Turn on the Discord chat bot',
        why: 'Nudges.',
      },
    });
    await syncRounds(devices, 1);
    await say(ana, groupId, { type: 'vote', body: { proposal: on, scores: { [on]: 4 } } });
    // Discord answers slowly, so the second post would start before the first learned anything.
    fake.discord.latency = 25;
    await syncRounds(devices);

    // Proposal 1 is still open and Proposal 2 has just passed, so both post in one sync.
    const opening: unknown = expect.stringMatching(
      /^A new Proposal is open in Reconcile\. Voting ends /,
    );
    expect(requests(fake)).toEqual([
      { sent: `POST ${WEBHOOK}?wait=true`, body: body(opening, 'Proposal 1 in Reconcile') },
      { sent: `POST ${WEBHOOK}`, body: body(opening) },
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.result) },
    ]);
  });

  it('falls back once when Discord refuses thread_name, records nothing, and posts later notices to the channel without it', async () => {
    const fake = createFakeRelay({ minute: START });
    const { groupId, devices } = await members(fake, ['Ana']);
    opened.push(...devices);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    const on = await say(ana, groupId, {
      type: 'proposal',
      body: {
        target: { kind: 'rules', optIn: 'chatBot', value: { webhook: WEBHOOK } },
        title: 'Turn on the Discord chat bot',
        why: 'Nudges.',
      },
    });
    await syncRounds(devices, 1);
    await say(ana, groupId, { type: 'vote', body: { proposal: on, scores: { [on]: 4 } } });
    await syncRounds(devices);
    expect(requests(fake)).toEqual([
      { sent: `POST ${WEBHOOK}?wait=true`, body: body(NOTICES.result, 'Proposal 1 in Reconcile') },
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.result) },
    ]);
    expect(fake.discord.requests.map((request) => request.status)).toEqual([400, 204]);
    fake.discord.requests.length = 0;

    await proposeCanary(fake, ana, groupId);
    for (const minute of [PROPOSED, DEADLINE - DAY, DEADLINE]) {
      fake.minute = minute;
      await syncRounds(devices);
    }

    expect(requests(fake)).toEqual([
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.open) },
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.closing) },
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.result) },
    ]);
    expect((await threadRecords(ana, groupId)).kept).toEqual([]);
    expect((await ana.services.store.getGroup(groupId))?.chatChannel).toEqual({
      webhook: '1199000000000000001',
      home: 'text',
    });
  });

  it('remembers a channel that posts a thread_name post in itself, and records nothing', async () => {
    const { fake, groupId, devices } = await botOnWith('text-ignoring', ['Ana']);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');

    await proposeCanary(fake, ana, groupId);
    for (const minute of [PROPOSED, DEADLINE - DAY]) {
      fake.minute = minute;
      await syncRounds(devices);
    }

    // Proposal 2's opening already showed Ana's device the post lands in the channel.
    expect(requests(fake)).toEqual([
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.open) },
      { sent: `POST ${WEBHOOK}`, body: body(NOTICES.closing) },
    ]);
    expect((await threadRecords(ana, groupId)).kept).toEqual([]);
    expect((await ana.services.store.getGroup(groupId))?.chatChannel?.home).toBe('text');
  });
});

describe('createChatBot, with Discord’s answers stubbed', () => {
  /** Ana alone, the bot on with a forum's webhook, and her winning claim of Proposal 2's opening folded, not yet posted. */
  async function wonOpening() {
    const { fake, groupId, devices } = await botOnWith('forum', ['Ana']);
    const [ana] = devices;
    if (ana === undefined) throw new Error('Expected Ana’s device.');
    // Ana's own bot read the webhook for Proposal 2; this one starts with nothing learned.
    await ana.services.store.noteChatChannel(groupId, { webhook: 'none', home: 'text' });
    fake.minute = PROPOSED;
    await say(ana, groupId, { type: 'proposal', body: { atom: `${groupId}.0`, ...CANARY } });
    await ana.services.sync.syncOnce();
    const { store, relay } = ana.services;
    // A sync loop with no bot sends the claim and reads it back, so it wins without being posted.
    await createSync({ store, relay, seal: xchachaSeal }).syncOnce();
    return { groupId, store };
  }

  /** A bot whose posts get `answers` in turn and whose webhook reads as `home`, keeping each call. */
  function stubbed(store: Store, answers: readonly Answer[], home: WebhookHome | null) {
    const calls: string[] = [];
    let next = 0;
    const bot = createChatBot({
      store,
      post: (_webhook, content, place) => {
        calls.push(`post ${content} ${JSON.stringify(place)}`);
        const answer = answers[next] ?? { ok: true, status: 204, channel: null };
        next += 1;
        return Promise.resolve(answer);
      },
      getWebhook: () => {
        calls.push('get');
        return Promise.resolve(home);
      },
      notice: (moment, _deadline, inThread) => (inThread ? `${moment} in thread` : moment),
      threadName: (number) => `Proposal ${String(number)}`,
    });
    return { bot, calls };
  }

  /** The `chat-thread` events waiting in `groupId`'s outbox. */
  async function queuedThreads(store: Store, groupId: string): Promise<number> {
    const group = await store.getGroup(groupId);
    return (group?.outbox ?? []).filter((bytes) => parseRecord(bytes)?.event.type === 'chat-thread')
      .length;
  }

  const OPENED = { ok: true, status: 200, channel: '1309000000000000099' };
  const HOME = { guild: FAKE_GUILD, channel: FAKE_CHANNEL };

  it('queues the thread’s link once Discord says where the webhook posts', async () => {
    const { groupId, store } = await wonOpening();
    const { bot, calls } = stubbed(store, [OPENED], HOME);

    await bot.run(groupId);
    await bot.idle();

    expect(calls).toEqual(['post open {"threadName":"Proposal 3"}', 'get']);
    expect(await queuedThreads(store, groupId)).toBe(1);
  });

  it('records nothing, and learns nothing, when Discord can’t say where the webhook posts', async () => {
    const { groupId, store } = await wonOpening();
    const { bot, calls } = stubbed(store, [OPENED], null);

    await bot.run(groupId);
    await bot.idle();

    expect(calls).toEqual(['post open {"threadName":"Proposal 3"}', 'get']);
    expect(await queuedThreads(store, groupId)).toBe(0);
    expect((await store.getGroup(groupId))?.chatChannel?.webhook).toBe('none');
  });

  it('records nothing when the server it names isn’t a Discord id', async () => {
    const { groupId, store } = await wonOpening();
    const { bot } = stubbed(store, [OPENED], { guild: 'guild', channel: FAKE_CHANNEL });

    await bot.run(groupId);
    await bot.idle();

    expect(await queuedThreads(store, groupId)).toBe(0);
  });

  it('asks nothing more when Discord took the post but named no channel', async () => {
    const { groupId, store } = await wonOpening();
    const { bot, calls } = stubbed(store, [{ ok: true, status: 200, channel: null }], HOME);

    await bot.run(groupId);
    await bot.idle();

    expect(calls).toEqual(['post open {"threadName":"Proposal 3"}']);
    expect(await queuedThreads(store, groupId)).toBe(0);
  });

  it('learns nothing when the post without the thread fails too, so the next post asks for a thread again', async () => {
    const { groupId, store } = await wonOpening();
    const refused = { ok: false, status: 400, channel: null };
    const { bot, calls } = stubbed(
      store,
      [refused, { ok: false, status: 500, channel: null }],
      HOME,
    );

    await bot.run(groupId);
    await bot.idle();

    expect(calls).toEqual(['post open {"threadName":"Proposal 3"}', 'post open {}']);
    expect((await store.getGroup(groupId))?.chatChannel?.webhook).toBe('none');
  });

  it('remembers a text channel only from a 400, not from any other refusal', async () => {
    const { groupId, store } = await wonOpening();
    const { bot, calls } = stubbed(store, [{ ok: false, status: 403, channel: null }], HOME);

    await bot.run(groupId);
    await bot.idle();

    expect(calls).toEqual(['post open {"threadName":"Proposal 3"}']);
  });
});
