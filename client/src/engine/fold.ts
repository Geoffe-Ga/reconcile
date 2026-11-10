/**
 * The group fold (docs/spec/phase-1-spec.md §4): a mailbox's records, in relay
 * order, become one `GroupState`.
 *
 * Every rule is checked against the state before the event. An event that
 * breaks one lands in `ignored` and changes nothing. Votes run on relay time
 * (`received`, in whole minutes); the author's `ts` plays no part. Genesis
 * founds the group with its rules, and each Proposal's class, set when it
 * opens, picks its bar and bounds the window its proposer chose. A
 * Document's text changes only when a Proposal's pass is final. Steward seats
 * change when a steward Proposal's pass is final, and a suspension narrows
 * `can()` until it ends (#102): the fold keeps `at`, the relay minute it has
 * reached, and brings the seats up to it before each event. A `result`
 * records a decided Proposal's counts and a commitment to its ballots
 * (#111): with the ballots held, the fold checks it against them, and once a
 * device has cleared them, the Proposal closes, counts and decides by the
 * result it reads ahead. The fold is pure: no I/O, no clock, no randomness,
 * so every device that folds the same records builds the same state.
 */
import {
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  isSuspended,
  type Level,
  wouldVote,
} from './capabilities';
import { ballotCommit, commitEntries, scoreCounts, scoresOf } from './commit';
import { optionFor } from './composeOption';
import {
  EVENT_VERSION,
  type GenesisBody,
  type GroupEvent,
  isStewardProposal,
  type JoinBody,
  type LevelBody,
  type ParsedEvent,
  parseRecord,
  type ProposalBody,
  type ProposalEventBody,
  type RecordedOutcome,
  type ResultBody,
  type ResultVersion,
  type Score,
  type StewardProposalBody,
  type SuspendBody,
  type VersionBody,
  type VoteBody,
} from './event';
import {
  type Bar,
  chosenWindow,
  DAY_MINUTES,
  DEFAULT_RULES,
  foundingRules,
  type ProposalClass,
  type Rules,
  targetClass,
} from './rules';
import {
  EMPTY_SEATS,
  isSeatNumber,
  mayProposeSteward,
  maySuspend,
  type ProposalTarget,
  reasonFits,
  type Seat,
  seatAt,
  seatsAfterPass,
  seatsAtTermEnds,
  stewardChangeOf,
  type Suspension,
  suspensionEnd,
  vacate,
} from './stewards';
import { type TallyDetail, tallyDetail, type TallyOutcome, type TallyVersion } from './tally';
import { codePointLength } from './text';

/** The longest Proposal title, in code points. */
export const TITLE_MAX = 120;
/** The longest justification, in code points. */
export const WHY_MAX = 2_000;
/** The longest ballot note, in code points. */
export const NOTE_MAX = 280;

/**
 * One record as the relay returned it: its seq, its receipt minute and the
 * signed record's bytes, `publicKey ‖ signature ‖ event bytes` (spec §3).
 */
export interface LogRecord {
  readonly seq: number;
  readonly received: number;
  readonly bytes: Uint8Array;
}

/**
 * A member: the name fixed at join, the involvement level they chose most
 * recently, and the seq of the event that admitted them.
 */
export interface Member {
  readonly author: string;
  readonly name: string;
  readonly level: Level;
  readonly seq: number;
}

/** A unit of the Document. Genesis Atom `i` has the id `${genesisId}.${i}`. */
export interface Atom {
  readonly id: string;
  readonly documentId: string;
  readonly text: string;
}

/** One wording on a Proposal's ballot. A Proposal's own text is its first version. */
export interface Version {
  readonly id: string;
  readonly author: string;
  readonly text: string;
}

/** A voter's latest valid ballot on one Proposal. */
export interface Ballot {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly voter: string;
  readonly scores: Readonly<Record<string, Score>>;
  readonly note: string | null;
  /** The ballot's salt (#111), or `""` for one cast before salts. */
  readonly salt: string;
}

/**
 * The `result` the fold accepted for a Proposal (#111): the first valid one
 * in relay order. Its `closedAt` is when the Proposal closed, its early
 * close's minute or its deadline, and `versions` holds each version's counts
 * in ballot order.
 */
export interface DecisionRecord {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly author: string;
  readonly closedAt: number;
  readonly versions: readonly ResultVersion[];
  readonly commit: string;
}

/**
 * A proposed change to one Atom, or to a steward seat, with its vote.
 *
 * `target` says which: an edit of `atom`, or a steward change (#102), whose
 * `atom` and `text` are `""` and whose one version, under its own id, has no
 * text. A recall's eligible set leaves out the steward it would remove.
 *
 * `class` is how hard the change is, set by `targetClass` from state when it
 * opened, never from the proposer's own fields. It picks the bar the versions
 * are tallied at, which `outcome` carries, and bounds `window`, the whole days
 * the vote runs: the proposer's choice, or the class default when they named
 * none (#106). `deadline` is the relay's receipt plus `window` × 1,440
 * minutes, fixed when it opens. `eligible` is who could vote when
 * it opened (ADR-0015): the members for whom `wouldVote` held then. A later
 * join or level change never changes it, nor the quorum and early close that
 * count it. `closedAt` is the receipt minute of the ballot that closed it
 * early, or null. `final` is true once it has closed, early or because relay
 * time reached `deadline`. `outcome` is the tally of the ballots so far, and
 * is settled only when `final`.
 *
 * `result` is the decision record the fold accepted, or null (#111).
 * `cleared` is true once this device has deleted the Proposal's ballots:
 * `ballots` is then empty, and its early close, counts and outcome come from
 * `result`. `mismatched` names, once each, the members whose results don't
 * match the ballots on this device.
 */
export interface Proposal {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly author: string;
  readonly atom: string;
  readonly target: ProposalTarget;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link: string | null;
  readonly class: ProposalClass;
  readonly window: number;
  readonly deadline: number;
  readonly eligible: readonly string[];
  readonly versions: readonly Version[];
  readonly ballots: readonly Ballot[];
  readonly closedAt: number | null;
  readonly final: boolean;
  readonly outcome: TallyOutcome;
  readonly result: DecisionRecord | null;
  readonly cleared: boolean;
  readonly mismatched: readonly string[];
}

/**
 * A record the fold left out: a repeat, bad bytes, or an event that broke a
 * rule. `id` is null when the record didn't verify, doesn't hold an event, or
 * names an author other than the key that signed it: such bytes have no
 * trustworthy event id.
 */
export interface IgnoredRecord {
  readonly seq: number;
  readonly id: string | null;
}

/**
 * A group as one device sees it after folding its log. `group` is the genesis
 * id, or null before one. `rules` are the founding rules its genesis set:
 * `DEFAULT_RULES` in every MVP group, and before any genesis. `members` are
 * the people in the group now. `former` are those who have left, in the order
 * they left, as they were when they did: their names still show on the
 * Proposals, versions and ballots they made before (#77). `at` is the relay
 * minute the state stands at: `relayNow`, or the latest record's receipt when
 * that's null. `stewards` holds both seats as of `at`, and `suspensions`
 * every suspension in relay order, running or ended (#102).
 */
export interface GroupState {
  readonly group: string | null;
  readonly rules: Rules;
  readonly name: string;
  readonly chat: string | null;
  readonly title: string;
  readonly members: readonly Member[];
  readonly former: readonly Member[];
  readonly atoms: readonly Atom[];
  readonly proposals: readonly Proposal[];
  readonly at: number;
  readonly stewards: readonly Seat[];
  readonly suspensions: readonly Suspension[];
  readonly ignored: readonly IgnoredRecord[];
}

/** Where an event sits in the relay's log. */
interface Receipt {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
}

/**
 * A cleared Proposal's record, read ahead (#111): its first `result` after it
 * in relay order, with that result's id and receipt.
 */
interface ReadAhead {
  readonly id: string;
  readonly received: number;
  readonly body: ResultBody;
}

/** A Proposal while the fold runs: its versions, ballots, early close and result still change. */
interface OpenProposal extends Omit<
  Proposal,
  'versions' | 'ballots' | 'closedAt' | 'final' | 'outcome' | 'result' | 'mismatched'
> {
  readonly versions: Version[];
  ballots: Ballot[];
  closedAt: number | null;
  result: DecisionRecord | null;
  readonly mismatched: string[];
  /** A cleared Proposal's record, read ahead and checked when it opened; null for any other. */
  readonly readAhead: ReadAhead | null;
}

/**
 * The state the fold builds up, one event at a time. `seated` holds the ids
 * of the closed steward Proposals whose outcome the seats already show.
 */
interface Draft {
  group: string | null;
  rules: Rules;
  name: string;
  chat: string | null;
  title: string;
  readonly members: Member[];
  readonly former: Member[];
  atoms: Atom[];
  readonly proposals: OpenProposal[];
  at: number;
  stewards: readonly Seat[];
  readonly suspensions: Suspension[];
  readonly seated: Set<string>;
  /** The Proposals whose ballots this device has cleared (#111). */
  readonly cleared: ReadonlySet<string>;
  /** Each cleared Proposal's first result after it in relay order, found before the fold starts. */
  readonly firstResults: ReadonlyMap<string, ReadAhead & { readonly event: GroupEvent }>;
  /** Cleared Proposals whose read-ahead result didn't hold up where it sits: read nothing ahead. */
  readonly distrusted: ReadonlySet<string>;
}

/** Founds the group, unless its rules differ from the defaults (rules.ts). */
function applyGenesis(draft: Draft, body: GenesisBody, author: string, at: Receipt): boolean {
  const rules = foundingRules(body.rules);
  if (rules === null) return false;
  draft.group = at.id;
  draft.rules = rules;
  draft.name = body.name;
  draft.chat = body.chat ?? null;
  draft.title = body.title;
  draft.members.push({ author, name: body.founder, level: FOUNDER_LEVEL, seq: at.seq });
  // The founder holds seat 1 with no term until the group elects someone (ADR-0049).
  draft.stewards = draft.stewards.map((s) => (s.seat === 1 ? { ...s, holder: author } : s));
  draft.atoms = body.atoms.map((text, i) => ({
    id: `${at.id}.${String(i)}`,
    documentId: at.id,
    text,
  }));
  return true;
}

/** True when `author` is in the group, or was until they left. */
function hasJoined(draft: Draft, author: string): boolean {
  return [...draft.members, ...draft.former].some((m) => m.author === author);
}

/**
 * A join names a level it knows, or none (a Collaborator), and comes from
 * someone not yet in. A key that has left never joins again: rejoining takes
 * a new membership, with its own key (ADR-0009).
 */
function applyJoin(draft: Draft, body: JoinBody, author: string, at: Receipt): boolean {
  const level = body.level ?? DEFAULT_JOIN_LEVEL;
  if (!isLevel(level) || hasJoined(draft, author)) return false;
  draft.members.push({ author, name: body.name, level, seq: at.seq });
  return true;
}

/**
 * A member moves to a level they don't hold yet, at once (ADR-0021: self-selected).
 * It never touches an open Proposal's eligible set. A steward who moves to a
 * level that doesn't vote gives up their seat (#102).
 */
function applyLevel(draft: Draft, body: LevelBody, author: string): boolean {
  const index = draft.members.findIndex((m) => m.author === author);
  const member = draft.members[index];
  const { level } = body;
  if (member === undefined || !isLevel(level) || member.level === level) return false;
  draft.members[index] = { ...member, level };
  if (!wouldVote(draft, author)) draft.stewards = vacate(draft.stewards, author);
  return true;
}

/**
 * A member leaves (ADR-0010: exit is always possible). They move from
 * `members` to `former`, so from here on `can()` refuses them everything and
 * the fold ignores their later events. A Proposal already open keeps them in
 * its eligible set (ADR-0015 §1), so its quorum and early close don't change,
 * the ballots they sent before still count, and their Proposals and versions
 * stay on the ballot. This is the one place a leave takes effect: a seat the
 * member holds empties here too (#102), and a suspension stays on record.
 */
function applyLeave(draft: Draft, author: string): boolean {
  const index = draft.members.findIndex((m) => m.author === author);
  const member = draft.members[index];
  if (member === undefined) return false;
  draft.members.splice(index, 1);
  draft.former.push(member);
  draft.stewards = vacate(draft.stewards, author);
  return true;
}

/**
 * True while a Proposal takes versions and ballots at relay minute `received`:
 * before its deadline, and before any early close. A cleared Proposal's early
 * close is its read-ahead result's (#111), so it closes at the start of that
 * minute.
 */
function isOpenAt(proposal: OpenProposal, received: number): boolean {
  if (received >= proposal.deadline) return false;
  if (proposal.cleared) return proposal.closedAt === null || received < proposal.closedAt;
  return proposal.closedAt === null;
}

/** The Proposal open on `atom` at relay minute `received`, if any. An Atom has at most one. */
function openOn(draft: Draft, atom: string, received: number): OpenProposal | undefined {
  return draft.proposals.find((p) => p.atom === atom && isOpenAt(p, received));
}

/** A title of 1–120 code points and a justification of at most 2,000, as every Proposal needs. */
function fieldsAreValid(body: ProposalEventBody): boolean {
  const titleLength = codePointLength(body.title);
  return titleLength >= 1 && titleLength <= TITLE_MAX && codePointLength(body.why) <= WHY_MAX;
}

function proposalIsValid(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  return (
    can(draft, author, 'propose') &&
    draft.atoms.some((a) => a.id === body.atom) &&
    optionFor(openOn(draft, body.atom, at.received)) === 'propose' &&
    fieldsAreValid(body)
  );
}

/** Who may vote on a Proposal that opens now (ADR-0015): everyone `wouldVote` lets in, but `left`. */
function eligibleNow(draft: Draft, left: string | null): string[] {
  return draft.members
    .filter((m) => m.author !== left && wouldVote(draft, m.author))
    .map((m) => m.author);
}

/** A Proposal's class and the whole days its vote runs, fixed when it opens. */
interface Term {
  readonly cls: ProposalClass;
  readonly window: number;
}

/**
 * What every Proposal opens with: its receipt, author, class, window and a
 * deadline `window` days after its receipt (#106), and no ballots yet.
 */
function opening(body: ProposalEventBody, author: string, at: Receipt, { cls, window }: Term) {
  return {
    ...at,
    author,
    title: body.title,
    why: body.why,
    link: body.link ?? null,
    class: cls,
    window,
    deadline: at.received + window * DAY_MINUTES,
    ballots: [],
    closedAt: null,
  };
}

/** Two outcomes are the same: the same kind, and on a pass the same version. */
function sameOutcome(tallied: TallyOutcome, recorded: RecordedOutcome): boolean {
  if (tallied.kind !== 'pass' || recorded.kind !== 'pass') return tallied.kind === recorded.kind;
  return tallied.version === recorded.version;
}

/** True when the outcome a result names is what its own counts give at `bar`. */
function outcomeFollows(body: ResultBody, bar: Bar): boolean {
  const { outcome } = tallyDetail({
    eligible: body.eligible,
    versions: body.versions.map((v) => ({ id: v.id, scores: scoresOf(v.counts) })),
    bar,
  });
  return sameOutcome(outcome, body.outcome);
}

/**
 * True when a result's counts could close a Proposal when it says: no version
 * scored by more than the eligible set, and, for an early close, every
 * version scored by all of it.
 */
function closeIsPossible(body: ResultBody, deadline: number): boolean {
  const early = body.closedAt < deadline;
  return body.versions.every((version) => {
    const scorers = version.counts.reduce((sum, n) => sum + n, 0);
    return early ? scorers === body.eligible : scorers <= body.eligible;
  });
}

/** What a Proposal opens with, to check a cleared one's read-ahead result against. */
interface Opened {
  readonly at: Receipt;
  readonly class: ProposalClass;
  readonly deadline: number;
  readonly eligible: readonly string[];
}

/**
 * True when a result read ahead can be a Proposal's record (#111): it arrived
 * in a later minute than its close, closes the Proposal between its receipt
 * and its deadline as its counts allow, counts the Proposal's eligible set
 * from version 1 on, and names the outcome its counts give at the
 * Proposal's bar.
 */
function recordFits(found: ReadAhead, opened: Opened, bar: Bar): boolean {
  const { body } = found;
  const { at, deadline } = opened;
  return (
    found.received > body.closedAt &&
    body.closedAt >= at.received &&
    body.closedAt <= deadline &&
    body.eligible === opened.eligible.length &&
    body.versions[0]?.id === at.id &&
    closeIsPossible(body, deadline) &&
    outcomeFollows(body, bar)
  );
}

/**
 * A cleared Proposal's record: its first result after it, when that result
 * is for this group and fits (`recordFits`). Null for any other Proposal.
 */
function readAheadFor(draft: Draft, opened: Opened): ReadAhead | null {
  const { id } = opened.at;
  if (!draft.cleared.has(id) || draft.distrusted.has(id)) return null;
  const found = draft.firstResults.get(id);
  if (found === undefined || found.event.group !== draft.group) return null;
  const fits = recordFits(found, opened, draft.rules.bars[opened.class]);
  return fits ? { id: found.id, received: found.received, body: found.body } : null;
}

/**
 * What #111 adds to a Proposal as it opens: whether its ballots are cleared,
 * its read-ahead record, and an early close the record gives.
 */
function clearing(draft: Draft, opened: Opened) {
  const readAhead = readAheadFor(draft, opened);
  const early = readAhead !== null && readAhead.body.closedAt < opened.deadline;
  return {
    cleared: draft.cleared.has(opened.at.id),
    readAhead,
    closedAt: early ? readAhead.body.closedAt : null,
    result: null,
    mismatched: [],
  };
}

/**
 * Opens an edit at its class's bar, for the window its proposer chose within
 * the class's bounds, or the class default (#106). A window outside those
 * bounds, or not a whole number, makes the fold ignore the Proposal.
 */
function applyEdit(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  if (!proposalIsValid(draft, body, author, at)) return false;
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  const opened = {
    ...opening(body, author, at, { cls, window }),
    eligible: eligibleNow(draft, null),
  };
  draft.proposals.push({
    ...opened,
    ...clearing(draft, { ...opened, at }),
    atom: body.atom,
    target: { kind: 'edit' },
    text: body.text,
    versions: [{ id: at.id, author, text: body.text }],
  });
  return true;
}

/**
 * Opens a steward election or recall (ADR-0049, #102), when its author may
 * propose and its target is valid now (stewards.ts). Its one version has no
 * text, and a recall's steward isn't in its eligible set, or their own 0
 * alone would block it in a group of 10 or fewer. It runs its class's default
 * window: a steward Proposal carries no `window` (#106).
 */
function applySteward(
  draft: Draft,
  body: StewardProposalBody,
  author: string,
  at: Receipt,
): boolean {
  const { seat, member } = body.target;
  if (!isSeatNumber(seat) || !fieldsAreValid(body)) return false;
  if (!mayProposeSteward(draft, author, body.target)) return false;
  const { holder } = seatAt(draft, seat);
  const cls = targetClass(draft, body);
  const opened = {
    ...opening(body, author, at, { cls, window: draft.rules.windows[cls].default }),
    eligible: eligibleNow(draft, member === null ? holder : null),
  };
  draft.proposals.push({
    ...opened,
    ...clearing(draft, { ...opened, at }),
    atom: '',
    target: { kind: 'steward', seat, member, holder },
    text: '',
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

function applyProposal(
  draft: Draft,
  body: ProposalEventBody,
  author: string,
  at: Receipt,
): boolean {
  return isStewardProposal(body)
    ? applySteward(draft, body, author, at)
    : applyEdit(draft, body, author, at);
}

/**
 * Suspends a member for the group's `suspensionDays` from the relay's receipt
 * (ADR-0016), when the author may suspend them now and the reason fits
 * (stewards.ts). Stewards can't lengthen one (ADR-0059): #115's open removal
 * vote is the only thing that will.
 */
function applySuspend(draft: Draft, body: SuspendBody, author: string, at: Receipt): boolean {
  const reason = body.reason ?? null;
  if (!maySuspend(draft, author, body.member) || !reasonFits(reason)) return false;
  const { id, seq, received } = at;
  const until = suspensionEnd(draft.rules, received);
  draft.suspensions.push({ id, seq, received, by: author, member: body.member, reason, until });
  return true;
}

/**
 * True when a cleared Proposal's record puts this version on its ballot: it
 * arrived in the minute of the early close, before the closing ballot (#111).
 */
function listedAtClose(proposal: OpenProposal, at: Receipt): boolean {
  return (
    proposal.readAhead !== null &&
    at.received === proposal.closedAt &&
    proposal.readAhead.body.versions.some((version) => version.id === at.id)
  );
}

/**
 * Adds a version to an open Proposal's ballot, in relay order, while it holds
 * fewer than three (ADR-0004, ADR-0047). The author must hold `propose`.
 */
function applyVersion(draft: Draft, body: VersionBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined) return false;
  if (!isOpenAt(proposal, at.received) && !listedAtClose(proposal, at)) return false;
  // A steward Proposal has no text, so it takes no versions (#102).
  if (proposal.target.kind !== 'edit') return false;
  if (!can(draft, author, 'propose') || optionFor(proposal) !== 'add-version') return false;
  proposal.versions.push({ id: at.id, author, text: body.text });
  return true;
}

/** At least one score, and every score names a version on the Proposal. */
function scoresAreKnown(proposal: OpenProposal, scores: VoteBody['scores']): boolean {
  const named = Object.keys(scores);
  return named.length > 0 && named.every((id) => proposal.versions.some((v) => v.id === id));
}

/** At most 280 code points, and not blank when any score is 0. */
function noteIsValid(body: VoteBody): boolean {
  const note = body.note ?? '';
  const needsReason = Object.values(body.scores).includes(0);
  return codePointLength(note) <= NOTE_MAX && (!needsReason || note.trim() !== '');
}

/** The ballot's rules: an eligible voter holding `vote`, known versions, a valid note, in time. */
function ballotIsValid(
  draft: Draft,
  proposal: OpenProposal,
  body: VoteBody,
  author: string,
  at: Receipt,
): boolean {
  return (
    proposal.eligible.includes(author) &&
    can(draft, author, 'vote') &&
    scoresAreKnown(proposal, body.scores) &&
    noteIsValid(body) &&
    isOpenAt(proposal, at.received)
  );
}

/** True when every eligible member's latest ballot scores every version. */
function everyoneHasScored(proposal: OpenProposal): boolean {
  return proposal.eligible.every((voter) => {
    const ballot = proposal.ballots.find((b) => b.voter === voter);
    return (
      ballot !== undefined && proposal.versions.every((v) => Object.hasOwn(ballot.scores, v.id))
    );
  });
}

/** A ballot counts toward an uncleared Proposal only: a cleared one's counts come from its result. */
function applyVote(draft: Draft, body: VoteBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || proposal.cleared) return false;
  if (!ballotIsValid(draft, proposal, body, author, at)) return false;
  const note = body.note ?? null;
  const ballot = { ...at, voter: author, scores: body.scores, note, salt: body.salt ?? '' };
  proposal.ballots = [...proposal.ballots.filter((b) => b.voter !== author), ballot];
  if (everyoneHasScored(proposal)) proposal.closedAt = at.received;
  return true;
}

/** True when two lists hold the same items in the same order. */
function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A result's versions as one flat list: each id, then its five counts. */
function lines(versions: readonly ResultVersion[]): (string | number)[] {
  return versions.flatMap((version) => [version.id, ...version.counts]);
}

/** True when a result lists the Proposal's versions, in ballot order. */
function listsVersions(proposal: OpenProposal, body: ResultBody): boolean {
  return sameList(
    body.versions.map((version) => version.id),
    proposal.versions.map((version) => version.id),
  );
}

/**
 * What a Proposal's own ballots give a result, apart from its outcome: the
 * close, the eligible count, each version's counts and the commitment. A
 * device posts this (with the outcome) and checks results against it.
 */
export function heldRecord(
  proposal: Pick<Proposal, 'id' | 'closedAt' | 'deadline' | 'eligible' | 'versions' | 'ballots'>,
): Omit<ResultBody, 'outcome'> {
  const ids = proposal.versions.map((version) => version.id);
  return {
    proposal: proposal.id,
    closedAt: closeTime(proposal),
    eligible: proposal.eligible.length,
    versions: ids.map((id) => ({ id, counts: scoreCounts(proposal.ballots, id) })),
    commit: ballotCommit(commitEntries(ids, proposal.ballots)),
  };
}

/** True when a result checks out against the ballots this device holds. */
function matchesBallots(draft: Draft, proposal: OpenProposal, body: ResultBody): boolean {
  const own = heldRecord(proposal);
  return (
    body.eligible === own.eligible &&
    listsVersions(proposal, body) &&
    body.closedAt === own.closedAt &&
    body.commit === own.commit &&
    sameList(lines(body.versions), lines(own.versions)) &&
    outcomeFollows(body, draft.rules.bars[proposal.class])
  );
}

/** Notes a member whose result doesn't match this device's ballots, once. */
function flag(proposal: OpenProposal, author: string): void {
  if (!proposal.mismatched.includes(author)) proposal.mismatched.push(author);
}

/**
 * Checks a result against the ballots this device holds (#111): it must
 * arrive after the Proposal's close, in a later minute, and match them. One
 * that doesn't is flagged; of those that do, the first counts.
 */
function heldResultCounts(
  proposal: OpenProposal,
  draft: Draft,
  author: string,
  at: Receipt,
  body: ResultBody,
): boolean {
  if (at.received <= closeTime(proposal)) return false;
  if (!matchesBallots(draft, proposal, body)) {
    flag(proposal, author);
    return false;
  }
  return proposal.result === null;
}

/**
 * Accepts the first valid `result` per Proposal, from a current member (#111).
 * A cleared Proposal takes only the result it read ahead, once that result
 * also lists its versions.
 */
function applyResult(draft: Draft, body: ResultBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || !can(draft, author, 'read')) return false;
  const counts = proposal.cleared
    ? proposal.readAhead?.id === at.id && listsVersions(proposal, body)
    : heldResultCounts(proposal, draft, author, at, body);
  if (!counts) return false;
  const { closedAt, versions, commit } = body;
  proposal.result = { ...at, author, closedAt, versions, commit };
  return true;
}

/** Genesis must carry `""` and come first; every other event must carry the genesis id. */
function inGroup(draft: Draft, event: GroupEvent): boolean {
  return event.type === 'genesis'
    ? draft.group === null && event.group === ''
    : event.group === draft.group;
}

/**
 * A version-1 event for this group, from someone who isn't suspended: the
 * fold ignores a suspended member's events until the suspension ends
 * (ADR-0016), except their `leave`, since exit is always possible (ADR-0010,
 * #77).
 */
function admits(draft: Draft, event: GroupEvent): boolean {
  const free = event.type === 'leave' || !isSuspended(draft, event.author);
  return event.v === EVENT_VERSION && inGroup(draft, event) && free;
}

/** The events about a Proposal: opening one, a version, a ballot, and its result. */
type ProposalEvent = Extract<
  GroupEvent,
  { readonly type: 'proposal' | 'version' | 'vote' | 'result' }
>;

/** Applies an event about a Proposal, or returns false to ignore it. */
function applyProposalEvent(draft: Draft, event: ProposalEvent, at: Receipt): boolean {
  switch (event.type) {
    case 'proposal':
      return applyProposal(draft, event.body, event.author, at);
    case 'version':
      return applyVersion(draft, event.body, event.author, at);
    case 'vote':
      return applyVote(draft, event.body, event.author, at);
    case 'result':
      return applyResult(draft, event.body, event.author, at);
  }
}

/** Applies one verified event to the draft, or returns false to ignore it. */
function applyEvent(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  if (!admits(draft, event)) return false;
  switch (event.type) {
    case 'genesis':
      return applyGenesis(draft, event.body, event.author, at);
    case 'join':
      return applyJoin(draft, event.body, event.author, at);
    case 'level':
      return applyLevel(draft, event.body, event.author);
    case 'leave':
      return applyLeave(draft, event.author);
    case 'suspend':
      return applySuspend(draft, event.body, event.author, at);
    default:
      return applyProposalEvent(draft, event, at);
  }
}

/** Every score the ballots gave version `id`, one per ballot that scored it. */
function scoresFor(ballots: readonly Ballot[], id: string): Score[] {
  return ballots.flatMap((b) =>
    Object.entries(b.scores)
      .filter(([version]) => version === id)
      .map(([, score]) => score),
  );
}

/**
 * What {@link proposalTally} reads of a Proposal: who could vote, its
 * versions, its ballots, its bar, and, once its ballots are cleared, its result.
 */
export type TalliedProposal = Pick<
  Proposal,
  'eligible' | 'versions' | 'ballots' | 'outcome' | 'cleared' | 'result'
>;

/**
 * Each version's scores: from the ballots, or, given `counts` (a cleared
 * Proposal's, #111), from each version's counts there.
 */
function versionScores(
  proposal: Pick<Proposal, 'versions' | 'ballots'>,
  counts: readonly ResultVersion[] | null,
): TallyVersion[] {
  return proposal.versions.map((v) => {
    if (counts === null) return { id: v.id, scores: scoresFor(proposal.ballots, v.id) };
    const line = counts.find((candidate) => candidate.id === v.id);
    return { id: v.id, scores: line === undefined ? [] : scoresOf(line.counts) };
  });
}

/** A Proposal's scores so far, tallied version by version at `bar`. */
function tallyAt(
  proposal: Pick<Proposal, 'eligible' | 'versions' | 'ballots'>,
  counts: readonly ResultVersion[] | null,
  bar: Bar,
): TallyDetail {
  const versions = versionScores(proposal, counts);
  return tallyDetail({ eligible: proposal.eligible.length, versions, bar });
}

/**
 * Tallies a folded Proposal's ballots so far, version by version (spec §5),
 * at the bar its outcome carries, which its class set: each version's
 * scorers, sum, zeros and quorum, its pass flags, the bar, and the outcome.
 * A cleared Proposal is tallied from its result's counts (#111), which give
 * the same numbers. The fold settles every outcome the same way, so the
 * consent meter and the result, which read this, can never disagree with
 * the fold.
 */
export function proposalTally(proposal: TalliedProposal): TallyDetail {
  const counts = proposal.cleared ? (proposal.result?.versions ?? []) : null;
  return tallyAt(proposal, counts, proposal.outcome.bar);
}

/**
 * Fixes a Proposal's finality and tallies it at its class's bar: from its
 * ballots, or from the record it read ahead once they're cleared (#111).
 */
function settle(proposal: OpenProposal, rules: Rules, relayNow: number | null): Proposal {
  const { readAhead, ...rest } = proposal;
  const final = rest.closedAt !== null || (relayNow !== null && relayNow >= rest.deadline);
  const counts = rest.cleared ? (readAhead?.body.versions ?? []) : null;
  const { outcome } = tallyAt(rest, counts, rules.bars[rest.class]);
  return { ...rest, final, outcome };
}

/** The `[atom, text]` an edit sets: its winning version's text once its pass is final, else none. */
function finalUpdate(proposal: Proposal): [string, string][] {
  if (proposal.target.kind !== 'edit') return [];
  if (!proposal.final || proposal.outcome.kind !== 'pass') return [];
  const winner = proposal.outcome.version;
  return proposal.versions.filter((v) => v.id === winner).map((v) => [proposal.atom, v.text]);
}

/** When a closed Proposal closed: early, or at its deadline, in relay minutes. */
export function closeTime(proposal: Pick<Proposal, 'closedAt' | 'deadline'>): number {
  return proposal.closedAt ?? proposal.deadline;
}

/**
 * Brings the steward seats up to `draft.at`: applies each steward Proposal
 * that has closed by then, once, in order of close time and then relay
 * order, and then lets seat 2 lapse at its term end in a group too small to
 * fill it (stewards.ts). Runs before each event, so every event finds the
 * seats as relay time has left them.
 */
function advanceSeats(draft: Draft): void {
  const closed = draft.proposals.filter(
    (p) => stewardChangeOf(p) !== null && !draft.seated.has(p.id) && !isOpenAt(p, draft.at),
  );
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  for (const proposal of closed.sort((a, b) => closeTime(a) - closeTime(b))) {
    draft.seated.add(proposal.id);
    const change = stewardChangeOf(proposal);
    const passed = settle(proposal, draft.rules, draft.at).outcome.kind === 'pass';
    if (change !== null && passed) {
      draft.stewards = seatsAfterPass(draft, change, closeTime(proposal));
    }
  }
  draft.stewards = seatsAtTermEnds(draft);
}

/** Applies final passes to the Atoms in order of close time, then the Proposals' relay order. */
function applyPasses(atoms: readonly Atom[], proposals: readonly Proposal[]): readonly Atom[] {
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  const byClose = [...proposals].sort((a, b) => closeTime(a) - closeTime(b));
  // A later entry for the same Atom replaces an earlier one, so the last pass to close wins.
  const texts = new Map(byClose.flatMap(finalUpdate));
  return atoms.map((atom) => {
    const text = texts.get(atom.id);
    return text === undefined ? atom : { ...atom, text };
  });
}

/** A record read once: its place in the relay's log, and its event, or null when it doesn't verify. */
interface Read {
  readonly seq: number;
  readonly received: number;
  readonly parsed: ParsedEvent | null;
}

/**
 * Each cleared Proposal's first `result` after its `proposal` in relay order,
 * with that result's receipt, which the fold reads ahead (#111).
 */
function firstResults(
  reads: readonly Read[],
  cleared: ReadonlySet<string>,
): Map<string, ReadAhead & { readonly event: GroupEvent }> {
  const opened = new Set<string>();
  const first = new Map<string, ReadAhead & { readonly event: GroupEvent }>();
  for (const { received, parsed } of reads) {
    if (parsed?.event.type === 'proposal' && cleared.has(parsed.id)) opened.add(parsed.id);
    if (parsed?.event.type !== 'result') continue;
    const { event, id } = parsed;
    const { body } = event;
    if (opened.has(body.proposal) && !first.has(body.proposal)) {
      first.set(body.proposal, { id, received, body, event });
    }
  }
  return first;
}

/** What one pass of the fold reads: the records, read once, and what #111 has cleared. */
interface Pass {
  readonly reads: readonly Read[];
  readonly relayNow: number | null;
  readonly cleared: ReadonlySet<string>;
  readonly firstResults: Draft['firstResults'];
  readonly distrusted: ReadonlySet<string>;
}

/**
 * One pass over the records. It also returns the cleared Proposals whose
 * read-ahead result didn't hold up where it sits in the log, such as one
 * from someone who wasn't a member then.
 */
function foldPass(pass: Pass): { state: GroupState; distrusted: string[] } {
  const draft: Draft = {
    group: null,
    rules: DEFAULT_RULES,
    name: '',
    chat: null,
    title: '',
    members: [],
    former: [],
    atoms: [],
    proposals: [],
    at: 0,
    stewards: EMPTY_SEATS,
    suspensions: [],
    seated: new Set(),
    cleared: pass.cleared,
    firstResults: pass.firstResults,
    distrusted: pass.distrusted,
  };
  const ignored: IgnoredRecord[] = [];
  const seen = new Set<string>();
  for (const { seq, received, parsed } of pass.reads) {
    // Relay time only moves on, whatever the record holds.
    draft.at = Math.max(draft.at, received);
    advanceSeats(draft);
    if (parsed === null) {
      ignored.push({ seq, id: null });
      continue;
    }
    const { event, id } = parsed;
    const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
    seen.add(id);
    if (!applied) ignored.push({ seq, id });
  }
  const { relayNow } = pass;
  draft.at = relayNow ?? draft.at;
  advanceSeats(draft);
  const distrusted = draft.proposals
    .filter((p) => p.readAhead !== null && p.result === null)
    .map((p) => p.id);
  const proposals = draft.proposals.map((p) => settle(p, draft.rules, relayNow));
  const atoms = applyPasses(draft.atoms, proposals);
  const { group, rules, name, chat, title, members, former, at, stewards, suspensions } = draft;
  const state = {
    group,
    rules,
    name,
    chat,
    title,
    members,
    former,
    atoms,
    proposals,
    at,
    stewards,
    suspensions,
    ignored,
  };
  return { state, distrusted };
}

/**
 * Folds a group's records, in relay order, into its state.
 *
 * `relayNow` is the relay's latest `now`, in minutes, or null before the first
 * sync; it decides only which Proposals have reached their deadline. A record
 * that doesn't verify, or whose event's `author` isn't the key that signed it,
 * is ignored before it is parsed or claims an event id, so a forged copy of a
 * real event can never shadow it. A repeated event id is ignored (the first
 * copy keeps its seq and receipt time), as is any event whose `v` isn't 1 or
 * whose `group` isn't the genesis id. Only members act, except on their own
 * join: `can()` is false for anyone else, including someone who has left.
 *
 * `cleared` lists the Proposals whose ballots this device has deleted (#111).
 * Each closes, counts and decides by its first result after it, read ahead,
 * so its early close falls where its ballots put it; a ballot still in the
 * log for one is ignored. When a read-ahead result turns out not to hold up
 * where it sits, the fold runs once more without reading it ahead.
 */
export function fold(
  records: readonly LogRecord[],
  relayNow: number | null,
  cleared: readonly string[] = [],
): GroupState {
  const reads = records.map(({ seq, received, bytes }) => ({
    seq,
    received,
    parsed: parseRecord(bytes),
  }));
  const clearedSet = new Set(cleared);
  const pass = {
    reads,
    relayNow,
    cleared: clearedSet,
    firstResults: firstResults(reads, clearedSet),
    distrusted: new Set<string>(),
  };
  const first = foldPass(pass);
  if (first.distrusted.length === 0) return first.state;
  return foldPass({ ...pass, distrusted: new Set(first.distrusted) }).state;
}
