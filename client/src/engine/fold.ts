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
 * (#117). Each member's voting rights arrive at a relay minute the fold
 * records as their `rightsAt`: at once for the founder and the bootstrap's
 * joiners, else after vouches and a wait (admission.ts, #101). The chat bot's
 * claims keep the first per Proposal moment (#119), and each Proposal keeps
 * the first Discord thread its open claimant records (#123). Each of the
 * group's own Proposals is numbered by its place among them (#123). A
 * Co-Creator's `dispatch` joins the group's Dispatches at its receipt, and a
 * Proposal carrying one sends it when its pass is final, at its close
 * (dispatches.ts, #112). A `dissolve` ends the group (#108): relay time stops
 * at its receipt, and the fold ignores every event after it, so no vouch
 * lands, no wait ends and no key change becomes due or lands from then on
 * (#98). A coalition's log folds here too (#100): its genesis names the seats
 * of the groups that reconcile, its participants join bound to a seat, and
 * its motions are decided by the results the groups post, never by ballots
 * (coalition.ts). A group's reconcile Proposals carry its seats, and
 * `outside` opens each coalition motion the group owes a result on as a
 * Proposal of its own (crossing.ts), with no number, no chat bot claims and
 * no Dispatch. The fold is pure: no I/O, no clock, no randomness, so every
 * device that folds the same records builds the same state.
 */
import { isUsableKxKey } from '../crypto/box';
import { verifyInviteToken } from '../crypto/invite';
import { bootstrapOpen, earnedAt, mayVouch, type Vouch, vouchesFor } from './admission';
import {
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  isSuspended,
  type Level,
  PARTICIPANT_LEVEL,
  wouldVote,
} from './capabilities';
import {
  type ChatPost,
  type ChatThread,
  isBotMoment,
  isThreadUrl,
  mayClaim,
  mayRecordThread,
} from './chatPosts';
import {
  bindsSeat,
  type Coalition,
  type CoalitionDraft,
  expireFormation,
  type Motion,
  motionOutcome,
  admitSeat,
  mayAdmit,
  newCoalition,
  RESULT_GRACE_MINUTES,
  recordResult,
  seatKeyFor,
} from './coalition';
import { optionFor } from './composeOption';
import { type Dispatch, dispatchFits, maySendDispatch } from './dispatches';
import { type Dissolution, mayProposeDissolve } from './dissolve';
import {
  type CarriedDispatch,
  type ChatPostedBody,
  type ChatThreadBody,
  type CoalitionGenesisBody,
  type DispatchBody,
  type DissolveBody,
  type DissolveProposalBody,
  EVENT_VERSION,
  fromBase64url,
  type GenesisBody,
  type GroupEvent,
  type GroupResultBody,
  type GroupResultValue,
  type InviteToken,
  isCoalitionGenesis,
  isDissolveProposal,
  isAdmitProposal,
  isReconcileProposal,
  isRulesProposal,
  type KeyRotateBody,
  type KxBody,
  isStewardProposal,
  type LevelBody,
  type NarrowBody,
  parseRecord,
  type ProposalBody,
  type ProposalEventBody,
  type AdmitProposalBody,
  type ReconcileProposalBody,
  type RulesProposalBody,
  type Score,
  type StewardProposalBody,
  type SuspendBody,
  type VersionBody,
  type VoteBody,
  type VouchBody,
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
 * `epoch` is the epoch of the mailbox it was read from (#98): absent for
 * epoch 0, so logs kept before #98 read as they always did.
 */
export interface LogRecord {
  readonly seq: number;
  readonly received: number;
  readonly bytes: Uint8Array;
  readonly epoch?: number;
}

/**
 * A member: the name fixed at join, the involvement level they chose most
 * recently, the seq and relay receipt minute of the event that admitted
 * them, who invited them (the author of a verified invite token, #73, or
 * null), and `rightsAt`, the relay minute their voting rights arrive (#101):
 * their genesis or join's receipt for the founder and the bootstrap's
 * joiners, the later of their wait's end and their second vouch for anyone
 * else, or null until they have the vouches. Once set it never changes, so
 * rights once earned stay. `kx` is their encryption key (#98): the X25519
 * public key their genesis, join or first `kx` carried, in base64url, or
 * null before one.
 */
export interface Member {
  readonly author: string;
  readonly name: string;
  readonly level: Level;
  readonly seq: number;
  readonly received: number;
  readonly invitedBy: string | null;
  readonly rightsAt: number | null;
  readonly kx: string | null;
}

/**
 * A canonical key change (#98): the first valid `key-rotate` of its epoch,
 * where it sits in relay order, who wrote it, its commit, and its wraps by
 * member key. Records read from the epoch before it, from its seq on, are
 * ignored.
 */
export interface Rotation {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly epoch: number;
  readonly commit: string;
  readonly wraps: Readonly<Record<string, string>>;
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
 * A proposed change to one Atom, a steward seat, an opt-in, or whether the
 * group goes on, with its vote.
 *
 * `target` says which: an edit of `atom`, a steward change (#102), a rules
 * change to an opt-in (#117), or dissolving the group (#108). A steward,
 * rules or dissolve Proposal's `atom` and `text` are `""`, and its one
 * version, under its own id, has no text. A recall's eligible set leaves out
 * the steward it would remove.
 *
 * `number` is its 1-based place among the group's Proposals in relay order,
 * counting only the ones the fold kept (#123): the name of its Discord thread
 * carries it, as no title may reach Discord (ADR-0039). A coalition motion
 * opened from `outside` (#100) is 0: it isn't the group's own, has no title
 * or author there, and isn't counted, so the group's own numbers are the same
 * whether or not a device has the coalition's log yet, as the chat bot's
 * fold never does.
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
 * is settled only when `final`. A Proposal still open when its group
 * dissolved (#108) is never final, so it has no outcome. `dispatch` is the
 * Dispatch it sends to the group if it passes (#112), or null.
 */
export interface Proposal {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly number: number;
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
  readonly dispatch: CarriedDispatch | null;
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
 * order, in force or ended (#117). `vouches` holds every valid vouch in relay
 * order (#101), visible to members like ballots (ADR-0010). `chatPosts` holds
 * the chat bot's winning claims, the first valid `chat-posted` per (Proposal,
 * moment), in relay order (#119), and `chatThreads` each Proposal's Discord
 * thread, the first valid `chat-thread` for it, in relay order (#123).
 * `dispatches` holds the group's Dispatches in the order they went out
 * (#112): each valid `dispatch` at its receipt, and each passed Proposal's at
 * its close, in close order, ahead of any record received from that minute
 * on. `epoch` is the group key's epoch: 0 at genesis, then one more for each
 * canonical key change, which `rotations` keeps in order (#98). `rotationDue`
 * is true once a membership has ended since the last canonical key change, or
 * genesis, until the next, or until the group dissolves, after which no key
 * change can land. `dissolved` is when the group dissolved, and whether its
 * vote chose to wipe every copy, or null while it goes on (#108). Once it has
 * dissolved, `at` stays at that receipt whatever the relay's `now`.
 * `coalitions` lists the group's reconcile Proposals (#100), each with its
 * public seat key and outcome. `coalition` is null for a group; for a
 * coalition's log it holds the seats, the participants' bindings, the results
 * the groups posted, each motion's seats and the status (coalition.ts), and
 * once it is declined `at` stays at that minute.
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
  readonly vouches: readonly Vouch[];
  readonly chatPosts: readonly ChatPost[];
  readonly chatThreads: readonly ChatThread[];
  readonly dispatches: readonly Dispatch[];
  readonly epoch: number;
  readonly rotations: readonly Rotation[];
  readonly rotationDue: boolean;
  readonly dissolved: Dissolution | null;
  readonly coalitions: readonly HeldSeat[];
  readonly coalition: Coalition | null;
  readonly ignored: readonly IgnoredRecord[];
}

/**
 * A group's seat in a coalition, as its reconcile Proposal sets it out
 * (#100): the Proposal's id, the public seat key, the coalition's proposed
 * name, title and Atoms, and the group's own outcome, `open` until its vote is
 * final, and a lapse counted as `fail`, as it crosses.
 */
export interface HeldSeat {
  readonly proposal: string;
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
  readonly outcome: GroupResultValue | 'open';
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
 * of the closed steward Proposals whose outcome the seats already show,
 * `ruled` those of the closed rules Proposals the opt-ins already show, and
 * `dispatched` those of the closed Proposals carrying a Dispatch that
 * `dispatches` already reflects (#112).
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
  readonly vouches: Vouch[];
  readonly chatPosts: ChatPost[];
  readonly chatThreads: ChatThread[];
  readonly dispatches: Dispatch[];
  epoch: number;
  readonly rotations: Rotation[];
  rotationDue: boolean;
  readonly seated: Set<string>;
  readonly ruled: Set<string>;
  readonly dispatched: Set<string>;
  dissolved: Dissolution | null;
  coalition: CoalitionDraft | null;
}

/** `kx` when it is a key a box can be sealed to (`crypto/box.ts`), else null (#98). */
function usableKx(kx: string | undefined): string | null {
  return kx !== undefined && isUsableKxKey(fromBase64url(kx)) ? kx : null;
}

/**
 * Founds a coalition (#100), unless its rules differ from the defaults or its
 * seats aren't two or more distinct keys. Its author isn't a participant: they
 * join under a seat like anyone else, so it has no members and no steward yet.
 */
function applyCoalitionGenesis(draft: Draft, body: CoalitionGenesisBody, at: Receipt): boolean {
  const rules = foundingRules(body.rules);
  const coalition = rules === null ? null : newCoalition(body, rules, at.received);
  if (rules === null || coalition === null) return false;
  draft.group = at.id;
  draft.rules = rules;
  draft.name = body.name;
  draft.chat = body.chat ?? null;
  draft.title = body.title;
  draft.atoms = genesisAtoms(body.atoms, at.id);
  draft.coalition = coalition;
  return true;
}

/** Genesis Atom `i` of `texts`, under the id `${genesisId}.${i}`. */
function genesisAtoms(texts: readonly string[], genesisId: string): Atom[] {
  return texts.map((text, i) => ({ id: `${genesisId}.${String(i)}`, documentId: genesisId, text }));
}

/** Founds a group, or a coalition (#100), from the first valid genesis. */
function applyAnyGenesis(
  draft: Draft,
  body: GenesisBody | CoalitionGenesisBody,
  author: string,
  at: Receipt,
): boolean {
  return isCoalitionGenesis(body)
    ? applyCoalitionGenesis(draft, body, at)
    : applyGenesis(draft, body, author, at);
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
  // The founder holds voting rights from genesis (ADR-0014's bootstrap, #101).
  draft.members.push({
    author,
    name: body.founder,
    level: FOUNDER_LEVEL,
    seq: at.seq,
    received: at.received,
    invitedBy: null,
    rightsAt: at.received,
    kx: usableKx(body.kx),
  });
  // The founder holds seat 1 with no term until the group elects someone (ADR-0049).
  draft.stewards = draft.stewards.map((s) => (s.seat === 1 ? { ...s, holder: author } : s));
  draft.atoms = genesisAtoms(body.atoms, at.id);
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
 * a new membership, with its own key (ADR-0009). The joiner holds voting
 * rights at once while the bootstrap is open, and otherwise earns them
 * (admission.ts, #101); either way they may choose any level.
 */
function applyJoin(draft: Draft, event: JoinEvent, at: Receipt): boolean {
  if (draft.coalition !== null) return applyParticipantJoin(draft, draft.coalition, event, at);
  const { author, body } = event;
  const level = body.level ?? DEFAULT_JOIN_LEVEL;
  if (!isLevel(level) || hasJoined(draft, author)) return false;
  const invitedBy = inviterOf(draft, body.token, event.group);
  const { seq, received } = at;
  const rightsAt = bootstrapOpen(draft) ? received : null;
  const kx = usableKx(body.kx);
  draft.members.push({ author, name: body.name, level, seq, received, invitedBy, rightsAt, kx });
  return true;
}

/**
 * A coalition's join (#100): someone not yet in, bound to a seat of the
 * coalition by that seat's proof for their key (coalition.ts). They take part
 * as the participant level, with rights at once, and the fold reads no level,
 * token or kx: the coalition checks only the seat, never a person's level in
 * their group, which would link identities (ADR-0009).
 */
function applyParticipantJoin(
  draft: Draft,
  coalition: CoalitionDraft,
  event: JoinEvent,
  at: Receipt,
): boolean {
  const { author, body, group } = event;
  const { seat, proof } = body;
  if (seat === undefined || proof === undefined || hasJoined(draft, author)) return false;
  if (!bindsSeat(coalition, group, author, seat, proof)) return false;
  const { seq, received } = at;
  const level = PARTICIPANT_LEVEL;
  draft.members.push({
    author,
    name: body.name,
    level,
    seq,
    received,
    invitedBy: null,
    rightsAt: received,
    kx: null,
  });
  coalition.bindings.push({ author, seat });
  return true;
}

/**
 * A vouch for a newcomer (ADR-0014, #101), when its author may vouch for them
 * (admission.ts). It's kept in relay order, and the vouch that gives a
 * newcomer the vouches they need fixes when their rights arrive: the later of
 * their wait's end and this vouch's receipt. Rights already set never move.
 */
function applyVouch(draft: Draft, body: VouchBody, author: string, at: Receipt): boolean {
  const { member } = body;
  if (!mayVouch(draft, author, member)) return false;
  draft.vouches.push({ id: at.id, seq: at.seq, received: at.received, by: author, member });
  const index = draft.members.findIndex((m) => m.author === member);
  const target = draft.members[index];
  if (target !== undefined && target.rightsAt === null) {
    const rightsAt = earnedAt(draft.rules, target.received, vouchesFor(draft, member));
    draft.members[index] = { ...target, rightsAt };
  }
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

/**
 * A title of 1–120 code points and a justification of at most 2,000, as every
 * Proposal needs, and a carried Dispatch that fits, when there is one (#112).
 */
function fieldsAreValid(body: ProposalEventBody): boolean {
  const titleLength = codePointLength(body.title);
  const carried = body.dispatch === undefined || dispatchFits(body.dispatch);
  return (
    titleLength >= 1 && titleLength <= TITLE_MAX && codePointLength(body.why) <= WHY_MAX && carried
  );
}

function proposalIsValid(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  return (
    can(draft, author, 'propose') &&
    draft.atoms.some((a) => a.id === body.atom) &&
    optionFor(openOn(draft, body.atom, at.received)) === 'propose' &&
    fieldsAreValid(body)
  );
}

/**
 * Who may vote on a Proposal that opens now (ADR-0015): everyone `wouldVote`
 * lets in, but `left`. Nobody in a coalition, where groups decide (#100).
 */
function eligibleNow(draft: Draft, left: string | null): string[] {
  if (draft.coalition !== null) return [];
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
 * The number the group's next own Proposal takes (#123): one more than the
 * Proposals already kept, leaving out the coalition motions opened from
 * `outside` (#100), which take none.
 */
function nextNumber(draft: Draft): number {
  return draft.proposals.filter((p) => p.target.kind !== 'motion').length + 1;
}

/**
 * What every Proposal opens with: its receipt, its number (#123), author,
 * class, window and a deadline `window` days after its receipt (#106), any
 * Dispatch it carries (#112), and no ballots yet.
 */
function opening(draft: Draft, body: ProposalEventBody, author: string, at: Receipt, term: Term) {
  const { cls, window } = term;
  return {
    ...at,
    number: nextNumber(draft),
    author,
    title: body.title,
    why: body.why,
    link: body.link ?? null,
    class: cls,
    window,
    deadline: at.received + window * DAY_MINUTES,
    ballots: [],
    closedAt: null,
    dispatch: body.dispatch ?? null,
  };
}

/**
 * Opens an edit at its class's bar, for the window its proposer chose within
 * the class's bounds, or the class default (#106), and returns it. A window
 * outside those bounds, or not a whole number, makes the fold ignore the
 * Proposal, and so returns null.
 */
function openEdit(
  draft: Draft,
  body: ProposalBody,
  author: string,
  at: Receipt,
): OpenProposal | null {
  if (!proposalIsValid(draft, body, author, at)) return null;
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return null;
  const proposal: OpenProposal = {
    ...opening(draft, body, author, at, { cls, window }),
    atom: body.atom,
    target: { kind: 'edit' },
    text: body.text,
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: body.text }],
  };
  draft.proposals.push(proposal);
  return proposal;
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
    ...opening(draft, body, author, at, { cls, window: draft.rules.windows[cls].default }),
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
    ...opening(draft, body, author, at, { cls, window }),
    atom: '',
    target,
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/**
 * Opens a dissolve Proposal (ADR-0051, #108) when its author may propose, no
 * other is open and the group hasn't dissolved (dissolve.ts). It is
 * entrenched, so it runs the window its proposer chose within the entrenched
 * bounds (#106), or their default. Its one version has no text, and everyone
 * whose level votes is eligible.
 */
function applyDissolveProposal(
  draft: Draft,
  body: DissolveProposalBody,
  author: string,
  at: Receipt,
): boolean {
  if (!fieldsAreValid(body) || !mayProposeDissolve(draft, author)) return false;
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  draft.proposals.push({
    ...opening(draft, body, author, at, { cls, window }),
    atom: '',
    target: body.target,
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/**
 * Opens a reconcile Proposal (#100; ADR-0036) when its author may propose:
 * ordinary, for the window its proposer chose or the default, with one
 * version that has no text. The fold keeps its target as written, secrets
 * included, with the public seat key its seat secret makes. A seat key another
 * reconcile Proposal here already holds is ignored, so each seat is one
 * Proposal's.
 */
function applyReconcile(
  draft: Draft,
  body: ReconcileProposalBody,
  author: string,
  at: Receipt,
): boolean {
  if (!fieldsAreValid(body) || !can(draft, author, 'propose')) return false;
  const key = seatKeyFor(body.target);
  if (draft.proposals.some((p) => p.target.kind === 'reconcile' && p.target.key === key)) {
    return false;
  }
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  draft.proposals.push({
    ...opening(draft, body, author, at, { cls, window }),
    atom: '',
    target: { ...body.target, key },
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/**
 * Opens a coalition motion (#100): once the coalition has formed, an edit of
 * one of its Atoms, by the group fold's own rules, deadline and bar included,
 * or admitting a group (#114, {@link applyAdmit}), with the seats it holds
 * now as the snapshot that decides it. Every other target waits: a steward,
 * rules or dissolve change would take effect in the fold while a pass can
 * still be contested, and reconciling a coalition is #122's. So does a motion
 * carrying a Dispatch (#112): its pass, once closed, can still be contested
 * into a fail, and a coalition's followers are #124's.
 */
function applyMotion(
  draft: Draft,
  coalition: CoalitionDraft,
  body: ProposalEventBody,
  author: string,
  at: Receipt,
): boolean {
  if (coalition.status !== 'formed' || body.dispatch !== undefined) return false;
  if ('target' in body)
    return isAdmitProposal(body) && applyAdmit(draft, coalition, body, author, at);
  const motion = openEdit(draft, body, author, at);
  if (motion === null) return false;
  const seats = coalition.seats.map((s) => s.key);
  coalition.motions.push({ id: motion.id, deadline: motion.deadline, seats, admit: null });
  return true;
}

/**
 * Opens a motion to admit a group into a formed coalition (#114; ADR-0036):
 * the one motion the fold takes from someone who isn't a participant, when
 * its seat's proof for their key verifies and no seat or earlier admit
 * motion holds that seat (coalition.ts). It is ordinary, for the window its
 * proposer chose or the default, with one version that has no text, and
 * every seat in its snapshot must pass it, whatever their number. Once its
 * pass is final, the group takes its seat ({@link advanceAdmissions}).
 */
function applyAdmit(
  draft: Draft,
  coalition: CoalitionDraft,
  body: AdmitProposalBody,
  author: string,
  at: Receipt,
): boolean {
  if (draft.group === null || hasJoined(draft, author) || !fieldsAreValid(body)) return false;
  if (!mayAdmit(coalition, draft.group, author, body.target)) return false;
  const window = chosenWindow(draft.rules, 'ordinary', body.window);
  if (window === null) return false;
  const proposal: OpenProposal = {
    ...opening(draft, body, author, at, { cls: 'ordinary', window }),
    atom: '',
    target: { kind: 'admit', seat: body.target.seat },
    text: '',
    eligible: [],
    versions: [{ id: at.id, author, text: '' }],
  };
  draft.proposals.push(proposal);
  const seats = coalition.seats.map((s) => s.key);
  coalition.motions.push({
    id: at.id,
    deadline: proposal.deadline,
    seats,
    admit: body.target.seat,
  });
  return true;
}

function applyProposal(
  draft: Draft,
  body: ProposalEventBody,
  author: string,
  at: Receipt,
): boolean {
  if (draft.coalition !== null) return applyMotion(draft, draft.coalition, body, author, at);
  if (isReconcileProposal(body)) return applyReconcile(draft, body, author, at);
  if (isStewardProposal(body)) return applySteward(draft, body, author, at);
  if (isRulesProposal(body)) return applyRules(draft, body, author, at);
  if (isDissolveProposal(body)) return applyDissolveProposal(draft, body, author, at);
  // Admitting a group is a coalition's motion (#114): a group's own log takes none.
  if (isAdmitProposal(body)) return false;
  return openEdit(draft, body, author, at) !== null;
}

/**
 * Ends the group (#108): the first `dissolve` from a member that names a
 * dissolve Proposal whose pass is final at the relay's receipt of it. From
 * here on the fold ignores every event ({@link admits}), and relay time
 * stops at this receipt. No key change can land after it either, so none is
 * due (#98), even for a leave that came just before it.
 */
function applyDissolve(draft: Draft, body: DissolveBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal?.target.kind !== 'dissolve' || !can(draft, author, 'read')) return false;
  if (isOpenAt(proposal, at.received)) return false;
  if (settle(proposal, draft, at.received).outcome.kind !== 'pass') return false;
  draft.dissolved = { received: at.received, wipe: proposal.target.wipe };
  draft.rotationDue = false;
  return true;
}

/**
 * Records a member group's result in a coalition (#100), from a current
 * participant bound to its seat (coalition.ts). A fail decides a motion at
 * once, so the motion closes at this receipt; a pass stays contestable until
 * results stop counting, so it closes nothing.
 */
function applyGroupResult(
  draft: Draft,
  body: GroupResultBody,
  author: string,
  at: Receipt,
): boolean {
  const { coalition, group } = draft;
  if (coalition === null || group === null) return false;
  if (!draft.members.some((m) => m.author === author)) return false;
  if (!recordResult(coalition, group, author, body, at)) return false;
  const motion = draft.proposals.find((p) => p.id === body.motion);
  if (motion?.closedAt === null && motionOutcome(coalition, motion.id, false).kind === 'fail') {
    motion.closedAt = at.received;
  }
  return true;
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
  const settled = draft.proposals.map((p) => settle(p, draft, draft.at));
  const { optIn, proposal } = body;
  if (!isOptIn(optIn) || !mayNarrow({ ...draft, proposals: settled }, author, body)) return false;
  const { id, seq, received } = at;
  draft.narrowings.push({ id, seq, received, by: author, optIn, proposal });
  return true;
}

/**
 * Keeps a chat bot claim (#119) when its author may claim that moment at its
 * receipt (chatPosts.ts): a member who isn't suspended, the bot on in effect,
 * a known Proposal whose due moment it names, and no claim kept for it yet.
 * The first valid claim per (Proposal, moment) in relay order wins.
 */
function applyChatPosted(draft: Draft, body: ChatPostedBody, author: string, at: Receipt): boolean {
  const { proposal, moment } = body;
  if (!isBotMoment(moment) || !mayClaim(draft, author, proposal, moment)) return false;
  draft.chatPosts.push({ ...at, by: author, proposal, moment });
  return true;
}

/**
 * Keeps a Proposal's Discord thread (#123) when its author may record it at
 * its receipt (chatPosts.ts): a member who isn't suspended and made the
 * Proposal's winning `open` claim, the bot on in effect, and no thread kept
 * for it yet, with a link of the one form the fold accepts. The first valid
 * `chat-thread` per Proposal in relay order wins.
 */
function applyChatThread(draft: Draft, body: ChatThreadBody, author: string, at: Receipt): boolean {
  const { proposal, url } = body;
  if (!isThreadUrl(url) || !mayRecordThread(draft, author, proposal)) return false;
  draft.chatThreads.push({ ...at, by: author, proposal, url });
  return true;
}

/**
 * Keeps a Co-Creator's Dispatch at its receipt (#112), when its author may
 * send it now and it fits (dispatches.ts). A Dispatch with no `doc` points to
 * no Document.
 */
function applyDispatch(draft: Draft, body: DispatchBody, author: string, at: Receipt): boolean {
  if (!maySendDispatch(draft, author, body)) return false;
  const { title, text, doc = null } = body;
  draft.dispatches.push({ id: at.id, by: author, title, text, doc, received: at.received });
  return true;
}

/**
 * Adds a version to an open Proposal's ballot, in relay order, while it holds
 * fewer than three (ADR-0004, ADR-0047). The author must hold `propose`.
 */
function applyVersion(draft: Draft, body: VersionBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || !isOpenAt(proposal, at.received)) return false;
  // A steward, rules or dissolve Proposal has no text, so it takes no versions (#102, #117, #108).
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

/** What {@link everyoneHasScored} reads: who may vote, the versions, and each voter's latest ballot. */
export interface ScoredProposal {
  readonly eligible: readonly string[];
  readonly versions: readonly Pick<Version, 'id'>[];
  readonly ballots: readonly Pick<Ballot, 'voter' | 'scores'>[];
}

/**
 * True when every eligible member's latest ballot scores every version: the
 * early close (spec §5). The fold and wakes (`wake.ts`, #99) both ask this.
 */
export function everyoneHasScored(proposal: ScoredProposal): boolean {
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
 * The event types a coalition's log takes (#100). Everything else, `vote` and
 * `version` included, is ignored there, so a motion has one version and no
 * ballots, and no `kx` or key change applies.
 */
const COALITION_TYPES: ReadonlySet<GroupEvent['type']> = new Set([
  'genesis',
  'join',
  'proposal',
  'group-result',
  'leave',
]);

/** Whether an event's type belongs in this log: a coalition's five, or anything but a result in a group. */
function fitsLog(draft: Draft, event: GroupEvent): boolean {
  return draft.coalition === null ? event.type !== 'group-result' : COALITION_TYPES.has(event.type);
}

/** True once a group has dissolved (#108) or a coalition was declined (#100): nothing applies after. */
function hasEnded(draft: Draft): boolean {
  return draft.dissolved !== null || draft.coalition?.status === 'declined';
}

/**
 * The one event guard: a version-1 event for a group that hasn't dissolved,
 * or a coalition that wasn't declined, of a type its log takes, from someone
 * who isn't suspended. After a `dissolve` the fold ignores every event, a
 * second `dissolve` included (#108), and after a coalition is declined every
 * event (#100). It ignores a suspended member's events until the suspension
 * ends (ADR-0016), except their `leave`, since exit is always possible
 * (ADR-0010, #77).
 */
function admits(draft: Draft, event: GroupEvent): boolean {
  const free = event.type === 'leave' || !isSuspended(draft, event.author);
  const current = !hasEnded(draft) && event.v === EVENT_VERSION;
  return current && inGroup(draft, event) && fitsLog(draft, event) && free;
}

/** The events that act on a Proposal: proposing, wording, voting, and dissolving on a pass (#108). */
type ProposalEvent = Extract<GroupEvent, { type: 'proposal' | 'version' | 'vote' | 'dissolve' }>;

/** Applies one admitted event that acts on a Proposal, or returns false to ignore it. */
function applyProposalEvent(draft: Draft, event: ProposalEvent, at: Receipt): boolean {
  switch (event.type) {
    case 'proposal':
      return applyProposal(draft, event.body, event.author, at);
    case 'version':
      return applyVersion(draft, event.body, event.author, at);
    case 'vote':
      return applyVote(draft, event.body, event.author, at);
    case 'dissolve':
      return applyDissolve(draft, event.body, event.author, at);
  }
}

/** Applies one verified event to the draft, or returns false to ignore it. */
function applyEvent(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  return admits(draft, event) && applyAdmitted(draft, event, at);
}

/** Applies one event {@link admits} let through, or returns false to ignore it. */
function applyAdmitted(draft: Draft, event: GroupEvent, at: Receipt): boolean {
  switch (event.type) {
    case 'genesis':
      return applyAnyGenesis(draft, event.body, event.author, at);
    case 'join':
      return applyJoin(draft, event, at);
    case 'level':
      return applyLevel(draft, event.body, event.author);
    case 'leave':
      return applyLeave(draft, event.author);
    default:
      return applyLater(draft, event, at);
  }
}

/**
 * The events the restored features added: `suspend` (#102), `narrow` (#117),
 * `vouch` (#101), `chat-posted` (#119), `chat-thread` (#123), `dispatch`
 * (#112), `kx` and `key-rotate` (#98), and `group-result` (#100).
 */
type LaterEvent = Extract<
  GroupEvent,
  {
    readonly type:
      | 'suspend'
      | 'narrow'
      | 'vouch'
      | 'chat-posted'
      | 'chat-thread'
      | 'dispatch'
      | 'kx'
      | 'key-rotate'
      | 'group-result';
  }
>;

/**
 * {@link applyAdmitted} for the types the restored features added, and the
 * events that act on a Proposal ({@link applyProposalEvent}).
 */
function applyLater(draft: Draft, event: LaterEvent | ProposalEvent, at: Receipt): boolean {
  switch (event.type) {
    case 'suspend':
      return applySuspend(draft, event.body, event.author, at);
    case 'narrow':
      return applyNarrow(draft, event.body, event.author, at);
    case 'vouch':
      return applyVouch(draft, event.body, event.author, at);
    case 'chat-posted':
      return applyChatPosted(draft, event.body, event.author, at);
    case 'chat-thread':
      return applyChatThread(draft, event.body, event.author, at);
    case 'dispatch':
      return applyDispatch(draft, event.body, event.author, at);
    case 'kx':
      return applyKx(draft, event.body, event.author);
    case 'key-rotate':
      return applyKeyRotate(draft, event.body, event.author, at);
    case 'group-result':
      return applyGroupResult(draft, event.body, event.author, at);
    default:
      return applyProposalEvent(draft, event, at);
  }
}

/**
 * Whether `event` ends a membership, and so calls for a new group key (#98;
 * ADR-0072 item 11): a `leave` now, and #115's `remove` once it lands. The
 * fold asks only of events it applied. This is the one trigger.
 */
export function endsMembership(event: Pick<GroupEvent, 'type'>): boolean {
  return event.type === 'leave';
}

/**
 * Records a member's encryption key (#98) when they have none yet and it is
 * one a box can be sealed to: the first per member counts, and a key carried
 * at genesis or join came first.
 */
function applyKx(draft: Draft, body: KxBody, author: string): boolean {
  const index = draft.members.findIndex((m) => m.author === author);
  const member = draft.members[index];
  const kx = usableKx(body.kx);
  if (member === undefined || member.kx !== null || kx === null) return false;
  draft.members[index] = { ...member, kx };
  return true;
}

/** A member who has an encryption key (#98). */
export type KeyHolder = Member & { readonly kx: string };

/** The members a key change must wrap to: every current member with an encryption key (#98). */
export function keyHolders(state: Pick<GroupState, 'members'>): KeyHolder[] {
  return state.members.filter((m): m is KeyHolder => m.kx !== null);
}

/** Whether `wraps` names exactly `recipients`, no one more and no one less. */
function wrapsExactly(wraps: Readonly<Record<string, string>>, recipients: readonly string[]) {
  const named = Object.keys(wraps);
  return named.length === recipients.length && recipients.every((key) => Object.hasOwn(wraps, key));
}

/**
 * Changes the group key (#98; ADR-0072 item 11), when a current member wrote
 * it, a membership has ended since the last canonical change, it names the
 * next epoch, and its wraps name exactly the current members with an
 * encryption key. The first valid one per epoch is canonical (relay order
 * decides, ADR-0073); from it on, records read from the old epoch's mailbox
 * change nothing.
 */
function applyKeyRotate(draft: Draft, body: KeyRotateBody, author: string, at: Receipt): boolean {
  const valid =
    draft.rotationDue &&
    draft.members.some((m) => m.author === author) &&
    body.epoch === draft.epoch + 1 &&
    wrapsExactly(
      body.wraps,
      keyHolders(draft).map((m) => m.author),
    );
  if (!valid) return false;
  const { epoch, commit, wraps } = body;
  draft.rotations.push({ ...at, by: author, epoch, commit, wraps });
  draft.epoch = epoch;
  draft.rotationDue = false;
  return true;
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

/**
 * The bar a Proposal's ballots are tallied at: its class's, or for a coalition
 * motion the bar the coalition set (#100).
 */
function barOf(proposal: OpenProposal, rules: Rules): Bar {
  return proposal.target.kind === 'motion' ? proposal.target.bar : rules.bars[proposal.class];
}

/**
 * Fixes a coalition motion's finality and outcome from the results its seats
 * posted (#100): a fail is final at once, and a pass once results stop
 * counting, at deadline + 10,080, since until then a contest can turn it into
 * a fail. Its one version wins a pass. Until it is decided it reads as a
 * lapse, as a Proposal no one has scored does.
 */
function settleMotion(
  proposal: OpenProposal,
  coalition: CoalitionDraft,
  bar: Bar,
  relayNow: number | null,
): Proposal {
  const expired = relayNow !== null && relayNow >= proposal.deadline + RESULT_GRACE_MINUTES;
  const { kind } = motionOutcome(coalition, proposal.id, expired);
  const final = kind === 'fail' || expired;
  const outcome: TallyOutcome =
    kind === 'pass'
      ? { kind, version: proposal.id, bar }
      : { kind: kind === 'fail' ? kind : 'lapse', bar };
  return { ...proposal, final, outcome };
}

/**
 * Fixes a Proposal's finality and tallies its ballots at its bar; in a
 * coalition, decides a motion by its seats' results instead (#100).
 */
function settle(
  proposal: OpenProposal,
  draft: Pick<Draft, 'rules' | 'coalition'>,
  relayNow: number | null,
): Proposal {
  const bar = barOf(proposal, draft.rules);
  if (draft.coalition !== null) return settleMotion(proposal, draft.coalition, bar, relayNow);
  const final = proposal.closedAt !== null || (relayNow !== null && relayNow >= proposal.deadline);
  const { outcome } = tallyAt(proposal, bar);
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
 * The Proposals `wanted` picks that have closed by `draft.at` and that
 * `applied` doesn't hold yet, each marked applied, in order of close time and
 * then relay order, with whether each passed.
 */
function newlyClosed(
  draft: Draft,
  applied: Set<string>,
  wanted: (proposal: OpenProposal) => boolean,
): { proposal: OpenProposal; passed: boolean }[] {
  const closed = draft.proposals.filter(
    (p) => wanted(p) && !applied.has(p.id) && !isOpenAt(p, draft.at),
  );
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  return closed
    .sort((a, b) => closeTime(a) - closeTime(b))
    .map((proposal) => {
      applied.add(proposal.id);
      const passed = settle(proposal, draft, draft.at).outcome.kind === 'pass';
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
  const steward = (proposal: OpenProposal) => proposal.target.kind === 'steward';
  for (const { proposal, passed } of newlyClosed(draft, draft.seated, steward)) {
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
  const rules = (proposal: OpenProposal) => proposal.target.kind === 'rules';
  for (const { proposal, passed } of newlyClosed(draft, draft.ruled, rules)) {
    const change = rulesChangeOf(proposal);
    if (change !== null && passed) {
      draft.rules = { ...draft.rules, optIns: withChange(draft.rules.optIns, change) };
    }
  }
}

/**
 * The Document a Proposal changes (#112): its Atom's, for an edit. A steward,
 * rules or dissolve Proposal's `atom` is `""`, which names no Atom, so it
 * changes none.
 */
function documentOf(draft: Draft, proposal: OpenProposal): string | null {
  return draft.atoms.find((atom) => atom.id === proposal.atom)?.documentId ?? null;
}

/**
 * Brings the Dispatches up to `draft.at` (#112): each Proposal carrying one
 * that has passed and closed by then sends it, once, in order of close time
 * and then relay order, as a Dispatch from the Proposal, under the Proposal's
 * id, pointing to the Document it changed, received at its close. A fail or a
 * lapse sends nothing. Runs before each event, beside {@link advanceSeats}, so
 * it comes ahead of every record received from its close on.
 */
function advanceDispatches(draft: Draft): void {
  const carries = (proposal: OpenProposal) => proposal.dispatch !== null;
  for (const { proposal, passed } of newlyClosed(draft, draft.dispatched, carries)) {
    const { id, dispatch } = proposal;
    if (dispatch === null || !passed) continue;
    const doc = documentOf(draft, proposal);
    draft.dispatches.push({
      id,
      by: { proposal: id },
      ...dispatch,
      doc,
      received: closeTime(proposal),
    });
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
 * sync; it decides only which Proposals have reached their deadline. Once the
 * group has dissolved, relay time stops at the dissolve's receipt (#108), so a
 * Proposal open then stays open, with no outcome, and no opt-in changes,
 * whatever `relayNow` says. A record
 * that doesn't verify, or whose event's `author` isn't the key that signed it,
 * is ignored before it is parsed or claims an event id, so a forged copy of a
 * real event can never shadow it. A repeated event id is ignored (the first
 * copy keeps its seq and receipt time), as is any event whose `v` isn't 1 or
 * whose `group` isn't the genesis id. Only members act, except on their own
 * join: `can()` is false for anyone else, including someone who has left.
 *
 * `outside` holds the coalition motions this group's seats decide (#100),
 * from crossing.ts's `motionsFor`: each opens as a Proposal of the group's
 * right after its records with a lower relay seq, with the coalition's class,
 * window, deadline and bar, and the group's ballots decide it as any other.
 * A coalition's own log takes none. `relayNow` should be the relay's latest
 * `now` from any mailbox: it is one clock.
 */
export function fold(
  records: readonly LogRecord[],
  relayNow: number | null,
  outside: readonly Motion[] = [],
): GroupState {
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
    vouches: [],
    chatPosts: [],
    chatThreads: [],
    dispatches: [],
    epoch: 0,
    rotations: [],
    rotationDue: false,
    seated: new Set(),
    ruled: new Set(),
    dispatched: new Set(),
    dissolved: null,
    coalition: null,
  };
  const ignored: IgnoredRecord[] = [];
  const seen = new Set<string>();
  const motions = [...outside].sort((a, b) => a.seq - b.seq);
  for (const record of records) {
    openMotionsBefore(draft, motions, record.seq);
    if (!foldRecord(draft, record, seen)) ignored.push({ seq: record.seq, id: idOf(record) });
  }
  openMotionsBefore(draft, motions, Infinity);
  const now = endTime(draft, relayNow);
  draft.at = now ?? draft.at;
  if (draft.coalition !== null) advanceAdmissions(draft, draft.coalition);
  advanceSeats(draft);
  advanceOptIns(draft);
  advanceDispatches(draft);
  const proposals = draft.proposals.map((p) => settle(p, draft, now));
  const atoms = applyPasses(draft.atoms, proposals);
  const { group, rules, name, chat, title, members, former, at, stewards, suspensions } = draft;
  const { narrowings, vouches, chatPosts, chatThreads, dispatches, epoch, rotations, rotationDue } =
    draft;
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
    vouches,
    chatPosts,
    chatThreads,
    dispatches,
    epoch,
    rotations,
    rotationDue,
    dissolved: draft.dissolved,
    coalitions: heldSeats(proposals),
    coalition: draft.coalition,
    ignored,
  };
}

/**
 * Where relay time stands once every record is in: `relayNow`, unless the
 * group dissolved (#108) or the coalition was declined (#100), when it stopped
 * there. A coalition still forming when `relayNow` reaches its `formsBy` is
 * declined then.
 */
function endTime(draft: Draft, relayNow: number | null): number | null {
  if (draft.coalition !== null) expireFormation(draft.coalition, relayNow ?? draft.at);
  return draft.dissolved?.received ?? draft.coalition?.declinedAt ?? relayNow;
}

/** The group's reconcile Proposals as seats (#100): each one's key, statement and outcome. */
function heldSeats(proposals: readonly Proposal[]): HeldSeat[] {
  return proposals.flatMap((p) => {
    if (p.target.kind !== 'reconcile') return [];
    const { key, name, title, atoms } = p.target;
    const pass = p.outcome.kind === 'pass';
    const outcome = p.final ? (pass ? 'pass' : 'fail') : 'open';
    return [{ proposal: p.id, key, name, title, atoms, outcome }];
  });
}

/**
 * Opens, in a group, each coalition motion whose relay seq is below `seq`
 * that hasn't opened yet (#100), taking it from the front of `motions`, which
 * is in seq order. Relay time moves on to its receipt first, as for a record,
 * so its eligible set is everyone `wouldVote` lets in there. A group that
 * hasn't been founded or has dissolved opens none, and a coalition's own log
 * takes none (#122 nests them).
 */
function openMotionsBefore(draft: Draft, motions: Motion[], seq: number): void {
  while (motions.length > 0 && (motions[0]?.seq ?? seq) < seq) {
    const motion = motions.shift();
    if (motion !== undefined) openMotion(draft, motion);
  }
}

/**
 * Opens one coalition motion as a group Proposal, with the coalition's class,
 * window, deadline and bar. It isn't the group's own: it has no number (0,
 * #123), no title, text or author, and carries no Dispatch (#112), since its
 * words are the coalition's.
 */
function openMotion(draft: Draft, motion: Motion): void {
  if (draft.group === null || draft.coalition !== null || draft.dissolved !== null) return;
  if (draft.proposals.some((p) => p.id === motion.id)) return;
  advanceTo(draft, motion.received);
  const { id, seq, received, coalition, bar, window, deadline } = motion;
  draft.proposals.push({
    id,
    seq,
    received,
    author: '',
    atom: '',
    target: { kind: 'motion', coalition, bar },
    title: '',
    why: '',
    text: '',
    link: null,
    class: motion.class,
    window,
    deadline,
    eligible: eligibleNow(draft, null),
    versions: [{ id, author: '', text: '' }],
    ballots: [],
    closedAt: null,
    number: 0,
    dispatch: null,
  });
}

/** The id of the event a record holds, or null when it doesn't verify or hold one. */
function idOf(record: LogRecord): string | null {
  return parseRecord(record.bytes)?.id ?? null;
}

/**
 * Seats each group whose admit motion's pass has become final by `draft.at`
 * (#114), once, in order of when it became final, deadline + 10,080, and
 * then relay order: a later motion's snapshot, and a later join, see it.
 */
function advanceAdmissions(draft: Draft, coalition: CoalitionDraft): void {
  const due = coalition.motions
    .filter((m) => m.admit !== null && draft.at >= m.deadline + RESULT_GRACE_MINUTES)
    .sort((a, b) => a.deadline - b.deadline);
  for (const motion of due) {
    const proposal = draft.proposals.find((p) => p.id === motion.id);
    if (proposal === undefined) continue;
    // Results on it have stopped counting, so its outcome is final here.
    const settled = settleMotion(proposal, coalition, barOf(proposal, draft.rules), draft.at);
    if (settled.outcome.kind === 'pass') {
      admitSeat(coalition, motion, motion.deadline + RESULT_GRACE_MINUTES);
    }
  }
}

/**
 * Moves relay time on to `received`, never back, and brings the seats,
 * opt-ins and carried Dispatches up to it (#112). A coalition still forming
 * when it reaches its `formsBy` is declined there, and relay time stops at
 * that minute (#100). A coalition seats each group admitted by then (#114).
 */
function advanceTo(draft: Draft, received: number): void {
  draft.at = Math.max(draft.at, received);
  if (draft.coalition !== null) {
    expireFormation(draft.coalition, draft.at);
    draft.at = draft.coalition.declinedAt ?? draft.at;
    advanceAdmissions(draft, draft.coalition);
  }
  advanceSeats(draft);
  advanceOptIns(draft);
  advanceDispatches(draft);
}

/**
 * Folds one record into the draft, returning whether it was applied.
 *
 * A record read from a mailbox of another epoch than the group's now, such as
 * a stale invite's join or a late writer's Proposal after a key change (#98),
 * changes nothing at all: not relay time, and not the event ids seen, so the
 * copy its author posts again to the new mailbox folds once. Otherwise relay
 * time moves on, whatever the record holds, until the group dissolves (#108),
 * and the seats, opt-ins and carried Dispatches catch up to it before the
 * event is checked. A repeated event id is ignored.
 */
function foldRecord(draft: Draft, record: LogRecord, seen: Set<string>): boolean {
  const { seq, received, bytes, epoch = 0 } = record;
  if (epoch !== draft.epoch) return false;
  if (!hasEnded(draft)) advanceTo(draft, received);
  const parsed = parseRecord(bytes);
  if (parsed === null) return false;
  const { event, id } = parsed;
  const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
  seen.add(id);
  // A coalition has no group key, so a leave there ends only that participant (#100).
  if (applied && endsMembership(event) && draft.coalition === null) draft.rotationDue = true;
  return applied;
}
