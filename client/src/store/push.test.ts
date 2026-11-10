/**
 * Opt-in push through the store, the relay's push routes and a fake browser
 * (#99; ADR-0012, ADR-0075 §2): devices on one fake relay (src/test/fakeRelay.ts),
 * each with a fake Notification and push manager (src/test/fakePush.ts), so
 * nothing reaches a push service. Off by default; on only once the relay has
 * the endpoint; off with a DELETE; nudges once each; upkeep on a fake clock;
 * and a scan showing push requests carry only an endpoint or a relay minute.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from '../crypto/base64url';
import { xchachaSeal } from '../crypto/seal';
import { LEVELS } from '../engine/capabilities';
import { type EventBodies, type EventType, signEvent } from '../engine/event';
import { DAY_MINUTES } from '../engine/rules';
import { createPushRelay } from '../net/push';
import { createRelay, type Fetch } from '../net/relay';
import { browserPushPort } from '../platform/pushPort';
import { TEST_NOW, type TestDevice } from '../test/appServices';
import { fakeEndpoint } from '../test/fakePush';
import {
  createFakeRelay,
  type FakeRelay,
  type FakeRequest,
  TEST_PUSH_KEY,
} from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { FOUNDING, foundAnother, members } from '../test/members';
import { mailboxAt, type MailboxAt } from './mailbox';
import { createPush, RENEW_MINUTES, REST_MS } from './push';
import { createSync } from './sync';

freshIndexedDBPerTest();

const [MEMBER] = LEVELS;

const opened: TestDevice[] = [];

afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

/** Ana and Ben in one group on `fake`, synced, with Ana's browser ready to grant. */
async function group(fake: FakeRelay = createFakeRelay()) {
  const { groupId, devices } = await members(fake, ['Ana', 'Ben']);
  opened.push(...devices);
  const [ana, ben] = devices as [TestDevice, TestDevice];
  const stored = await ana.services.store.getGroup(groupId);
  if (stored === undefined) throw new Error('Expected the group on Ana’s device.');
  const mailbox = mailboxAt(stored, 0);
  ana.push.answer = 'granted';
  return { fake, groupId, ana, ben, mailbox, secret: stored.secret };
}

/** The requests to the relay's push routes since `from`. */
function pushRequests(fake: FakeRelay, from = 0): FakeRequest[] {
  return fake.requests.slice(from).filter((request) => request.url.startsWith('/v1/push'));
}

/** A request as `[method, path]`. */
const line = (request: FakeRequest) => [request.method, request.url];

/** An event a test device says: its type and body. */
type Said = { [K in EventType]: { readonly type: K; readonly body: EventBodies[K] } }[EventType];

/** `device` signs `draft` in `groupId`, queues it and syncs. */
async function say(device: TestDevice, groupId: string, draft: Said): Promise<string> {
  const held = await device.services.store.getGroup(groupId);
  if (held === undefined) throw new Error('Expected the group on this device.');
  const event = signEvent(held.signingKey, { ...draft, group: groupId, ts: TEST_NOW });
  await device.services.store.enqueue(groupId, event.record);
  await device.services.sync.syncOnce();
  return event.id;
}

/** `device` queues its signed leave of `groupId` and marks the group leaving, as Leave does, without syncing. */
async function queueLeave(device: TestDevice, groupId: string): Promise<void> {
  const held = await device.services.store.getGroup(groupId);
  if (held === undefined) throw new Error('Expected the group.');
  const body = {};
  const leave = signEvent(held.signingKey, { type: 'leave', group: groupId, ts: TEST_NOW, body });
  await device.services.store.markLeaving(groupId, leave.record);
}

/** `device` proposes a change to the first section of `groupId` and syncs. */
function propose(device: TestDevice, groupId: string): Promise<string> {
  const body = {
    atom: `${groupId}.0`,
    title: 'Later quiet hours',
    why: 'Weekends.',
    text: 'At 11.',
  };
  return say(device, groupId, { type: 'proposal', body });
}

describe('turning push on for a group (#99)', () => {
  it('is off by default, with the device ready to ask', async () => {
    const { ana, groupId } = await group();

    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
    expect(ana.services.push.availability()).toBe('ready');
    expect(ana.push.asked).toBe(0);
  });

  it('asks permission inside the tap, subscribes with the relay’s key, and PUTs the group’s mailbox', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    const relayKey = `C${'Q'.repeat(86)}`;
    fake.pushKey = relayKey;
    const before = fake.requests.length;

    const turning = ana.services.push.turnOn(groupId);
    expect(ana.push.asked).toBe(1);
    expect(await turning).toBe('on');

    expect(ana.push.subscribed).toEqual([{ userVisibleOnly: true, key: relayKey }]);
    expect(pushRequests(fake, before).map(line)).toEqual([
      ['GET', '/v1/push/key'],
      ['PUT', `/v1/push/${mailbox}`],
    ]);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);
    expect((await ana.services.store.getGroup(groupId))?.push).toEqual({
      endpoint: fakeEndpoint(1),
      mailboxes: [mailbox],
      instance: fake.instance,
      at: fake.minute,
    });
  });

  it.each([
    ['blocked', 'denied'],
    ['dismissed', 'default'],
  ] as const)(
    'says %s and stores and sends nothing when the person answers %s',
    async (outcome, answer) => {
      const { fake, ana, groupId } = await group();
      ana.push.answer = answer;
      const before = fake.requests.length;

      expect(await ana.services.push.turnOn(groupId)).toBe(outcome);

      expect(fake.requests.slice(before)).toEqual([]);
      expect(ana.push.subscribed).toEqual([]);
      expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
    },
  );

  it('reads blocked once the device’s settings block notifications', async () => {
    const { ana } = await group();
    ana.push.permission = 'denied';

    expect(ana.services.push.availability()).toBe('blocked');
  });

  it('says unavailable when the relay has push off, subscribing to nothing', async () => {
    const { fake, ana, groupId } = await group();
    fake.pushKey = null;

    expect(await ana.services.push.turnOn(groupId)).toBe('unavailable');

    expect(ana.push.made).toEqual([]);
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
  });

  it('says unavailable, and ends the subscription it made, when the relay refuses the endpoint', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    ana.push.endpointOf = (n) => `https://push.example/${String(n)}`;

    expect(await ana.services.push.turnOn(groupId)).toBe('unavailable');

    expect(ana.push.made[0]?.unsubscribed).toBe(true);
    expect(fake.endpoints(mailbox)).toEqual([]);
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
  });

  it('says unavailable when the browser won’t subscribe, and failed when the relay can’t be reached', async () => {
    const { fake, ana, groupId } = await group();
    ana.push.failSubscribe = true;
    expect(await ana.services.push.turnOn(groupId)).toBe('unavailable');

    ana.push.failSubscribe = false;
    fake.offline = true;
    expect(await ana.services.push.turnOn(groupId)).toBe('failed');
    fake.offline = false;
    expect(await ana.services.push.turnOn('no-such-group')).toBe('failed');
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
  });

  it('says unavailable, without asking, on a device with no Push API', async () => {
    const { fake, ana, groupId } = await group();
    const port = browserPushPort({ ...ana.push.environment, container: undefined });
    const push = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port,
    });

    expect(push.availability()).toBe('unsupported');
    expect(await push.turnOn(groupId)).toBe('unavailable');
    expect(ana.push.asked).toBe(0);
  });

  it('gives a second group the same endpoint, from the one subscription (ADR-0075 §2)', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    const created = { groupId: await foundAnother(ana, 'Ana') };
    const second = await ana.services.store.getGroup(created.groupId);
    if (second === undefined) throw new Error('Expected the second group.');

    expect(await ana.services.push.turnOn(groupId)).toBe('on');
    expect(await ana.services.push.turnOn(created.groupId)).toBe('on');

    expect(ana.push.made).toHaveLength(1);
    expect(ana.push.subscribed).toHaveLength(1);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);
    expect(fake.endpoints(mailboxAt(second, 0))).toEqual([fakeEndpoint(1)]);
  });

  it('keeps the subscription while another group is still on', async () => {
    const { ana, groupId } = await group();
    const created = { groupId: await foundAnother(ana, 'Ana') };
    await ana.services.push.turnOn(groupId);
    await ana.services.push.turnOn(created.groupId);

    await ana.services.push.turnOff(groupId);

    expect(ana.push.subscription).not.toBeNull();
    await ana.services.push.turnOff(created.groupId);
    expect(ana.push.subscription).toBeNull();
  });
});

describe('turning push off', () => {
  it('sends a best-effort DELETE, then ends the subscription once no group is on', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    await ana.services.push.turnOn(groupId);
    const before = fake.requests.length;

    await ana.services.push.turnOff(groupId);

    expect(pushRequests(fake, before).map(line)).toEqual([['DELETE', `/v1/push/${mailbox}`]]);
    expect(fake.endpoints(mailbox)).toEqual([]);
    expect(ana.push.subscription).toBeNull();
    expect(ana.push.made[0]?.unsubscribed).toBe(true);
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
  });

  it('turns off here even when the DELETE can’t reach the relay', async () => {
    const { fake, ana, groupId } = await group();
    await ana.services.push.turnOn(groupId);
    fake.offline = true;

    await ana.services.push.turnOff(groupId);

    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
    expect(ana.push.subscription).toBeNull();
  });

  it('sends nothing for a group that is already off', async () => {
    const { fake, ana, groupId } = await group();
    const before = fake.requests.length;

    await ana.services.push.turnOff(groupId);
    await ana.services.push.turnOff('no-such-group');

    expect(fake.requests.slice(before)).toEqual([]);
  });
});

describe('nudges for my own open Proposals', () => {
  it('posts D − 1,440 and D once each for my Proposal, and none for another member’s', async () => {
    const { fake, ana, ben, groupId, mailbox } = await group();

    const proposal = await propose(ana, groupId);
    const deadline = fake.minute + 7 * DAY_MINUTES;
    await ana.services.sync.syncOnce();
    await ana.services.sync.syncOnce();
    await ben.services.sync.syncOnce();
    await propose(ben, groupId).catch(() => undefined);

    expect(fake.nudges(mailbox)).toEqual([deadline - DAY_MINUTES, deadline]);
    expect((await ana.services.store.getGroup(groupId))?.nudged).toEqual([
      `${proposal}@${String(deadline - DAY_MINUTES)}`,
      `${proposal}@${String(deadline)}`,
    ]);
  });

  it('posts none again after a reload, from the nudges it kept', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    await propose(ana, groupId);
    expect(fake.nudges(mailbox)).toHaveLength(2);
    // A fresh start of the app: nothing in memory, only what the store kept.
    const reloaded = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort(ana.push.environment),
    });

    await reloaded.nudge(groupId);

    expect(fake.nudges(mailbox)).toHaveLength(2);
  });

  it('posts each only once it is in folded state, whether or not push is on', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    fake.offline = true;
    await propose(ana, groupId);
    expect(fake.nudges(mailbox)).toEqual([]);

    fake.offline = false;
    await ana.services.sync.syncOnce();

    expect(fake.nudges(mailbox)).toHaveLength(2);
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
  });

  it('tries again after a failure, but not after a refusal', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    let failing = true;
    const flaky = createPush({
      store: ana.services.store,
      relay: createPushRelay({
        fetch: (input, init) =>
          failing ? Promise.reject(new TypeError('offline')) : fake.fetch(input, init),
      }),
      port: browserPushPort(ana.push.environment),
    });
    await propose(ana, groupId);
    const posted = fake.nudges(mailbox).length;
    await ana.services.store.markNudged(groupId, []);

    await flaky.nudge(groupId);
    failing = false;
    await ana.services.store.markNudged(groupId, []);
    await flaky.nudge(groupId);
    fake.pushKey = null;
    await ana.services.store.markNudged(groupId, []);
    const refusing = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort(ana.push.environment),
    });
    await refusing.nudge(groupId);
    const before = fake.requests.length;
    await refusing.nudge(groupId);

    expect(fake.nudges(mailbox)).toHaveLength(posted + 2);
    expect((await ana.services.store.getGroup(groupId))?.nudged).toHaveLength(2);
    expect(fake.requests.length).toBe(before);
  });

  it('posts nothing for a group that is gone or leaving', async () => {
    const { fake, ana, groupId } = await group();
    await propose(ana, groupId);
    const before = fake.requests.length;
    const push = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort(ana.push.environment),
    });

    await push.nudge('no-such-group');
    await ana.services.store.markLeaving(groupId, new Uint8Array([1]));
    await push.nudge(groupId);

    expect(fake.requests.length).toBe(before);
  });
});

/** A two-mailbox `mailboxAt`: `early` before relay minute `turn`, `late` from it, as weekly mailboxes would. */
function twoMailboxes(turn: number): MailboxAt {
  return (held, minute) =>
    `${minute < turn ? 'early' : 'later'}-${base64url(held.secret).slice(0, 37)}`;
}

describe('upkeep, after each sync pass (#99)', () => {
  /** A group with push on for Ana, and the request count once it is. */
  async function pushOn() {
    const setup = await group();
    await setup.ana.services.push.turnOn(setup.groupId);
    return setup;
  }

  it('re-PUTs 7 days after the relay last took it, and not a minute before', async () => {
    const { fake, ana, mailbox } = await pushOn();
    const start = fake.minute;

    fake.minute = start + RENEW_MINUTES - 1;
    let before = fake.requests.length;
    await ana.services.sync.syncOnce();
    expect(pushRequests(fake, before)).toEqual([]);

    fake.minute = start + RENEW_MINUTES;
    before = fake.requests.length;
    await ana.services.sync.syncOnce();
    expect(pushRequests(fake, before).map(line)).toEqual([
      ['GET', '/v1/push/key'],
      ['PUT', `/v1/push/${mailbox}`],
    ]);
  });

  it('re-PUTs on a new endpoint, forgetting the old one', async () => {
    const { fake, ana, groupId, mailbox } = await pushOn();
    ana.push.rotate();
    const before = fake.requests.length;

    await ana.services.sync.syncOnce();

    expect(pushRequests(fake, before).map(line)).toEqual([
      ['GET', '/v1/push/key'],
      ['DELETE', `/v1/push/${mailbox}`],
      ['PUT', `/v1/push/${mailbox}`],
    ]);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(2)]);
    expect((await ana.services.store.getGroup(groupId))?.push?.endpoint).toBe(fakeEndpoint(2));
  });

  it('re-PUTs to a fresh relay, whose instance is new', async () => {
    const { fake, ana, groupId, mailbox } = await pushOn();
    fake.restart({ keep: true });

    await ana.services.sync.syncOnce();
    await ana.services.sync.syncOnce();

    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);
    expect((await ana.services.store.getGroup(groupId))?.push?.instance).toBe(fake.instance);
  });

  it('registers every mailbox a new mailboxAt gives, and puts each nudge in its own week’s mailbox', async () => {
    const { fake, ana, groupId, secret } = await group();
    const turn = fake.minute + 3 * DAY_MINUTES;
    const at = twoMailboxes(turn);
    const push = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort(ana.push.environment),
      mailboxAt: at,
    });
    const early = at({ secret }, fake.minute);
    const later = at({ secret }, turn);

    expect(await push.turnOn(groupId)).toBe('on');
    await propose(ana, groupId);
    // Ana's own sync posted these to today's one mailbox; ask again through the stub.
    await ana.services.store.markNudged(groupId, []);
    await push.nudge(groupId);
    const deadline = fake.minute + 7 * DAY_MINUTES;

    expect(fake.endpoints(early)).toEqual([fakeEndpoint(1)]);
    expect(fake.endpoints(later)).toEqual([fakeEndpoint(1)]);
    expect(fake.nudges(later)).toEqual([deadline - DAY_MINUTES, deadline]);
    expect(fake.nudges(early)).toEqual([]);
  });

  it('re-PUTs when the mailbox set changes', async () => {
    const { fake, ana, groupId, mailbox } = await pushOn();
    const at = twoMailboxes(fake.minute + 40 * DAY_MINUTES);
    const push = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort(ana.push.environment),
      mailboxAt: at,
    });
    const stored = await ana.services.store.getGroup(groupId);
    if (stored === undefined) throw new Error('Expected the group.');

    await push.upkeep();

    expect(fake.endpoints(at(stored, fake.minute))).toEqual([fakeEndpoint(1)]);
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(1)]);
  });

  it('resubscribes when the relay’s key changes, and swaps the endpoint', async () => {
    const { fake, ana, groupId, mailbox } = await pushOn();
    fake.pushKey = `D${'w'.repeat(86)}`;
    fake.minute += RENEW_MINUTES;

    await ana.services.sync.syncOnce();

    expect(ana.push.made[0]?.unsubscribed).toBe(true);
    expect(ana.push.subscribed.at(-1)).toEqual({ userVisibleOnly: true, key: fake.pushKey });
    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(2)]);
    expect((await ana.services.store.getGroup(groupId))?.push?.endpoint).toBe(fakeEndpoint(2));
  });

  it('subscribes again when the browser dropped the subscription but notifications are still allowed', async () => {
    const { fake, ana, mailbox } = await pushOn();
    await ana.push.subscription?.unsubscribe();

    await ana.services.sync.syncOnce();

    expect(fake.endpoints(mailbox)).toEqual([fakeEndpoint(2)]);
  });

  it('turns every group off here once the device’s settings take notifications away', async () => {
    const { fake, ana, groupId, mailbox } = await pushOn();
    await ana.push.subscription?.unsubscribe();
    ana.push.permission = 'denied';

    await ana.services.sync.syncOnce();

    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
    expect(fake.endpoints(mailbox)).toEqual([]);
  });

  it('rests for an hour after a failure, so a refusal never repeats every pass', async () => {
    const { fake, ana, groupId } = await pushOn();
    let now = TEST_NOW;
    const push = createPush({
      store: ana.services.store,
      relay: createPushRelay({ fetch: fake.fetch }),
      port: browserPushPort(ana.push.environment),
      clock: () => now,
    });
    fake.pushKey = null;
    fake.minute += RENEW_MINUTES;
    await ana.services.sync.syncOnce();

    let before = fake.requests.length;
    await push.upkeep();
    await push.upkeep();
    now += REST_MS - 1;
    await push.upkeep();
    expect(pushRequests(fake, before).map(line)).toEqual([['GET', '/v1/push/key']]);

    now += 1;
    fake.pushKey = TEST_PUSH_KEY;
    before = fake.requests.length;
    await push.upkeep();
    expect(pushRequests(fake, before)).toHaveLength(2);
    expect((await ana.services.store.getGroup(groupId))?.push?.at).toBe(fake.minute);
  });

  it('sends nothing while no group has push on', async () => {
    const { fake, ana } = await group();
    const before = fake.requests.length;

    await ana.services.sync.syncOnce();

    expect(pushRequests(fake, before)).toEqual([]);
  });
});

describe('Leave (#77, #99)', () => {
  it('fires a keepalive DELETE before the group is purged, doesn’t wait for it, then ends the subscription', async () => {
    const { fake, ana, groupId, mailbox } = await group();
    await ana.services.push.turnOn(groupId);
    const order: string[] = [];
    const deletes: RequestInit[] = [];
    let release: () => void = () => undefined;
    const answered = new Promise<Response>((resolve) => {
      release = () => {
        resolve(new Response(null, { status: 204 }));
      };
    });
    // Every DELETE hangs until the test lets it go: the purge mustn't wait on it.
    const hanging: Fetch = (input, init) => {
      if (init?.method !== 'DELETE') return fake.fetch(input, init);
      order.push('delete');
      deletes.push(init);
      return answered;
    };
    const { store } = ana.services;
    const push = createPush({
      store,
      relay: createPushRelay({ fetch: hanging }),
      port: browserPushPort(ana.push.environment),
    });
    const watched = {
      ...store,
      purgeGroup: (id: string) => {
        order.push('purge');
        return store.purgeGroup(id);
      },
    };
    const sync = createSync({
      store: watched,
      relay: createRelay({ fetch: fake.fetch }),
      seal: xchachaSeal,
      push,
    });

    // Queued straight in the store: Leave's own sync would race this one.
    await queueLeave(ana, groupId);
    await sync.syncOnce();

    expect(order).toEqual(['delete', 'purge']);
    expect(deletes.map((init) => init.keepalive)).toEqual([true]);
    expect(await store.getGroup(groupId)).toBeUndefined();
    expect(ana.push.subscription).not.toBeNull();
    release();
    await vi.waitFor(() => {
      expect(ana.push.subscription).toBeNull();
    });
    expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sends nothing for a group whose push was off', async () => {
    const { fake, ana, groupId } = await group();
    await queueLeave(ana, groupId);
    const before = fake.requests.length;

    await ana.services.sync.syncOnce();

    expect(pushRequests(fake, before)).toEqual([]);
    expect(await ana.services.store.getGroup(groupId)).toBeUndefined();
  });
});

describe('wakes, as each device posts its outbox (#99)', () => {
  it('asks for wake=1 only on a Proposal and on the ballot that closes one early', async () => {
    const fake = createFakeRelay();
    const { groupId, ana, ben, mailbox } = await group(fake);
    /** Each blob PUT to the group's mailbox since `from`, as whether it asked for a wake. */
    const wakes = (from: number) =>
      fake.requests
        .slice(from)
        .filter((r) => r.method === 'PUT' && r.url.startsWith(`/v1/mailbox/${mailbox}?`))
        .map((r) => r.url.endsWith('&wake=1'));
    const founding = wakes(0);

    let from = fake.requests.length;
    const proposal = await propose(ana, groupId);
    const proposed = wakes(from);
    await ben.services.sync.syncOnce();
    from = fake.requests.length;
    await say(ben, groupId, { type: 'vote', body: { proposal, scores: { [proposal]: 3 } } });
    const first = wakes(from);
    await ana.services.sync.syncOnce();
    from = fake.requests.length;
    await say(ana, groupId, { type: 'vote', body: { proposal, scores: { [proposal]: 4 } } });
    const closing = wakes(from);
    from = fake.requests.length;
    await say(ben, groupId, { type: 'level', body: { level: MEMBER } });
    const level = wakes(from);

    // Genesis and the join, then each later event: Ana's and Ben's push are both off throughout.
    expect(founding).toEqual([false, false]);
    expect(proposed).toEqual([true]);
    expect(first).toEqual([false]);
    expect(closing).toEqual([true]);
    expect(level).toEqual([false]);
    expect((await ana.services.store.getGroup(groupId))?.push).toBeUndefined();
  });
});

describe('what push sends the relay', () => {
  it('holds only an endpoint or a relay minute, and never the group, its names or its secret', async () => {
    const { fake, ana, ben, groupId, secret } = await group();
    await ana.services.push.turnOn(groupId);
    ben.push.answer = 'granted';
    await ben.services.push.turnOn(groupId);
    await propose(ana, groupId);
    fake.minute += RENEW_MINUTES;
    await ana.services.sync.syncOnce();
    await ben.services.push.turnOff(groupId);

    const sent = pushRequests(fake);
    expect(sent.map((r) => r.method).sort()).toEqual(
      ['DELETE', 'GET', 'GET', 'GET', 'POST', 'POST', 'PUT', 'PUT', 'PUT'].sort(),
    );
    const canaries = [groupId, base64url(secret), FOUNDING.groupName, FOUNDING.title, 'Ana', 'Ben'];
    for (const request of sent) {
      const body =
        request.body === null
          ? null
          : (JSON.parse(new TextDecoder().decode(request.body)) as object);
      expect(body === null || ['endpoint', 'not_before'].includes(Object.keys(body).join())).toBe(
        true,
      );
      for (const canary of canaries) {
        expect(request.url).not.toContain(canary);
        expect(JSON.stringify(body)).not.toContain(canary);
      }
    }
  });
});
