/**
 * Groups with Proposals and ballots for screen tests, built through the
 * engine: events signed with `signEvent` and folded with `fold`, never
 * hand-written state. Each member signs with the test key of their name in
 * lower case, so `authorOf('ana')` names Ana.
 */
import { type Capability, type Level, LEVEL_CAPABILITIES, LEVELS } from '../engine/capabilities';
import type { CarriedDispatch, DispatchBody, EventDraft, ResultBody, Score } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES, defaultWindowMinutes } from '../engine/rules';
import { authorOf, signedAs } from './keys';

/** The level a member joins at unless a test names one: the creating level. */
const [, , CREATING] = LEVELS;

/** The relay minute the log stands at once its starting members hold voting rights. */
export const START_MINUTE = 29_000_000;

/**
 * How long before {@link START_MINUTE} the group is founded and its starting
 * members join: past the wait before voting, so each of them, vouched for,
 * holds voting rights from START_MINUTE on (#101).
 */
export const SETTLED_MINUTES = DEFAULT_RULES.waitDays * DAY_MINUTES + 60;

/** What a new Proposal says; it targets the first Atom unless told otherwise. */
export interface ProposalEntry {
  readonly title?: string;
  readonly why?: string;
  readonly text?: string;
  readonly link?: string;
  readonly atom?: number;
  /** The voting window in days; the class default when left out. */
  readonly window?: number;
  /** The Dispatch it sends if it passes (#112); none when left out. */
  readonly dispatch?: CarriedDispatch;
}

/** A group's log under construction, one relay record at a time. */
export interface LogBuilder {
  /** The group id: the genesis event's id. */
  readonly group: string;
  /** The relay minute the next record is received at. */
  minute: number;
  /** Adds a join by `name`, at `level` (a Co-Creator unless named). */
  join(name: string, level?: Level): void;
  /** Adds `name`'s move to `level`. */
  level(name: string, level: string): void;
  /** Adds `name`'s leave. */
  leave(name: string): void;
  /** Adds a Proposal by `name`, returning its id. Text `""` proposes removing the Atom. */
  propose(name: string, entry?: ProposalEntry): string;
  /** Adds `name`'s Proposal of a new section after Atom `after`, or first for null (#75). */
  addSection(name: string, after: string | null, entry?: ProposalEntry): string;
  /** Adds `name`'s ballot on `proposal`, scoring its text. */
  vote(name: string, proposal: string, score: Score, note?: string): void;
  /** Adds a version of `proposal` by `name`, returning its id. */
  version(name: string, proposal: string, text: string): string;
  /** Adds `name`'s ballot on `proposal`, scoring each version it names, with an optional salt. */
  ballot(
    name: string,
    proposal: string,
    scores: Readonly<Record<string, Score>>,
    note?: string,
    salt?: string,
  ): void;
  /** Adds `name`'s result for a decided Proposal (#111), returning its id. */
  result(name: string, body: ResultBody): string;
  /** Adds `name`'s steward Proposal for `seat`: electing `nominee` by name, or a recall for null. */
  steward(name: string, seat: number, nominee: string | null, entry?: ProposalEntry): string;
  /** Adds `name`'s suspension of the person named `who`, with an optional reason. */
  suspend(name: string, who: string, reason?: string): string;
  /** Adds `name`'s Proposal to dissolve the group, wiping every copy when `wipe` (#108), returning its id. */
  proposeDissolve(name: string, wipe: boolean, entry?: ProposalEntry): string;
  /** Adds `name`'s `dissolve`, naming the dissolve Proposal `proposal` (#108). */
  dissolve(name: string, proposal: string): string;
  /** Adds `name`'s rules Proposal setting `optIn` to `value` (#117), returning its id. */
  rules(name: string, optIn: string, value: unknown, entry?: ProposalEntry): string;
  /** Adds `name`'s narrowing of `optIn` beside the off-Proposal `proposal` (#117), returning its id. */
  narrow(name: string, optIn: string, proposal: string): string;
  /** Adds `name`'s vouch for the person named `who` (#101), returning its id. */
  vouch(name: string, who: string): string;
  /** Adds `name`'s chat bot claim of `moment` on `proposal` (#119), returning its id. */
  chatPosted(name: string, proposal: string, moment: string, nonce?: string): string;
  /** Adds `name`'s Proposal to remove the person named `who` (#115), returning its id. */
  proposeRemoval(name: string, who: string, entry?: ProposalEntry): string;
  /** Adds `name`'s response on the removal `proposal` (#115), returning its id. */
  respond(name: string, proposal: string, text: string): string;
  /** Adds `name`'s `remove`, naming the removal `proposal` whose pass is final (#115). */
  remove(name: string, proposal: string): string;
  /** Adds `name`'s record of `proposal`'s Discord thread at `url` (#123), returning its id. */
  chatThread(name: string, proposal: string, url: string): string;
  /** Adds `name`'s Dispatch (#112), returning its id. */
  dispatch(name: string, body: DispatchBody): string;
  /** The records so far, in relay order. */
  readonly records: readonly LogRecord[];
  /**
   * The folded state, with the relay's `now` (default: the current minute) and
   * the Proposals whose ballots the device has cleared (#111).
   */
  state(relayNow?: number, cleared?: readonly string[]): GroupState;
}

/**
 * What a test group starts with. The founder and `members` hold voting rights
 * by START_MINUTE: they join SETTLED_MINUTES earlier, and the founder and the
 * first voting member vouch for each one after the bootstrap's first two
 * (#101). `newcomers` join at START_MINUTE after them, with no vouches, so
 * they read and follow until they earn a vote.
 */
export interface GroupStart {
  readonly founder?: string;
  readonly members?: readonly string[];
  readonly newcomers?: readonly string[];
  /** Each member's level at join, by name; a member not named joins as a Co-Creator. */
  readonly levels?: Readonly<Record<string, Level>>;
  readonly atoms?: readonly string[];
  readonly chat?: string;
}

/** Starts a log with a genesis by `founder` (default Ana), then a join for each other member. */
export function groupLog(start: GroupStart = {}): LogBuilder {
  const { founder = 'Ana', members = ['Ben'], chat } = start;
  const atoms = start.atoms ?? ['Quiet hours start at ten.', 'Bins go out on Tuesday.'];
  const records: LogRecord[] = [];
  const builder = {
    group: '',
    minute: START_MINUTE - SETTLED_MINUTES,
    records,
  };
  const add = (name: string, draft: EventDraft): string => {
    const { record, id } = signedAs(name.toLowerCase(), draft);
    records.push({ seq: records.length + 1, received: builder.minute, bytes: record });
    return id;
  };
  const body = {
    name: 'Riverside Tenants',
    founder,
    title: 'House rules',
    atoms,
    ...(chat === undefined ? {} : { chat }),
  };
  builder.group = add(founder, { type: 'genesis', group: '', ts: 0, body });
  const { group } = builder;
  const log: LogBuilder = Object.assign(builder, {
    join(name: string, level: Level = CREATING) {
      add(name, { type: 'join', group, ts: 0, body: { name, level } });
    },
    level(name: string, level: string) {
      add(name, { type: 'level', group, ts: 0, body: { level } });
    },
    leave(name: string) {
      add(name, { type: 'leave', group, ts: 0, body: {} });
    },
    propose(name: string, entry: ProposalEntry = {}) {
      const {
        title = 'Later quiet hours',
        why = 'Weekends run late.',
        text = 'Quiet after 11pm.',
      } = entry;
      const proposal = {
        atom: `${group}.${String(entry.atom ?? 0)}`,
        title,
        why,
        text,
        ...(entry.link === undefined ? {} : { link: entry.link }),
        ...(entry.window === undefined ? {} : { window: entry.window }),
        ...(entry.dispatch === undefined ? {} : { dispatch: entry.dispatch }),
      };
      return add(name, { type: 'proposal', group, ts: 0, body: proposal });
    },
    addSection(name: string, after: string | null, entry: ProposalEntry = {}) {
      const {
        title = 'Guests',
        why = 'Guests come often.',
        text = 'Guests leave by 11pm.\n',
      } = entry;
      const proposal = {
        target: { kind: 'add', after } as const,
        title,
        why,
        text,
        ...(entry.link === undefined ? {} : { link: entry.link }),
        ...(entry.dispatch === undefined ? {} : { dispatch: entry.dispatch }),
      };
      return add(name, { type: 'proposal', group, ts: 0, body: proposal });
    },
    vote(name: string, proposal: string, score: Score, note?: string) {
      log.ballot(name, proposal, { [proposal]: score }, note);
    },
    version(name: string, proposal: string, text: string) {
      return add(name, { type: 'version', group, ts: 0, body: { proposal, text } });
    },
    ballot(
      name: string,
      proposal: string,
      scores: Readonly<Record<string, Score>>,
      note?: string,
      salt?: string,
    ) {
      const vote = {
        proposal,
        scores,
        ...(note === undefined ? {} : { note }),
        ...(salt === undefined ? {} : { salt }),
      };
      add(name, { type: 'vote', group, ts: 0, body: vote });
    },
    result(name: string, body: ResultBody) {
      return add(name, { type: 'result', group, ts: 0, body });
    },
    steward(name: string, seat: number, nominee: string | null, entry: ProposalEntry = {}) {
      const member = nominee === null ? null : authorOf(nominee.toLowerCase());
      const { title = 'A steward for our group', why = 'Someone to step in.' } = entry;
      const body = { target: { kind: 'steward' as const, seat, member }, title, why };
      return add(name, { type: 'proposal', group, ts: 0, body });
    },
    suspend(name: string, who: string, reason?: string) {
      const body = {
        member: authorOf(who.toLowerCase()),
        ...(reason === undefined ? {} : { reason }),
      };
      return add(name, { type: 'suspend', group, ts: 0, body });
    },
    proposeDissolve(name: string, wipe: boolean, entry: ProposalEntry = {}) {
      const { title = 'Dissolve our group', why = 'We have all moved out.' } = entry;
      const body = {
        target: { kind: 'dissolve' as const, wipe },
        title,
        why,
        ...(entry.window === undefined ? {} : { window: entry.window }),
      };
      return add(name, { type: 'proposal', group, ts: 0, body });
    },
    dissolve(name: string, proposal: string) {
      return add(name, { type: 'dissolve', group, ts: 0, body: { proposal } });
    },
    rules(name: string, optIn: string, value: unknown, entry: ProposalEntry = {}) {
      const { title = 'Our chat bot', why = 'A nudge when votes open.' } = entry;
      const target = { kind: 'rules' as const, optIn, value };
      const body = {
        target,
        title,
        why,
        ...(entry.window === undefined ? {} : { window: entry.window }),
      };
      return add(name, { type: 'proposal', group, ts: 0, body });
    },
    narrow(name: string, optIn: string, proposal: string) {
      return add(name, { type: 'narrow', group, ts: 0, body: { optIn, proposal } });
    },
    vouch(name: string, who: string) {
      const body = { member: authorOf(who.toLowerCase()) };
      return add(name, { type: 'vouch', group, ts: 0, body });
    },
    chatPosted(name: string, proposal: string, moment: string, nonce?: string) {
      const body = { proposal, moment, ...(nonce === undefined ? {} : { nonce }) };
      return add(name, { type: 'chat-posted', group, ts: 0, body });
    },
    proposeRemoval(name: string, who: string, entry: ProposalEntry = {}) {
      const { title = `Remove ${who}`, why = 'They keep breaking the house rules.' } = entry;
      const target = { kind: 'remove' as const, member: authorOf(who.toLowerCase()) };
      const carried = entry.dispatch === undefined ? {} : { dispatch: entry.dispatch };
      return add(name, {
        type: 'proposal',
        group,
        ts: 0,
        body: { target, title, why, ...carried },
      });
    },
    respond(name: string, proposal: string, text: string) {
      return add(name, { type: 'removal-response', group, ts: 0, body: { proposal, text } });
    },
    remove(name: string, proposal: string) {
      return add(name, { type: 'remove', group, ts: 0, body: { proposal } });
    },
    chatThread(name: string, proposal: string, url: string) {
      return add(name, { type: 'chat-thread', group, ts: 0, body: { proposal, url } });
    },
    dispatch(name: string, body: DispatchBody) {
      return add(name, { type: 'dispatch', group, ts: 0, body });
    },
    state(relayNow?: number, cleared: readonly string[] = []) {
      return fold(records, relayNow ?? builder.minute, [], cleared);
    },
  });
  for (const member of members) log.join(member, start.levels?.[member]);
  settle(log, start, founder, members);
  return log;
}

/**
 * Gives the starting members their vouches, moves the log on to
 * START_MINUTE, past their wait, and joins the newcomers there (#101).
 */
function settle(log: LogBuilder, start: GroupStart, founder: string, members: readonly string[]) {
  const levels = start.levels ?? {};
  for (const [voucher, member] of settlingVouches(founder, members, levels)) {
    log.vouch(voucher, member);
  }
  log.minute = START_MINUTE;
  for (const newcomer of start.newcomers ?? []) log.join(newcomer, levels[newcomer]);
}

/**
 * The vouches a test group's starting members need to hold voting rights
 * (#101), as `[voucher, member]` names: the founder and the first starting
 * member at a voting level vouch for each starting member after the
 * bootstrap's first two. A member not in `levels` is a Co-Creator.
 */
export function settlingVouches(
  founder: string,
  members: readonly string[],
  levels: Readonly<Record<string, Level>>,
): [string, string][] {
  const votes = (name: string) => {
    const granted: readonly Capability[] = LEVEL_CAPABILITIES[levels[name] ?? CREATING];
    return granted.includes('vote');
  };
  const vouchers = [founder, ...members.slice(0, 2)].filter(votes).slice(0, 2);
  return members
    .slice(2)
    .flatMap((member) => vouchers.map((voucher): [string, string] => [voucher, member]));
}

/** The relay minute an ordinary Proposal received at `received` closes at. */
export function deadlineOf(received: number): number {
  return received + defaultWindowMinutes(DEFAULT_RULES, 'ordinary');
}
