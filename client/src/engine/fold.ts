/**
 * The group fold (docs/spec/phase-1-spec.md §4): a mailbox's records, in relay
 * order, become one `GroupState`.
 *
 * Every rule is checked against the state before the event. An event that
 * breaks one lands in `ignored` and changes nothing. Votes run on relay time
 * (`received`, in whole minutes); the author's `ts` plays no part. Genesis
 * founds the group with its rules, and each Proposal's class, set when it
 * opens, picks its window and its bar. A Document's text changes only when a
 * Proposal's pass is final. A `result` records a decided Proposal's counts
 * and a commitment to its ballots (#111): with the ballots held, the fold
 * checks it against them, and once a device has cleared them, it takes the
 * outcome and the close from it instead. The fold is pure: no I/O, no clock,
 * no randomness, so every device that folds the same records builds the same
 * state.
 */
import {
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  type Level,
  wouldVote,
} from './capabilities';
import { ballotCommit, commitEntries, scoreCounts, scoresOf } from './commit';
import { optionFor } from './composeOption';
import {
  EVENT_VERSION,
  type GenesisBody,
  type GroupEvent,
  type JoinBody,
  type LevelBody,
  type ParsedEvent,
  parseRecord,
  type ProposalBody,
  type RecordedOutcome,
  type ResultBody,
  type ResultVersion,
  type Score,
  type VersionBody,
  type VoteBody,
} from './event';
import {
  type Bar,
  DEFAULT_RULES,
  defaultWindowMinutes,
  foundingRules,
  type ProposalClass,
  type Rules,
  targetClass,
} from './rules';
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
 * A proposed change to one Atom, with its vote.
 *
 * `class` is how hard the change is, set by `targetClass` from state when it
 * opened, never from the proposer's own fields. It fixes `deadline`, the
 * relay's receipt plus the class's default window, and the bar the versions
 * are tallied at, which `outcome` carries. `eligible` is who could vote when
 * it opened (ADR-0015): the members for whom `wouldVote` held then. A later
 * join or level change never changes it, nor the quorum and early close that
 * count it. `closedAt` is the receipt minute of the ballot that closed it
 * early, or null. `final` is true once it has closed, early or because relay
 * time reached `deadline`. `outcome` is the tally of the ballots so far, and
 * is settled only when `final`.
 *
 * `result` is the decision record the fold accepted, or null (#111).
 * `cleared` is true once this device has deleted the Proposal's ballots:
 * `ballots` is then empty, and the counts, the outcome and an early close come
 * from `result`. `mismatched` names, once each, the members whose results
 * don't match the ballots on this device.
 */
export interface Proposal {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly author: string;
  readonly atom: string;
  readonly title: string;
  readonly why: string;
  readonly text: string;
  readonly link: string | null;
  readonly class: ProposalClass;
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
 * `DEFAULT_RULES` in every MVP group, and before any genesis.
 */
export interface GroupState {
  readonly group: string | null;
  readonly rules: Rules;
  readonly name: string;
  readonly chat: string | null;
  readonly title: string;
  readonly members: readonly Member[];
  readonly atoms: readonly Atom[];
  readonly proposals: readonly Proposal[];
  readonly ignored: readonly IgnoredRecord[];
}

/** Where an event sits in the relay's log. */
interface Receipt {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
}

/**
 * What a cleared Proposal's first result says of its close, read before the
 * fold reaches it: the result's id, the minute it closed, and the versions on
 * its ballot then. Events received before that minute find the Proposal
 * open and those after find it closed, as they did when the ballots were
 * held; in that minute itself, a version is on the ballot only if the result
 * lists it.
 */
interface Lookahead {
  readonly id: string;
  readonly closedAt: number;
  readonly versions: readonly string[];
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
  readonly lookahead: Lookahead | null;
}

/** The state the fold builds up, one event at a time. */
interface Draft {
  group: string | null;
  rules: Rules;
  name: string;
  chat: string | null;
  title: string;
  readonly members: Member[];
  atoms: Atom[];
  readonly proposals: OpenProposal[];
  /** The Proposals whose ballots this device has cleared (#111). */
  readonly cleared: ReadonlySet<string>;
  /** Each cleared Proposal's first result after it in relay order, found before the fold starts. */
  readonly firstResults: ReadonlyMap<string, ParsedEvent>;
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
  draft.atoms = body.atoms.map((text, i) => ({
    id: `${at.id}.${String(i)}`,
    documentId: at.id,
    text,
  }));
  return true;
}

/** A join names a level it knows, or none (a Collaborator), and comes from someone not yet in. */
function applyJoin(draft: Draft, body: JoinBody, author: string, at: Receipt): boolean {
  const level = body.level ?? DEFAULT_JOIN_LEVEL;
  if (!isLevel(level) || draft.members.some((m) => m.author === author)) return false;
  draft.members.push({ author, name: body.name, level, seq: at.seq });
  return true;
}

/**
 * A member moves to a level they don't hold yet, at once (ADR-0021: self-selected).
 * It never touches an open Proposal's eligible set.
 */
function applyLevel(draft: Draft, body: LevelBody, author: string): boolean {
  const index = draft.members.findIndex((m) => m.author === author);
  const member = draft.members[index];
  const { level } = body;
  if (member === undefined || !isLevel(level) || member.level === level) return false;
  draft.members[index] = { ...member, level };
  return true;
}

/**
 * True while a Proposal takes versions and ballots at relay minute `received`:
 * before its deadline, and before any early close, which a cleared Proposal's
 * result gives (#111).
 */
function isOpenAt(proposal: OpenProposal, received: number): boolean {
  const closes = proposal.lookahead?.closedAt ?? proposal.deadline;
  return proposal.closedAt === null && received < proposal.deadline && received < closes;
}

/** The Proposal open on `atom` at relay minute `received`, if any. An Atom has at most one. */
function openOn(draft: Draft, atom: string, received: number): OpenProposal | undefined {
  return draft.proposals.find((p) => p.atom === atom && isOpenAt(p, received));
}

function proposalIsValid(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  const titleLength = codePointLength(body.title);
  return (
    can(draft, author, 'propose') &&
    draft.atoms.some((a) => a.id === body.atom) &&
    optionFor(openOn(draft, body.atom, at.received)) === 'propose' &&
    titleLength >= 1 &&
    titleLength <= TITLE_MAX &&
    codePointLength(body.why) <= WHY_MAX
  );
}

/**
 * A cleared Proposal's lookahead: its first result's close, when that result
 * is in this group and closes it between its receipt and its deadline.
 */
function lookaheadFor(draft: Draft, at: Receipt, deadline: number): Lookahead | null {
  const found = draft.firstResults.get(at.id);
  if (found?.event.type !== 'result' || found.event.group !== draft.group) return null;
  const { closedAt, versions } = found.event.body;
  if (closedAt < at.received || closedAt > deadline) return null;
  return { id: found.id, closedAt, versions: versions.map((version) => version.id) };
}

function applyProposal(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  if (!proposalIsValid(draft, body, author, at)) return false;
  const cls = targetClass(draft, body);
  const deadline = at.received + defaultWindowMinutes(draft.rules, cls);
  const cleared = draft.cleared.has(at.id);
  draft.proposals.push({
    ...at,
    author,
    atom: body.atom,
    title: body.title,
    why: body.why,
    text: body.text,
    link: body.link ?? null,
    class: cls,
    deadline,
    eligible: draft.members.filter((m) => wouldVote(draft, m.author)).map((m) => m.author),
    versions: [{ id: at.id, author, text: body.text }],
    ballots: [],
    closedAt: null,
    result: null,
    cleared,
    mismatched: [],
    lookahead: cleared ? lookaheadFor(draft, at, deadline) : null,
  });
  return true;
}

/**
 * True when a cleared Proposal's result puts this version on its ballot: it
 * arrived in the minute of the early close, before the closing ballot (#111).
 */
function listedAtClose(proposal: OpenProposal, at: Receipt): boolean {
  const { lookahead } = proposal;
  return (
    lookahead !== null &&
    at.received === lookahead.closedAt &&
    at.received < proposal.deadline &&
    lookahead.versions.includes(at.id)
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

/** When a closed Proposal closed, in relay minutes: early, or at its deadline. */
export function closeMinute(proposal: Pick<Proposal, 'closedAt' | 'deadline'>): number {
  return proposal.closedAt ?? proposal.deadline;
}

/** Two results' outcomes are the same: the same kind, and on a pass the same version. */
function sameOutcome(tallied: TallyOutcome, recorded: RecordedOutcome): boolean {
  if (tallied.kind !== 'pass' || recorded.kind !== 'pass') return tallied.kind === recorded.kind;
  return tallied.version === recorded.version;
}

/** True when the outcome a result names is what its own counts give at the Proposal's bar. */
function outcomeFollows(draft: Draft, proposal: OpenProposal, body: ResultBody): boolean {
  const { outcome } = tallyDetail({
    eligible: body.eligible,
    versions: body.versions.map((v) => ({ id: v.id, scores: scoresOf(v.counts) })),
    bar: draft.rules.bars[proposal.class],
  });
  return sameOutcome(outcome, body.outcome);
}

/** True when two lists hold the same items in the same order. */
function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A result's versions as one flat list: each id, then its five counts. */
function lines(versions: readonly ResultVersion[]): (string | number)[] {
  return versions.flatMap((version) => [version.id, ...version.counts]);
}

/** True when a result names the Proposal's eligible count and its versions, in ballot order. */
function fitsProposal(proposal: OpenProposal, body: ResultBody): boolean {
  return (
    body.eligible === proposal.eligible.length &&
    sameList(
      body.versions.map((version) => version.id),
      proposal.versions.map((version) => version.id),
    )
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
    closedAt: closeMinute(proposal),
    eligible: proposal.eligible.length,
    versions: ids.map((id) => ({ id, counts: scoreCounts(proposal.ballots, id) })),
    commit: ballotCommit(commitEntries(ids, proposal.ballots)),
  };
}

/** True when a result's close, counts and commitment are exactly what this device's ballots give. */
function matchesBallots(proposal: OpenProposal, body: ResultBody): boolean {
  const own = heldRecord(proposal);
  return (
    body.closedAt === own.closedAt &&
    body.commit === own.commit &&
    sameList(lines(body.versions), lines(own.versions))
  );
}

/**
 * True when a cleared Proposal's counts could close it when the result says:
 * no version scored by more than the eligible set, and, for an early close,
 * every version scored by all of it.
 */
function closeIsPossible(proposal: OpenProposal, body: ResultBody): boolean {
  const early = body.closedAt < proposal.deadline;
  return body.versions.every((version) => {
    const scorers = version.counts.reduce((sum, n) => sum + n, 0);
    return early ? scorers === body.eligible : scorers <= body.eligible;
  });
}

/** A cleared Proposal takes only the result its lookahead read, and only if that result holds up. */
function clearedResultIsValid(
  draft: Draft,
  proposal: OpenProposal,
  body: ResultBody,
  at: Receipt,
): boolean {
  return (
    proposal.lookahead?.id === at.id &&
    at.received > body.closedAt &&
    fitsProposal(proposal, body) &&
    closeIsPossible(proposal, body) &&
    outcomeFollows(draft, proposal, body)
  );
}

/** True when a result checks out against the ballots this device holds. */
function heldResultIsValid(draft: Draft, proposal: OpenProposal, body: ResultBody): boolean {
  return (
    fitsProposal(proposal, body) &&
    matchesBallots(proposal, body) &&
    outcomeFollows(draft, proposal, body)
  );
}

/** Notes a member whose result doesn't match this device's ballots, once. */
function flag(proposal: OpenProposal, author: string): void {
  if (!proposal.mismatched.includes(author)) proposal.mismatched.push(author);
}

/**
 * Accepts the first valid `result` per Proposal, from a current member (#111).
 * With the ballots held, it must arrive after the Proposal's close, in a
 * later minute, and match them: one that doesn't is flagged. For a cleared
 * Proposal, only the result its lookahead read counts, checked on its own.
 */
function applyResult(draft: Draft, body: ResultBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || !can(draft, author, 'read')) return false;
  if (proposal.cleared) {
    if (proposal.result !== null || !clearedResultIsValid(draft, proposal, body, at)) return false;
  } else {
    if (at.received <= closeMinute(proposal)) return false;
    if (!heldResultIsValid(draft, proposal, body)) {
      flag(proposal, author);
      return false;
    }
    if (proposal.result !== null) return false;
  }
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

/** Applies one verified event to the draft, or returns false to ignore it. */
function applyEvent(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  if (event.v !== EVENT_VERSION || !inGroup(draft, event)) return false;
  switch (event.type) {
    case 'genesis':
      return applyGenesis(draft, event.body, event.author, at);
    case 'join':
      return applyJoin(draft, event.body, event.author, at);
    case 'proposal':
      return applyProposal(draft, event.body, event.author, at);
    case 'version':
      return applyVersion(draft, event.body, event.author, at);
    case 'vote':
      return applyVote(draft, event.body, event.author, at);
    case 'level':
      return applyLevel(draft, event.body, event.author);
    case 'result':
      return applyResult(draft, event.body, event.author, at);
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

/** Each version's scores: from the ballots, or from the result's counts once they're cleared. */
function versionScores(proposal: Omit<TalliedProposal, 'outcome'>): TallyVersion[] {
  return proposal.versions.map((v) => {
    if (!proposal.cleared) return { id: v.id, scores: scoresFor(proposal.ballots, v.id) };
    const counts = proposal.result?.versions.find((line) => line.id === v.id)?.counts;
    return { id: v.id, scores: counts === undefined ? [] : scoresOf(counts) };
  });
}

/** A Proposal's ballots so far, tallied version by version at `bar`. */
function tallyAt(proposal: Omit<TalliedProposal, 'outcome'>, bar: Bar): TallyDetail {
  return tallyDetail({
    eligible: proposal.eligible.length,
    versions: versionScores(proposal),
    bar,
  });
}

/**
 * Tallies a folded Proposal's ballots so far, version by version (spec §5),
 * at the bar its outcome carries, which its class set: each version's
 * scorers, sum, zeros and quorum, its pass flags, the bar, and the outcome.
 * A cleared Proposal is tallied from its result's counts (#111), which give
 * the same numbers. The fold settles every outcome the same way, so the
 * consent meter and the result, which read this, can never disagree with the
 * fold.
 */
export function proposalTally(proposal: TalliedProposal): TallyDetail {
  return tallyAt(proposal, proposal.outcome.bar);
}

/**
 * Fixes a Proposal's finality and tallies it at its class's bar. A cleared
 * Proposal's early close is its result's, read ahead (#111).
 */
function settle(proposal: OpenProposal, rules: Rules, relayNow: number | null): Proposal {
  const { lookahead, ...rest } = proposal;
  const early = lookahead !== null && lookahead.closedAt < rest.deadline;
  const closedAt = rest.closedAt ?? (early ? lookahead.closedAt : null);
  const final = closedAt !== null || (relayNow !== null && relayNow >= rest.deadline);
  const { outcome } = tallyAt(rest, rules.bars[rest.class]);
  return { ...rest, closedAt, final, outcome };
}

/** The `[atom, text]` a Proposal sets: its winning version's text once its pass is final, else none. */
function finalUpdate(proposal: Proposal): [string, string][] {
  if (!proposal.final || proposal.outcome.kind !== 'pass') return [];
  const winner = proposal.outcome.version;
  return proposal.versions.filter((v) => v.id === winner).map((v) => [proposal.atom, v.text]);
}

/** Applies final passes to the Atoms in order of close time, then the Proposals' relay order. */
function applyPasses(atoms: readonly Atom[], proposals: readonly Proposal[]): readonly Atom[] {
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  const byClose = [...proposals].sort((a, b) => closeMinute(a) - closeMinute(b));
  // A later entry for the same Atom replaces an earlier one, so the last pass to close wins.
  const texts = new Map(byClose.flatMap(finalUpdate));
  return atoms.map((atom) => {
    const text = texts.get(atom.id);
    return text === undefined ? atom : { ...atom, text };
  });
}

/**
 * Each cleared Proposal's first `result` after its `proposal` in relay order,
 * which the fold reads ahead so the Proposal closes where its ballots closed it.
 */
function firstResults(
  parsed: readonly (ParsedEvent | null)[],
  cleared: ReadonlySet<string>,
): Map<string, ParsedEvent> {
  const opened = new Set<string>();
  const first = new Map<string, ParsedEvent>();
  if (cleared.size === 0) return first;
  for (const entry of parsed) {
    if (entry?.event.type === 'proposal' && cleared.has(entry.id)) opened.add(entry.id);
    if (entry?.event.type !== 'result') continue;
    const { proposal } = entry.event.body;
    if (opened.has(proposal) && !first.has(proposal)) first.set(proposal, entry);
  }
  return first;
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
 * join: `can()` is false for anyone else.
 *
 * `cleared` lists the Proposals whose ballots this device has deleted (#111).
 * Each takes its counts, outcome and early close from its first result, and
 * a ballot still in the log for one is ignored.
 */
export function fold(
  records: readonly LogRecord[],
  relayNow: number | null,
  cleared: readonly string[] = [],
): GroupState {
  const parsed = records.map((record) => parseRecord(record.bytes));
  const clearedSet = new Set(cleared);
  const draft: Draft = {
    group: null,
    rules: DEFAULT_RULES,
    name: '',
    chat: null,
    title: '',
    members: [],
    atoms: [],
    proposals: [],
    cleared: clearedSet,
    firstResults: firstResults(parsed, clearedSet),
  };
  const ignored: IgnoredRecord[] = [];
  const seen = new Set<string>();
  records.forEach(({ seq, received }, index) => {
    const entry = parsed[index] ?? null;
    if (entry === null) {
      ignored.push({ seq, id: null });
      return;
    }
    const { event, id } = entry;
    const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
    seen.add(id);
    if (!applied) ignored.push({ seq, id });
  });
  const proposals = draft.proposals.map((p) => settle(p, draft.rules, relayNow));
  const atoms = applyPasses(draft.atoms, proposals);
  const { group, rules, name, chat, title, members } = draft;
  return { group, rules, name, chat, title, members, atoms, proposals, ignored };
}
