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
 * - **Leave and a removal** (`forget`, #356): just before the sync loop
 *   purges a group this device left, or archives one a vote removed this
 *   member from, the device notes a DELETE it owes under each of the group's
 *   registered mailboxes, due at a minute drawn at random from the CSPRNG
 *   within the next day ({@link FORGET_WINDOW_MINUTES}). Upkeep sends them at
 *   its first run at or after then, never in the pass that let the group go,
 *   so the relay can't line an endpoint's unregistering up with the group's
 *   key change. The device store keeps them (`PushForgetStore`), so they
 *   outlive the purge and a reload. One the relay didn't take is owed still,
 *   after upkeep's rest. The subscription ends at once, as before, if no
 *   other group has push on, which the relay hears of only if it pushes to
 *   the endpoint again.
 * - **Nudges:** after each group syncs, this device asks the relay to wake the
 *   group a day before each of its own open Proposals closes and at its
 *   deadline (`engine/nudges.ts`), each once, in the mailbox of the week the
 *   Proposal was received in (#110). The deadline's own week would do worse:
 *   its minute less the vote window is the Proposal's receipt in an earlier
 *   week's mailbox, so the relay could tie the two weeks' ids together. So
 *   does every device of a member a coalition's open motion is open to
 *   (#284), the group folded with the coalitions on the device, at those
 *   minutes shifted by the group's offset for the motion
 *   (`crypto/nudgeOffset.ts`), so no two groups' nudges for one motion line
 *   up but by chance. The relay keeps one nudge per mailbox and minute.
 * - **Upkeep**, after each sync pass that reached the relay: each group with
 *   push on is registered again 7 days after the relay last took it, or when
 *   this device's endpoint, the relay's `instance` or the group's mailboxes
 *   change. A registration names each week's mailbox from now to 30 days
 *   on and, before them, the week of each Proposal still open, a coalition's
 *   motion included (#284), where its nudges wait (#110). Then, if the relay's key isn't the one the subscription was made
 *   with (a rebuilt relay), the device subscribes again, and each group's old
 *   endpoint is forgotten as the new one is registered. After a failure the
 *   upkeep rests for an hour, so a refusal never repeats every few seconds.
 *
 * Registrations, nudges and forgets take their mailbox only from `mailboxAt`
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
import { nudgeOffset } from '../crypto/nudgeOffset';
import { drawBelow, type Random, randomBytes } from '../crypto/random';
import type { GroupState } from '../engine/fold';
import { nudgeKey, nudgesFor, type Nudge } from '../engine/nudges';
import { DAY_MINUTES } from '../engine/rules';
import type { PushRelay } from '../net/push';
import { RelayError } from '../net/relay';
import type { DeviceSubscription, PushPort } from '../platform/pushPort';
import { MINUTE_MS } from './archive';
import { foldCoalitions, foldWithCoalitions, type HeldCoalition } from './coalitions';
import type { Group, PushForget, Store } from './db';
import { mailboxAt as defaultMailboxAt, type MailboxAt, mailboxesFrom } from './mailbox';

/** How often a registration is renewed, in relay minutes: the relay keeps one 30 days. */
export const RENEW_MINUTES = 7 * DAY_MINUTES;

/** How long upkeep rests after a failure, in device milliseconds. */
export const REST_MS = 3_600_000;

/**
 * The minutes a forgotten group's DELETEs wait at most (#356): a day. They
 * go 1 to 1,440 minutes after the pass that let the group go, each minute as
 * likely as another.
 */
export const FORGET_WINDOW_MINUTES = DAY_MINUTES;

/** Whether this device can get push now: not at all, blocked in its settings, or ready to ask. */
export type PushAvailability = 'unsupported' | 'blocked' | 'ready';

/** How turning a group on went. */
export type TurnOnOutcome = 'on' | 'blocked' | 'dismissed' | 'unavailable' | 'failed';

/** What push needs. */
export interface PushOptions {
  /** The device's groups. */
  readonly store: Pick<
    Store,
    | 'getGroup'
    | 'listGroups'
    | 'listCoalitions'
    | 'setPush'
    | 'markNudged'
    | 'listPushForgets'
    | 'updatePushForgets'
  >;
  /** The relay's push routes. */
  readonly relay: PushRelay;
  /** The browser's notifications and Push API. */
  readonly port: PushPort;
  /** A group's mailbox at a relay minute (default: the store's one seam). */
  readonly mailboxAt?: MailboxAt;
  /** The device clock in milliseconds, for upkeep's rest and a forget's minute (default: `Date.now`). */
  readonly clock?: () => number;
  /** Random bytes for a forget's minute (#356): the platform's CSPRNG (default: `crypto/random.ts`). */
  readonly random?: Random;
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
  /**
   * Posts the nudges due in `groupId` for this device's own open Proposals,
   * and for the coalitions' open motions its member may vote on, each once.
   */
  nudge(groupId: string): Promise<void>;
  /** Keeps every group with push on registered at the relay, and sends the DELETEs due. Never rejects. */
  upkeep(): Promise<void>;
  /**
   * Notes a DELETE owed under each of `group`'s registered mailboxes, due at
   * a random minute within the next day (#356), before the group is purged or
   * archived, and ends the subscription if no other group has push on. Never
   * rejects: when the store can't note them, the registration is left to
   * lapse at the relay within 30 days, as a dissolved group's is (#108).
   */
  forget(group: Group): Promise<void>;
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

/** True when `a` and `b` are the same DELETE owed (#356). */
function sameForget(a: PushForget, b: PushForget): boolean {
  return a.endpoint === b.endpoint && a.mailbox === b.mailbox;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Every mailbox `group`'s registration names at relay minute `now` (#110):
 * the week of each Proposal still open, a coalition's motion among
 * `coalitions` included (#284), where its nudges wait, then each week's from
 * now to 30 days on, each named once, in order.
 */
function registrationOf(
  group: Group,
  now: number,
  at: MailboxAt,
  coalitions: readonly HeldCoalition[],
): string[] {
  const open = foldWithCoalitions(group, coalitions).proposals.filter((p) => !p.final);
  const waiting = open.map((proposal) => at(group, proposal.received));
  return [...new Set([...waiting, ...mailboxesFrom(group, now, at)])];
}

/**
 * What `group`'s nudges stand on (#284): its log, and each coalition entry's
 * on the device, since a motion opens in the group from a coalition's log
 * with no new record of its own. Nothing is due until it changes.
 */
function nudgeMark(group: Group, entries: readonly Group[]): string {
  const logs = entries.map((entry) => `${entry.groupId}:${String(entry.log.length)}`);
  return [String(group.log.length), ...logs].join(' ');
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
  const random = options.random ?? randomBytes;
  /** Each group's {@link nudgeMark} when its nudges were last all posted: nothing is due until it changes. */
  const posted = new Map<string, string>();
  let restUntil = -Infinity;

  /** Best-effort DELETEs of `endpoint` under each mailbox; never rejects. */
  function forgetAt(mailboxes: readonly string[], endpoint: string) {
    const each = mailboxes.map((mailbox) =>
      relay.unregister(mailbox, endpoint).catch(() => undefined),
    );
    return Promise.all(each);
  }

  /** Ends this device's subscription once no group but `except`, if given, has push on. */
  async function unsubscribeIfNoneOn(except?: string): Promise<void> {
    const groups = await store.listGroups();
    if (groups.some((group) => group.groupId !== except && isOn(group))) return;
    await (await port.subscription())?.unsubscribe();
  }

  /** Sends one owed DELETE (#356); true once it needn't be sent again. */
  async function sendForget(forget: PushForget): Promise<boolean> {
    try {
      await relay.unregister(forget.mailbox, forget.endpoint);
      return true;
    } catch (error) {
      return isFinal(error);
    }
  }

  /**
   * Sends each owed DELETE that is due (#356), and owes no more each the
   * relay took or refused for good. Rejects after any other failure, so
   * upkeep rests before it tries again.
   */
  async function sendForgetsDue(): Promise<void> {
    const now = clock();
    const due = (await store.listPushForgets()).filter((forget) => forget.due <= now);
    if (due.length === 0) return;
    const done = await Promise.all(due.map(sendForget));
    const sent = due.filter((_, index) => done[index]);
    await store.updatePushForgets((held) =>
      held.filter((forget) => !sent.some((gone) => sameForget(gone, forget))),
    );
    if (sent.length < due.length) throw new Error('The relay didn’t take every DELETE due.');
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
  async function register(
    group: Group,
    endpoint: string,
    now: number,
    coalitions: readonly HeldCoalition[],
  ): Promise<void> {
    const old = group.push;
    if (old !== undefined && old.endpoint !== endpoint) await forgetAt(old.mailboxes, old.endpoint);
    const mailboxes = registrationOf(group, now, mailboxAt, coalitions);
    for (const mailbox of mailboxes) await relay.register(mailbox, endpoint);
    await store.setPush(group.groupId, { endpoint, mailboxes, instance: group.instance, at: now });
    if (old?.endpoint !== endpoint) return;
    await forgetAt(
      old.mailboxes.filter((mailbox) => !mailboxes.includes(mailbox)),
      endpoint,
    );
  }

  /** True when `group`'s registration needs the relay again for `endpoint`, the coalitions on the device as `coalitions`. */
  function isDue(
    group: Group & Required<Pick<Group, 'push'>>,
    endpoint: string | null,
    coalitions: readonly HeldCoalition[],
  ): boolean {
    const { push } = group;
    const now = group.relayNow ?? push.at;
    return (
      push.endpoint !== endpoint ||
      push.instance !== group.instance ||
      now - push.at >= RENEW_MINUTES ||
      !sameList(push.mailboxes, registrationOf(group, now, mailboxAt, coalitions))
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
      const coalitions = foldCoalitions(await store.listCoalitions());
      await register(group, subscription.endpoint, group.relayNow, coalitions);
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
   * Posts each nudge due in `group`, as `state` folds it, that this device
   * hasn't: for its own open Proposals, and, at the group's offset, for the
   * coalitions' open motions its member may vote on (#284). Keeps the ones
   * it has (dropping those no longer due), and, once none is left to send,
   * rests until `mark` changes.
   */
  async function postDue(group: Group, state: GroupState, mark: string): Promise<void> {
    const offsetOf = (motion: string) => nudgeOffset(group.secret, motion);
    const due = nudgesFor(state, group.me.author, offsetOf);
    const sent = new Set(group.nudged ?? []);
    for (const nudge of due) {
      if (!sent.has(nudgeKey(nudge)) && (await post(group, nudge))) sent.add(nudgeKey(nudge));
    }
    const kept = due.map(nudgeKey).filter((key) => sent.has(key));
    if (!sameList(kept, group.nudged ?? [])) await store.markNudged(group.groupId, kept);
    if (kept.length === due.length) posted.set(group.groupId, mark);
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
    const coalitions = foldCoalitions(await store.listCoalitions());
    if (!on.some((group) => isDue(group, held?.endpoint ?? null, coalitions))) return;
    const { endpoint } = await subscriptionFor(await relay.key());
    for (const group of on) {
      if (group.relayNow !== null && isDue(group, endpoint, coalitions)) {
        await register(group, endpoint, group.relayNow, coalitions);
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
      const entries = await store.listCoalitions();
      const mark = nudgeMark(group, entries);
      if (posted.get(groupId) === mark) return;
      await postDue(group, foldWithCoalitions(group, foldCoalitions(entries)), mark);
    },
    async upkeep() {
      if (clock() < restUntil) return;
      const kept = await keepUp().then(
        () => true,
        () => false,
      );
      const sent = await sendForgetsDue().then(
        () => true,
        () => false,
      );
      if (!kept || !sent) restUntil = clock() + REST_MS;
    },
    async forget(group) {
      const { push } = group;
      if (push === undefined) return;
      // 1 to 1,440 minutes on, so the upkeep that ends this pass, moments later, finds none due.
      const due = clock() + (1 + drawBelow(FORGET_WINDOW_MINUTES, random)) * MINUTE_MS;
      const owed = push.mailboxes.map((mailbox) => ({ endpoint: push.endpoint, mailbox, due }));
      await store
        .updatePushForgets((held) => [
          ...held,
          ...owed.filter((forget) => !held.some((kept) => sameForget(kept, forget))),
        ])
        .catch(() => undefined);
      await unsubscribeIfNoneOn(group.groupId).catch(() => undefined);
    },
  };
}
