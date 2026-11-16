/**
 * Real group state for screen tests, built through the engine: events signed
 * with `signEvent` and folded with `fold`, never hand-written state.
 */
import { signInviteToken } from '../crypto/invite';
import { type Level, LEVELS } from '../engine/capabilities';
import { base64url, type EventDraft } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { authorOf, signedAs, testKeys } from './keys';
import { SETTLED_MINUTES, settlingVouches } from './votes';

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
  /** Who invited each joiner, by name: their join carries that member's token (#73). */
  readonly invitedBy?: Readonly<Record<string, string>>;
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

/** The joiner's join: at their level in `options`, a Co-Creator by default, with any inviter's token. */
function joinDraft(group: string, joiner: string, options: TestGroupOptions): EventDraft {
  const level = options.levels?.[joiner] ?? CREATING;
  const token = tokenFrom(options.invitedBy?.[joiner]?.toLowerCase(), group);
  return { type: 'join', group, ts: 0, body: { name: joiner, level, ...token } };
}

/** A vouch for the joiner named, in `group`. */
function vouchDraft(group: string, joiner: string): EventDraft {
  return { type: 'vouch', group, ts: 0, body: { member: authorOf(joiner.toLowerCase()) } };
}

/** The token a join carries when `inviter` (lower case) invited the joiner, else nothing (#73). */
function tokenFrom(inviter: string | undefined, group: string) {
  if (inviter === undefined) return {};
  const sig = base64url(signInviteToken(testKeys(inviter).secretKey, group));
  return { token: { by: authorOf(inviter), sig } };
}

/**
 * Folds a group founded by `founder`, joined by `joiners`, with one Proposal
 * per title. The joiners hold voting rights by the first Proposal: they join
 * SETTLED_MINUTES before it, and the founder and the first voting joiner
 * vouch for each one after the bootstrap's first two (#101).
 */
export function testGroup(options: TestGroupOptions = {}): TestGroup {
  const { name, founder, title, atoms, chat, joiners, proposals } = { ...DEFAULTS, ...options };
  const records: LogRecord[] = [];
  let start = MINUTE - SETTLED_MINUTES;
  const add = (name: string, draft: EventDraft): string => {
    const { record, id } = signedAs(name.toLowerCase(), draft);
    records.push({ seq: records.length + 1, received: start + records.length, bytes: record });
    return id;
  };
  const documents = [{ title, atoms }];
  const body = { name, founder, documents, ...(chat === undefined ? {} : { chat }) };
  const group = add(founder, { type: 'genesis', group: '', ts: 0, body });
  for (const joiner of joiners) add(joiner, joinDraft(group, joiner, options));
  for (const [voucher, joiner] of settlingVouches(founder, joiners, options.levels ?? {})) {
    add(voucher, vouchDraft(group, joiner));
  }
  start = MINUTE;
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
