/**
 * Real group state for screen tests, built through the engine: events made
 * with `createEvent` and folded with `fold`, never hand-written state.
 */
import { createEvent, type EventInput } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';

/** What a test group holds. Members' authors are their names in lower case. */
export interface TestGroupOptions {
  readonly name?: string;
  readonly founder?: string;
  readonly title?: string;
  readonly atoms?: readonly string[];
  readonly chat?: string;
  readonly joiners?: readonly string[];
  readonly proposals?: readonly string[];
}

/** A folded group, its relay records, and the founder's author id. */
export interface TestGroup {
  readonly state: GroupState;
  readonly records: readonly LogRecord[];
  readonly founder: string;
}

const MINUTE = 29_000_000;

const DEFAULTS = {
  name: 'Riverside Tenants',
  founder: 'Ana',
  title: 'House rules',
  atoms: ['Quiet hours start at ten.', 'Bins go out on Tuesday.'],
  joiners: [],
  proposals: [],
} as const satisfies TestGroupOptions;

/** Folds a group founded by `founder`, joined by `joiners`, with one Proposal per title. */
export function testGroup(options: TestGroupOptions = {}): TestGroup {
  const { name, founder, title, atoms, chat, joiners, proposals } = { ...DEFAULTS, ...options };
  const records: LogRecord[] = [];
  const add = (input: EventInput): string => {
    const { bytes, id } = createEvent(input);
    records.push({ seq: records.length + 1, received: MINUTE + records.length, bytes });
    return id;
  };
  const author = founder.toLowerCase();
  const body = { name, founder, title, atoms, ...(chat === undefined ? {} : { chat }) };
  const group = add({ type: 'genesis', group: '', author, ts: 0, body });
  for (const joiner of joiners) {
    add({ type: 'join', group, author: joiner.toLowerCase(), ts: 0, body: { name: joiner } });
  }
  for (const proposal of proposals) {
    const proposalBody = {
      atom: `${group}.0`,
      title: proposal,
      why: 'Why not.',
      text: 'New text.',
    };
    add({ type: 'proposal', group, author, ts: 0, body: proposalBody });
  }
  return { state: fold(records, MINUTE + records.length), records, founder: author };
}
