/**
 * Real group state for screen tests, built through the engine: events signed
 * with `signEvent` and folded with `fold`, never hand-written state.
 */
import { type Level, LEVELS } from '../engine/capabilities';
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
  /** Each joiner's level, by name; a joiner not named joins as a Co-Creator. */
  readonly levels?: Readonly<Record<string, Level>>;
  readonly proposals?: readonly string[];
}

/** A folded group, its relay records, and the founder's author key. */
export interface TestGroup {
  readonly state: GroupState;
  readonly records: readonly LogRecord[];
  readonly founder: string;
}

const MINUTE = 29_000_000;

/** The level a joiner joins at unless a test names one: the creating level. */
const [, , CREATING] = LEVELS;

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
    const level = options.levels?.[joiner] ?? CREATING;
    add(joiner, { type: 'join', group, ts: 0, body: { name: joiner, level } });
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
