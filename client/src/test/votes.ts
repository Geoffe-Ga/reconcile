/**
 * Groups with Proposals and ballots for screen tests, built through the
 * engine: events signed with `signEvent` and folded with `fold`, never
 * hand-written state. Each member signs with the test key of their name in
 * lower case, so `authorOf('ana')` names Ana.
 */
import { type Level, LEVELS } from '../engine/capabilities';
import type { EventDraft, ResultBody, Score } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { DEFAULT_RULES, defaultWindowMinutes } from '../engine/rules';
import { signedAs } from './keys';

/** The level a member joins at unless a test names one: the creating level. */
const [, , CREATING] = LEVELS;

/** The relay minute the log starts at. */
export const START_MINUTE = 29_000_000;

/** What a new Proposal says; it targets the first Atom unless told otherwise. */
export interface ProposalEntry {
  readonly title?: string;
  readonly why?: string;
  readonly text?: string;
  readonly link?: string;
  readonly atom?: number;
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
  /** Adds a Proposal by `name`, returning its id. */
  propose(name: string, entry?: ProposalEntry): string;
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
  /** The records so far, in relay order. */
  readonly records: readonly LogRecord[];
  /**
   * The folded state, with the relay's `now` (default: the current minute) and
   * the Proposals whose ballots the device has cleared (#111).
   */
  state(relayNow?: number, cleared?: readonly string[]): GroupState;
}

/** What a test group starts with. */
export interface GroupStart {
  readonly founder?: string;
  readonly members?: readonly string[];
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
    minute: START_MINUTE,
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
    state(relayNow?: number, cleared: readonly string[] = []) {
      return fold(records, relayNow ?? builder.minute, cleared);
    },
  });
  for (const member of members) log.join(member, start.levels?.[member]);
  return log;
}

/** The relay minute an ordinary Proposal received at `received` closes at. */
export function deadlineOf(received: number): number {
  return received + defaultWindowMinutes(DEFAULT_RULES, 'ordinary');
}
