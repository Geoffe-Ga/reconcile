/**
 * Groups with Proposals and ballots for screen tests, built through the
 * engine: events made with `createEvent` and folded with `fold`, never
 * hand-written state. Members' authors are their names in lower case.
 */
import { createEvent, type EventInput, type Score } from '../engine/event';
import { fold, type GroupState, type LogRecord, VOTE_WINDOW_MINUTES } from '../engine/fold';

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
  /** Adds a join by `name`. */
  join(name: string): void;
  /** Adds a Proposal by `name`, returning its id. */
  propose(name: string, entry?: ProposalEntry): string;
  /** Adds `name`'s ballot on `proposal`, scoring its text. */
  vote(name: string, proposal: string, score: Score, note?: string): void;
  /** The records so far, in relay order. */
  readonly records: readonly LogRecord[];
  /** The folded state, with the relay's `now` (default: the current minute). */
  state(relayNow?: number): GroupState;
}

/** What a test group starts with. */
export interface GroupStart {
  readonly founder?: string;
  readonly members?: readonly string[];
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
  const add = (input: EventInput): string => {
    const { bytes, id } = createEvent(input);
    records.push({ seq: records.length + 1, received: builder.minute, bytes });
    return id;
  };
  const author = (name: string) => name.toLowerCase();
  const body = {
    name: 'Riverside Tenants',
    founder,
    title: 'House rules',
    atoms,
    ...(chat === undefined ? {} : { chat }),
  };
  builder.group = add({ type: 'genesis', group: '', author: author(founder), ts: 0, body });
  const { group } = builder;
  const log: LogBuilder = Object.assign(builder, {
    join(name: string) {
      add({ type: 'join', group, author: author(name), ts: 0, body: { name } });
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
      return add({ type: 'proposal', group, author: author(name), ts: 0, body: proposal });
    },
    vote(name: string, proposal: string, score: Score, note?: string) {
      const vote = {
        proposal,
        scores: { [proposal]: score },
        ...(note === undefined ? {} : { note }),
      };
      add({ type: 'vote', group, author: author(name), ts: 0, body: vote });
    },
    state(relayNow?: number) {
      return fold(records, relayNow ?? builder.minute);
    },
  });
  for (const member of members) log.join(member);
  return log;
}

/** The relay minute a Proposal received at `received` closes at. */
export function deadlineOf(received: number): number {
  return received + VOTE_WINDOW_MINUTES;
}
