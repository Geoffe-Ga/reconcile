/**
 * Real group state for screen tests, built through the engine: events signed
 * with `signEvent` and folded with `fold`, never hand-written state.
 */
import type { EventDraft } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { authorOf, signedAs } from './keys';

/** What a test group holds. Each member signs with the test key of their name in lower case. */
export interface TestGroupOptions {
  readonly name?: string;
  readonly founder?: string;
  readonly title?: string;
  readonly atoms?: readonly string[];
  readonly chat?: string;
  readonly joiners?: readonly string[];
  readonly proposals?: readonly string[];
}

/** A folded group, its relay records, and the founder's author key. */
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
  const add = (name: string, draft: EventDraft): string => {
    const { record, id } = signedAs(name.toLowerCase(), draft);
    records.push({ seq: records.length + 1, received: MINUTE + records.length, bytes: record });
    return id;
  };
  const body = { name, founder, title, atoms, ...(chat === undefined ? {} : { chat }) };
  const group = add(founder, { type: 'genesis', group: '', ts: 0, body });
  for (const joiner of joiners) {
    add(joiner, { type: 'join', group, ts: 0, body: { name: joiner } });
  }
  for (const proposal of proposals) {
    const proposalBody = {
      atom: `${group}.0`,
      title: proposal,
      why: 'Why not.',
      text: 'New text.',
    };
    add(founder, { type: 'proposal', group, ts: 0, body: proposalBody });
  }
  const author = authorOf(founder.toLowerCase());
  return { state: fold(records, MINUTE + records.length), records, founder: author };
}
