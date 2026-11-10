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
 * reached, and brings the seats up to it before each event. An opt-in's
 * standing value changes the same way, when a rules Proposal's pass is final,
 * and a steward's narrowing turns it off until its off-Proposal closes
 * (#117). The fold is pure: no I/O, no clock, no randomness, so every device
 * that folds the same records builds the same state.
 */
import { verifyInviteToken } from '../crypto/invite';
import {
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  isSuspended,
  type Level,
  wouldVote,
} from './capabilities';
import { optionFor } from './composeOption';
import {
  EVENT_VERSION,
  fromBase64url,
  type GenesisBody,
  type GroupEvent,
  type InviteToken,
  isRulesProposal,
  isStewardProposal,
  type LevelBody,
  type NarrowBody,
  parseRecord,
  type ProposalBody,
  type ProposalEventBody,
  type RulesProposalBody,
  type Score,
  type StewardProposalBody,
  type SuspendBody,
  type VersionBody,
  type VoteBody,
} from './event';
import {
  effectiveOptIns,
  isOptIn,
  mayProposeRules,
  type Narrowing,
  type OptIns,
  rulesChange,
  rulesChangeOf,
  withChange,
} from './optIns';
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
  mayNarrow,
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
import { type TallyDetail, tallyDetail, type TallyOutcome } from './tally';
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
 * recently, the seq of the event that admitted them, and who invited them:
 * the author of a verified invite token (#73), or null.
 */
export interface Member {
  readonly author: string;
  readonly name: string;
  readonly level: Level;
  readonly seq: number;
  readonly invitedBy: string | null;
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
}

/**
 * A proposed change to one Atom, a steward seat or an opt-in, with its vote.
 *
 * `target` says which: an edit of `atom`, a steward change (#102), or a rules
 * change to an opt-in (#117). A steward or rules Proposal's `atom` and `text`
 * are `""`, and its one version, under its own id, has no text. A recall's
 * eligible set leaves out the steward it would remove.
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
 * every suspension in relay order, running or ended (#102). `rules.optIns`
 * holds each opt-in's standing value as of `at`: off at founding, then what
 * the last passed rules Proposal set. `optIns` is what is in effect at `at`:
 * off while a steward's narrowing is in force, else the standing value
 * (`effectiveOptIn`). `narrowings` keeps every steward narrowing in relay
 * order, in force or ended (#117).
 */
export interface GroupState {
  readonly group: string | null;
  readonly rules: Rules;
  readonly optIns: OptIns;
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
  readonly narrowings: readonly Narrowing[];
  readonly ignored: readonly IgnoredRecord[];
}

/** A `join`, as the fold reads it: the envelope's `group` and `author` with its body. */
type JoinEvent = Extract<GroupEvent, { readonly type: 'join' }>;

/** Where an event sits in the relay's log. */
interface Receipt {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
}

/** A Proposal while the fold runs: its versions, ballots and early close still change. */
interface OpenProposal extends Omit<
  Proposal,
  'versions' | 'ballots' | 'closedAt' | 'final' | 'outcome'
> {
  readonly versions: Version[];
  ballots: Ballot[];
  closedAt: number | null;
}

/**
 * The state the fold builds up, one event at a time. `seated` holds the ids
 * of the closed steward Proposals whose outcome the seats already show, and
 * `ruled` those of the closed rules Proposals the opt-ins already show.
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
  readonly narrowings: Narrowing[];
  readonly seated: Set<string>;
  readonly ruled: Set<string>;
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
  draft.members.push({
    author,
    name: body.founder,
    level: FOUNDER_LEVEL,
    seq: at.seq,
    invitedBy: null,
  });
  // The founder holds seat 1 with no term until the group elects someone (ADR-0049).
  draft.stewards = draft.stewards.map((s) => (s.seat === 1 ? { ...s, holder: author } : s));
  draft.atoms = body.atoms.map((text, i) => ({
    id: `${at.id}.${String(i)}`,
    documentId: at.id,
    text,
  }));
  return true;
}

/**
 * Who a join's token names: its `by`, when that key is already a member and
 * signed the group id under the invite-token tag. Anything else names no one,
 * and never changes whether the join counts.
 */
function inviterOf(draft: Draft, token: InviteToken | undefined, group: string): string | null {
  if (token === undefined) return null;
  const { by, sig } = token;
  if (!draft.members.some((m) => m.author === by)) return null;
  return verifyInviteToken(fromBase64url(by), fromBase64url(sig), group) ? by : null;
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
function applyJoin(draft: Draft, event: JoinEvent, at: Receipt): boolean {
  const { author, body } = event;
  const level = body.level ?? DEFAULT_JOIN_LEVEL;
  if (!isLevel(level) || hasJoined(draft, author)) return false;
  const invitedBy = inviterOf(draft, body.token, event.group);
  draft.members.push({ author, name: body.name, level, seq: at.seq, invitedBy });
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
 * before its deadline, and before any early close.
 */
function isOpenAt(proposal: OpenProposal, received: number): boolean {
  return proposal.closedAt === null && received < proposal.deadline;
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
  draft.proposals.push({
    ...opening(body, author, at, { cls, window }),
    atom: body.atom,
    target: { kind: 'edit' },
    text: body.text,
    eligible: eligibleNow(draft, null),
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
  draft.proposals.push({
    ...opening(body, author, at, { cls, window: draft.rules.windows[cls].default }),
    atom: '',
    target: { kind: 'steward', seat, member, holder },
    text: '',
    eligible: eligibleNow(draft, member === null ? holder : null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/**
 * Opens a rules Proposal on an opt-in (ADR-0040, #117), when its author may
 * propose and its target is valid now (optIns.ts). Its class comes from the
 * standing value it would replace, which the fold records as `from`, and it
 * runs the window its proposer chose within that class's bounds, or the
 * class default (#106): 14 to 28 days to turn one on. Like a steward
 * Proposal, its one version has no text.
 */
function applyRules(draft: Draft, body: RulesProposalBody, author: string, at: Receipt): boolean {
  if (!fieldsAreValid(body) || !mayProposeRules(draft, author, body.target)) return false;
  const target = rulesChange(draft.rules.optIns, body.target.optIn, body.target.value);
  if (target === null) return false;
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  draft.proposals.push({
    ...opening(body, author, at, { cls, window }),
    atom: '',
    target,
    text: '',
    eligible: eligibleNow(draft, null),
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
  if (isStewardProposal(body)) return applySteward(draft, body, author, at);
  if (isRulesProposal(body)) return applyRules(draft, body, author, at);
  return applyEdit(draft, body, author, at);
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
 * Narrows an opt-in at once (ADR-0040, ADR-0075 §3, #117), when its author is
 * a steward who may narrow it beside their own open off-Proposal (stewards.ts,
 * which reads each closed Proposal's outcome at `at`). It's off until that
 * Proposal closes.
 */
function applyNarrow(draft: Draft, body: NarrowBody, author: string, at: Receipt): boolean {
  const settled = draft.proposals.map((p) => settle(p, draft.rules, draft.at));
  const { optIn, proposal } = body;
  if (!isOptIn(optIn) || !mayNarrow({ ...draft, proposals: settled }, author, body)) return false;
  const { id, seq, received } = at;
  draft.narrowings.push({ id, seq, received, by: author, optIn, proposal });
  return true;
}

/**
 * Adds a version to an open Proposal's ballot, in relay order, while it holds
 * fewer than three (ADR-0004, ADR-0047). The author must hold `propose`.
 */
function applyVersion(draft: Draft, body: VersionBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || !isOpenAt(proposal, at.received)) return false;
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

function applyVote(draft: Draft, body: VoteBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || !ballotIsValid(draft, proposal, body, author, at)) return false;
  const ballot = { ...at, voter: author, scores: body.scores, note: body.note ?? null };
  proposal.ballots = [...proposal.ballots.filter((b) => b.voter !== author), ballot];
  if (everyoneHasScored(proposal)) proposal.closedAt = at.received;
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

/** Applies one verified event to the draft, or returns false to ignore it. */
function applyEvent(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  return admits(draft, event) && applyAdmitted(draft, event, at);
}

/** Applies one event {@link admits} let through, or returns false to ignore it. */
function applyAdmitted(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  switch (event.type) {
    case 'genesis':
      return applyGenesis(draft, event.body, event.author, at);
    case 'join':
      return applyJoin(draft, event, at);
    case 'proposal':
      return applyProposal(draft, event.body, event.author, at);
    case 'version':
      return applyVersion(draft, event.body, event.author, at);
    case 'vote':
      return applyVote(draft, event.body, event.author, at);
    case 'level':
      return applyLevel(draft, event.body, event.author);
    case 'leave':
      return applyLeave(draft, event.author);
    case 'suspend':
      return applySuspend(draft, event.body, event.author, at);
    case 'narrow':
      return applyNarrow(draft, event.body, event.author, at);
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

/** What {@link proposalTally} reads of a Proposal: who could vote, its versions, its ballots and its bar. */
export type TalliedProposal = Pick<Proposal, 'eligible' | 'versions' | 'ballots' | 'outcome'>;

/** A Proposal's ballots so far, tallied version by version at `bar`. */
function tallyAt(proposal: Omit<TalliedProposal, 'outcome'>, bar: Bar): TallyDetail {
  return tallyDetail({
    eligible: proposal.eligible.length,
    versions: proposal.versions.map((v) => ({
      id: v.id,
      scores: scoresFor(proposal.ballots, v.id),
    })),
    bar,
  });
}

/**
 * Tallies a folded Proposal's ballots so far, version by version (spec §5),
 * at the bar its outcome carries, which its class set: each version's
 * scorers, sum, zeros and quorum, its pass flags, the bar, and the outcome.
 * The fold settles every outcome the same way, so the consent meter and the
 * result, which read this, can never disagree with the fold.
 */
export function proposalTally(proposal: TalliedProposal): TallyDetail {
  return tallyAt(proposal, proposal.outcome.bar);
}

/** Fixes a Proposal's finality and tallies its ballots at its class's bar. */
function settle(proposal: OpenProposal, rules: Rules, relayNow: number | null): Proposal {
  const final = proposal.closedAt !== null || (relayNow !== null && relayNow >= proposal.deadline);
  const { outcome } = tallyAt(proposal, rules.bars[proposal.class]);
  return { ...proposal, final, outcome };
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
 * The Proposals of one kind that have closed by `draft.at` and that `applied`
 * doesn't hold yet, each marked applied, in order of close time and then
 * relay order, with whether each passed.
 */
function newlyClosed(
  draft: Draft,
  applied: Set<string>,
  kind: 'steward' | 'rules',
): { proposal: OpenProposal; passed: boolean }[] {
  const closed = draft.proposals.filter(
    (p) => p.target.kind === kind && !applied.has(p.id) && !isOpenAt(p, draft.at),
  );
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  return closed
    .sort((a, b) => closeTime(a) - closeTime(b))
    .map((proposal) => {
      applied.add(proposal.id);
      const passed = settle(proposal, draft.rules, draft.at).outcome.kind === 'pass';
      return { proposal, passed };
    });
}

/**
 * Brings the steward seats up to `draft.at`: applies each steward Proposal
 * that has closed by then, once, in order of close time and then relay
 * order, and then lets seat 2 lapse at its term end in a group too small to
 * fill it (stewards.ts). Runs before each event, so every event finds the
 * seats as relay time has left them.
 */
function advanceSeats(draft: Draft): void {
  for (const { proposal, passed } of newlyClosed(draft, draft.seated, 'steward')) {
    const change = stewardChangeOf(proposal);
    if (change !== null && passed) {
      draft.stewards = seatsAfterPass(draft, change, closeTime(proposal));
    }
  }
  draft.stewards = seatsAtTermEnds(draft);
}

/**
 * Brings the standing opt-ins up to `draft.at` (#117): each rules Proposal
 * that has passed and closed by then sets its value, once, in order of close
 * time and then relay order. A narrowing needs nothing here: it ends when its
 * off-Proposal closes. Runs before each event, beside {@link advanceSeats}.
 */
function advanceOptIns(draft: Draft): void {
  for (const { proposal, passed } of newlyClosed(draft, draft.ruled, 'rules')) {
    const change = rulesChangeOf(proposal);
    if (change !== null && passed) {
      draft.rules = { ...draft.rules, optIns: withChange(draft.rules.optIns, change) };
    }
  }
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
 */
export function fold(records: readonly LogRecord[], relayNow: number | null): GroupState {
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
    narrowings: [],
    seated: new Set(),
    ruled: new Set(),
  };
  const ignored: IgnoredRecord[] = [];
  const seen = new Set<string>();
  for (const { seq, received, bytes } of records) {
    // Relay time only moves on, whatever the record holds.
    draft.at = Math.max(draft.at, received);
    advanceSeats(draft);
    advanceOptIns(draft);
    const parsed = parseRecord(bytes);
    if (parsed === null) {
      ignored.push({ seq, id: null });
      continue;
    }
    const { event, id } = parsed;
    const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
    seen.add(id);
    if (!applied) ignored.push({ seq, id });
  }
  draft.at = relayNow ?? draft.at;
  advanceSeats(draft);
  advanceOptIns(draft);
  const proposals = draft.proposals.map((p) => settle(p, draft.rules, relayNow));
  const atoms = applyPasses(draft.atoms, proposals);
  const { group, rules, name, chat, title, members, former, at, stewards, suspensions } = draft;
  const { narrowings } = draft;
  return {
    group,
    rules,
    optIns: effectiveOptIns({ rules, proposals, narrowings, at }),
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
    narrowings,
    ignored,
  };
}
