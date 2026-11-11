/**
 * Opt-in push (#99; ADR-0012, ADR-0074, ADR-0075 §2): one switch per group,
 * all off to start, and the upkeep that keeps a phone waking.
 *
 * - **Turning a group on** runs inside the tap: the permission prompt first,
 *   then a subscription under the relay's own key (`GET /v1/push/key`, never
 *   a build constant), then the endpoint goes to the relay under each of the
 *   group's mailboxes. Only once the relay has taken it does the store keep
 *   the group as on.
 * - **Turning one off** forgets it here at once and sends a best-effort
 *   DELETE. Once no group is on, the device ends its subscription.
 * - **Leave** fires a `keepalive` DELETE just before the sync loop purges the
 *   group (`forget`), and doesn't wait for it.
 * - **Nudges:** after each group syncs, this device asks the relay to wake the
 *   group a day before each of its own open Proposals closes and at its
 *   deadline (`engine/nudges.ts`), each once, in the mailbox of the week the
 *   Proposal was received in (#110). The deadline's own week would do worse:
 *   its minute less the vote window is the Proposal's receipt in an earlier
 *   week's mailbox, so the relay could tie the two weeks' ids together.
 * - **Upkeep**, after each sync pass that reached the relay: each group with
 *   push on is registered again 7 days after the relay last took it, or when
 *   this device's endpoint, the relay's `instance` or the group's mailboxes
 *   change. A registration names each week's mailbox from now to 30 days
 *   on and, before them, the week of each Proposal still open, where its
 *   nudges wait (#110). Then, if the relay's key isn't the one the subscription was made
 *   with (a rebuilt relay), the device subscribes again, and each group's old
 *   endpoint is forgotten as the new one is registered. After a failure the
 *   upkeep rests for an hour, so a refusal never repeats every few seconds.
 *
 * Registrations and nudges take their mailbox only from `mailboxAt`
 * (./mailbox.ts). The relay hears only endpoints and relay minutes: the
 * request bodies hold `endpoint` or `not_before` and nothing else.
 *
 * What the relay can link, and the switch's disclosure says: one endpoint
 * under several groups' mailboxes shows that one phone is in each of them,
 * and ties a group's weekly mailboxes together (ADR-0075 §2, revisited by
 * #130). Erase sends nothing (#78): unregistering
 * the service worker ends the subscription, so the push service refuses the
 * relay's next push and the relay forgets the endpoint everywhere.
 */
import { fold } from '../engine/fold';
import { nudgeKey, nudgesFor, type Nudge } from '../engine/nudges';
import { DAY_MINUTES } from '../engine/rules';
import type { PushRelay } from '../net/push';
import { RelayError } from '../net/relay';
import type { DeviceSubscription, PushPort } from '../platform/pushPort';
import type { Group, Store } from './db';
import { mailboxAt as defaultMailboxAt, type MailboxAt, mailboxesFrom } from './mailbox';

/** How often a registration is renewed, in relay minutes: the relay keeps one 30 days. */
export const RENEW_MINUTES = 7 * DAY_MINUTES;

/** How long upkeep rests after a failure, in device milliseconds. */
export const REST_MS = 3_600_000;

/** Whether this device can get push now: not at all, blocked in its settings, or ready to ask. */
export type PushAvailability = 'unsupported' | 'blocked' | 'ready';

/** How turning a group on went. */
export type TurnOnOutcome = 'on' | 'blocked' | 'dismissed' | 'unavailable' | 'failed';

/** What push needs. */
export interface PushOptions {
  /** The device's groups. */
  readonly store: Pick<Store, 'getGroup' | 'listGroups' | 'setPush' | 'markNudged'>;
  /** The relay's push routes. */
  readonly relay: PushRelay;
  /** The browser's notifications and Push API. */
  readonly port: PushPort;
  /** A group's mailbox at a relay minute (default: the store's one seam). */
  readonly mailboxAt?: MailboxAt;
  /** The device clock in milliseconds, for upkeep's rest (default: `Date.now`). */
  readonly clock?: () => number;
}

/** What Settings asks of push. */
export interface PushControls {
  /** Whether this device can get push now. */
  availability(): PushAvailability;
  /** Turns `groupId` on; call it straight from the tap, since it asks permission first. */
  turnOn(groupId: string): Promise<TurnOnOutcome>;
  /** Turns `groupId` off. */
  turnOff(groupId: string): Promise<void>;
}

/** What the sync loop asks of push. */
export interface PushUpkeep {
  /** Posts the nudges due for this device's own open Proposals in `groupId`, each once. */
  nudge(groupId: string): Promise<void>;
  /** Keeps every group with push on registered at the relay. Never rejects. */
  upkeep(): Promise<void>;
  /** Fires a `keepalive` DELETE of `group`'s registration, before the group is purged; doesn't wait. */
  forget(group: Group): void;
}

/** Push: Settings' controls and the sync loop's upkeep. */
export type Push = PushControls & PushUpkeep;

/** True while `group` takes new things on this device: it isn't leaving, nor a read-only archive (#108). */
function isLive(group: Group): boolean {
  return group.leaving === undefined && group.archived === undefined;
}

/**
 * True while push is on for `group` and it is live: a read-only archive gets
 * no upkeep, so its registration is left to expire at the relay (#108).
 */
function isOn(group: Group): group is Group & Required<Pick<Group, 'push'>> {
  return group.push !== undefined && isLive(group);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Every mailbox `group`'s registration names at relay minute `now` (#110):
 * the week of each Proposal still open, where its proposer's nudges wait,
 * then each week's from now to 30 days on, each named once, in order.
 */
function registrationOf(group: Group, now: number, at: MailboxAt): string[] {
  const open = fold(group.log, group.relayNow).proposals.filter((proposal) => !proposal.final);
  const waiting = open.map((proposal) => at(group, proposal.received));
  return [...new Set([...waiting, ...mailboxesFrom(group, now, at)])];
}

/** True for a refusal that asking again won't change: any 4xx answer. */
function isFinal(error: unknown): boolean {
  return error instanceof RelayError && error.status >= 400 && error.status < 500;
}

/** What a failed turn-on tells the person: the device or relay can't do push, or it didn't get through. */
function failureOf(error: unknown): TurnOnOutcome {
  if (error instanceof RelayError) {
    const cannot = error.code === 'push_unavailable' || error.code === 'push_endpoint_rejected';
    return cannot ? 'unavailable' : 'failed';
  }
  return error instanceof PushServiceRefused ? 'unavailable' : 'failed';
}

/** The browser or its push service wouldn't make a subscription. */
class PushServiceRefused extends Error {
  /** Wrap the browser's refusal. */
  constructor() {
    super('This browser wouldn’t subscribe to push.');
    this.name = 'PushServiceRefused';
  }
}

/** Push over `options.store`, the relay's push routes and the browser's port. */
export function createPush(options: PushOptions): Push {
  const { store, relay, port, mailboxAt = defaultMailboxAt, clock = Date.now } = options;
  /** Each group's log length when its nudges were last all posted: nothing is due until it grows. */
  const posted = new Map<string, number>();
  let restUntil = -Infinity;

  /** Best-effort DELETEs of `endpoint` under each mailbox; never rejects. */
  function forgetAt(mailboxes: readonly string[], endpoint: string, keepalive = false) {
    const each = mailboxes.map((mailbox) =>
      relay.unregister(mailbox, endpoint, { keepalive }).catch(() => undefined),
    );
    return Promise.all(each);
  }

  /** Ends this device's subscription once no group has push on. */
  async function unsubscribeIfNoneOn(): Promise<void> {
    if ((await store.listGroups()).some(isOn)) return;
    await (await port.subscription())?.unsubscribe();
  }

  /**
   * This device's subscription under `key`: the one it holds, or, when that
   * was made under another key, a new one in its place.
   */
  async function subscriptionFor(key: string): Promise<DeviceSubscription> {
    const held = await port.subscription();
    if (held !== null && (held.key === key || held.key === null)) return held;
    await held?.unsubscribe();
    return port.subscribe(key).catch(() => {
      throw new PushServiceRefused();
    });
  }

  /**
   * Registers `endpoint` under each of `group`'s mailboxes from its relay
   * time to 30 days on, then keeps the registration. An endpoint it replaces
   * is forgotten first. A mailbox the group no longer has, as after a key
   * change moved it to new ones (#98) or once its week has passed (#110), is
   * forgotten once the new ones hold the endpoint, so nothing posted to the
   * old mailbox wakes this phone.
   */
  async function register(group: Group, endpoint: string, now: number): Promise<void> {
    const old = group.push;
    if (old !== undefined && old.endpoint !== endpoint) await forgetAt(old.mailboxes, old.endpoint);
    const mailboxes = registrationOf(group, now, mailboxAt);
    for (const mailbox of mailboxes) await relay.register(mailbox, endpoint);
    await store.setPush(group.groupId, { endpoint, mailboxes, instance: group.instance, at: now });
    if (old?.endpoint !== endpoint) return;
    await forgetAt(
      old.mailboxes.filter((mailbox) => !mailboxes.includes(mailbox)),
      endpoint,
    );
  }

  /** True when `group`'s registration needs the relay again for `endpoint`. */
  function isDue(group: Group & Required<Pick<Group, 'push'>>, endpoint: string | null): boolean {
    const { push } = group;
    const now = group.relayNow ?? push.at;
    return (
      push.endpoint !== endpoint ||
      push.instance !== group.instance ||
      now - push.at >= RENEW_MINUTES ||
      !sameList(push.mailboxes, registrationOf(group, now, mailboxAt))
    );
  }

  /** Turning on, once the prompt is up: nothing goes to the relay unless it's granted. */
  async function finishTurnOn(groupId: string, asked: Promise<string>): Promise<TurnOnOutcome> {
    const permission = await asked.catch(() => 'default');
    if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'dismissed';
    try {
      const subscription = await subscriptionFor(await relay.key());
      const group = await store.getGroup(groupId);
      if (group === undefined || group.relayNow === null || !isLive(group)) return 'failed';
      await register(group, subscription.endpoint, group.relayNow);
      return 'on';
    } catch (error) {
      await unsubscribeIfNoneOn().catch(() => undefined);
      return failureOf(error);
    }
  }

  /**
   * Posts one nudge to the mailbox of the week its Proposal was received in
   * (#110); true once it needn't be sent again.
   */
  async function post(group: Group, nudge: Nudge): Promise<boolean> {
    try {
      await relay.nudge(mailboxAt(group, nudge.opened), nudge.minute);
      return true;
    } catch (error) {
      return isFinal(error);
    }
  }

  /**
   * Posts each nudge due for `group`'s own open Proposals that this device
   * hasn't, keeps the ones it has (dropping those no longer due), and, once
   * none is left to send, rests until the log grows.
   */
  async function postDue(group: Group): Promise<void> {
    const due = nudgesFor(fold(group.log, group.relayNow), group.me.author);
    const sent = new Set(group.nudged ?? []);
    for (const nudge of due) {
      if (!sent.has(nudgeKey(nudge)) && (await post(group, nudge))) sent.add(nudgeKey(nudge));
    }
    const kept = due.map(nudgeKey).filter((key) => sent.has(key));
    if (!sameList(kept, group.nudged ?? [])) await store.markNudged(group.groupId, kept);
    if (kept.length === due.length) posted.set(group.groupId, group.log.length);
  }

  /** Turns every group in `groups` off, as when the person took the permission away. */
  async function turnAllOff(groups: readonly (Group & Required<Pick<Group, 'push'>>)[]) {
    for (const group of groups) {
      await store.setPush(group.groupId, null);
      await forgetAt(group.push.mailboxes, group.push.endpoint);
    }
  }

  async function keepUp(): Promise<void> {
    const on = (await store.listGroups()).filter(isOn);
    if (on.length === 0) return;
    const held = await port.subscription();
    if (held === null && port.permission() !== 'granted') {
      await turnAllOff(on);
      return;
    }
    if (!on.some((group) => isDue(group, held?.endpoint ?? null))) return;
    const { endpoint } = await subscriptionFor(await relay.key());
    for (const group of on) {
      if (group.relayNow !== null && isDue(group, endpoint)) {
        await register(group, endpoint, group.relayNow);
      }
    }
  }

  return {
    availability() {
      if (!port.supported) return 'unsupported';
      return port.permission() === 'denied' ? 'blocked' : 'ready';
    },
    turnOn(groupId) {
      if (!port.supported) return Promise.resolve('unavailable');
      // The prompt first, before anything is awaited, so it runs inside the tap.
      return finishTurnOn(groupId, port.requestPermission());
    },
    async turnOff(groupId) {
      const group = await store.getGroup(groupId);
      if (group?.push === undefined) return;
      await store.setPush(groupId, null);
      await forgetAt(group.push.mailboxes, group.push.endpoint);
      await unsubscribeIfNoneOn();
    },
    async nudge(groupId) {
      const group = await store.getGroup(groupId);
      if (group === undefined || !isLive(group)) return;
      if (posted.get(groupId) !== group.log.length) await postDue(group);
    },
    async upkeep() {
      if (clock() < restUntil) return;
      await keepUp().catch(() => {
        restUntil = clock() + REST_MS;
      });
    },
    forget(group) {
      const { push } = group;
      if (push === undefined) return;
      // The DELETEs start now, before the purge; nothing waits on them.
      void forgetAt(push.mailboxes, push.endpoint, true)
        .then(unsubscribeIfNoneOn)
        .catch(() => undefined);
    },
  };
}
