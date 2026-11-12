/**
 * The group fold (docs/spec/phase-1-spec.md §4): a mailbox's records, in relay
 * order, become one `GroupState`.
 *
 * Every rule is checked against the state before the event. An event that
 * breaks one lands in `ignored` and changes nothing. Votes run on relay time
 * (`received`, in whole minutes); the author's `ts` plays no part. Genesis
 * founds the group with its rules, and each Proposal's class, set when it
 * opens, picks its bar and bounds the window its proposer chose. A Document
 * changes only when a Proposal's pass is final: an edit sets an Atom's text
 * or, with `""`, removes it, and an add puts a new Atom after its anchor
 * (#75). Final passes apply in order of close time, then the Proposals' relay
 * order. Steward seats
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
 * no Dispatch. A removal (#115) runs a fixed 14 days at its own bar without
 * the person it names, who may post one response; from its final pass they
 * only read, and the first valid `remove` takes them out as a leave would, so
 * the key changes once. A priority vote changes no Atom: the top option of the
 * latest one to pass is the group's focus (#107). A `result` records a decided
 * Proposal's counts and a commitment to its ballots (#111): with the ballots
 * held, the fold checks it against them, and once a device has cleared them,
 * the Proposal closes, counts and decides by the result it reads ahead,
 * closing where the result says its closing ballot came (#289). The fold is
 * pure: no I/O, no clock, no randomness, so every device that folds the same
 * records builds the same state.
 */
import { isUsableKxKey } from '../crypto/box';
import { verifyInviteToken } from '../crypto/invite';
import { bootstrapOpen, earnedAt, mayVouch, type Vouch, vouchesFor } from './admission';
import {
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  isOusted,
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
  settlesAt,
  recordResult,
  recordWrap,
  seatKeyFor,
} from './coalition';
import { ballotCommit, commitEntries, scoreCounts, scoresOf } from './commit';
import { optionFor } from './composeOption';
import { type Dispatch, dispatchFits, maySendDispatch } from './dispatches';
import { type Dissolution, mayProposeDissolve } from './dissolve';
import {
  type CarriedDispatch,
  type ChatPostedBody,
  type ChatThreadBody,
  type CoalitionGenesisBody,
  type DispatchBody,
  type DoorInvitedBody,
  type DissolveBody,
  type DissolveProposalBody,
  EVENT_VERSION,
  fromBase64url,
  type GenesisBody,
  type GroupEvent,
  type GroupResultBody,
  type GroupResultValue,
  type InviteToken,
  type AddProposalBody,
  isAddProposal,
  isCoalitionGenesis,
  isDissolveProposal,
  isAdmitProposal,
  isPriorityProposal,
  isReconcileProposal,
  isRemovalProposal,
  isRulesProposal,
  type KeyRotateBody,
  type KxBody,
  isStewardProposal,
  type LevelBody,
  type NarrowBody,
  type ParsedEvent,
  parseRecord,
  type PriorityProposalBody,
  type ProposalBody,
  type ProposalEventBody,
  type AdmitProposalBody,
  type ReconcileProposalBody,
  type RecordedOutcome,
  type RemovalProposalBody,
  type RemovalResponseBody,
  type RemoveBody,
  type RoomWrapBody,
  type ResultBody,
  type ResultVersion,
  type RulesProposalBody,
  type Score,
  type StewardProposalBody,
  type SuspendBody,
  type VersionBody,
  type VoteBody,
  type VouchBody,
} from './event';
import { type DoorInvite, mayRecordInvite } from './frontDoor';
import { isOpenAt } from './open';
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
import { isPriority, optionId, optionsAreValid } from './priority';
import {
  extendedBy,
  mayProposeRemoval,
  mayRemove,
  mayRespond,
  type Removal,
  type RemovalResponse,
  responseFits,
} from './removal';
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

/**
 * A recovery share as the log carries it (#109): the event's id, where it
 * sits in relay order, who sent it, and its box, unopened. The fold never
 * reads the box; each device tries to open it (`store/recovery.ts`), and
 * only the contact it was sealed to can.
 */
export interface SealedShare {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly box: string;
}

/**
 * A recovery alert as the log carries it (#118): the same shape as a share,
 * its box sealed to the person it warns. Only that person's devices can open
 * it (`recovery/alert.ts`); the contact who posted it holds the share for
 * 72 hours of relay time from `received`.
 */
export type SealedAlert = SealedShare;

/**
 * A recovery cancel as the log carries it (#118): the event's id, where it
 * sits in relay order, who sent it, and the 16-byte tag of the alert it
 * answers. Only the contact who posted that alert knows the tag is theirs,
 * and their device counts the cancel only from the person whose share it
 * holds.
 */
export interface RecoveryCancel {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly alert: string;
}

/**
 * A unit of the Document. Genesis Atom `i` has the id `${genesisId}.${i}`, and
 * an added Atom has its add Proposal's id (#75). `documentId` is the genesis id.
 */
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
 * A proposed change to the Document (an Atom's text, a new Atom, or a
 * removal), a steward seat, an opt-in, or whether the group goes on, with its
 * vote.
 *
 * `target` says which: an edit of `atom`, where a winning `""` removes the
 * Atom; an add (#75), whose `atom` is its own id, the Atom it would create
 * after its anchor; a steward change (#102); a rules change to an opt-in
 * (#117); or dissolving the group (#108). A steward, rules or dissolve
 * Proposal's `atom` and `text` are `""`, and its one version, under its own
 * id, has no text. A recall's eligible set leaves out the steward it would
 * remove. A priority vote (#107) asks what to focus on: its `title` is the
 * question, its `atom` its own id, which no Atom has, its `text` `""`, and
 * its versions its options, option `i` with the id `${id}.${i}`, all by its
 * proposer.
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
 * early, or null. While the fold runs it stays null until the fold reaches
 * that ballot, or for a cleared Proposal the place its result records
 * (#289), so every rule finds it open or closed there ({@link isOpenAt}).
 * `final` is true once it has closed, early or because relay time reached
 * `deadline`. `outcome` is the tally of the ballots so far, and
 * is settled only when `final`. A Proposal still open when its group
 * dissolved (#108) is never final, so it has no outcome. `dispatch` is the
 * Dispatch it sends to the group if it passes (#112), or null.
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
 * The group's current focus (#107): the top option of the latest priority
 * vote whose pass is final, with the vote's id, the option's id and its text.
 */
export interface Focus {
  readonly proposal: string;
  readonly option: string;
  readonly text: string;
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
 * on. `doorInvites` holds each invite a member sent from the front door, the
 * first valid `door-invited` per application, in relay order (#121). `epoch`
 * is the group key's epoch: 0 at genesis, then one more for each canonical
 * key change, which `rotations` keeps in order (#98). `rotationDue` is true
 * once a membership has ended since the last canonical key change, or
 * genesis, until the next, or until the group dissolves, after which no key
 * change can land. `dissolved` is when the group dissolved, and whether its
 * vote chose to wipe every copy, or null while it goes on (#108). Once it has
 * dissolved, `at` stays at that receipt whatever the relay's `now`.
 * `recoveryShares` holds every `recovery-share` a current member sent, in
 * relay order, boxes unopened (#109), and `recoveryAlerts` and
 * `recoveryCancels` every `recovery-alert` and `recovery-cancel` (#118): they
 * govern nothing, so no other field reads them.
 * `removals` holds each removal whose pass is final by `at`, in order of
 * close, with the `remove` that took its member out once one folds, and
 * `responses` each response the person a removal names posted on its ballot,
 * in relay order (#115).
 * `coalitions` lists the group's reconcile Proposals (#100), each with its
 * public seat key and outcome. `coalition` is null for a group; for a
 * coalition's log it holds the seats, the participants' bindings, the results
 * the groups posted, each motion's seats and the status (coalition.ts), and
 * once it is declined `at` stays at that minute. `focus` is the current
 * focus, or null before any priority vote passes (#107).
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
  readonly removals: readonly Removal[];
  readonly responses: readonly RemovalResponse[];
  readonly narrowings: readonly Narrowing[];
  readonly vouches: readonly Vouch[];
  readonly chatPosts: readonly ChatPost[];
  readonly chatThreads: readonly ChatThread[];
  readonly dispatches: readonly Dispatch[];
  readonly doorInvites: readonly DoorInvite[];
  readonly epoch: number;
  readonly rotations: readonly Rotation[];
  readonly rotationDue: boolean;
  readonly dissolved: Dissolution | null;
  readonly recoveryShares: readonly SealedShare[];
  readonly recoveryAlerts: readonly SealedAlert[];
  readonly recoveryCancels: readonly RecoveryCancel[];
  readonly coalitions: readonly HeldSeat[];
  readonly coalition: Coalition | null;
  readonly focus: Focus | null;
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

/**
 * A cleared Proposal's record, read ahead (#111): its first `result` after it
 * in relay order, with that result's id, seq and receipt.
 */
interface ReadAhead {
  readonly id: string;
  readonly seq: number;
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

/** An open Proposal as it is pushed, before #111's clearing fields are added. */
type Opening = Omit<OpenProposal, 'cleared' | 'readAhead' | 'result' | 'mismatched'>;

/** The Document at some relay minute, and the closed Proposals it was worked out from. */
interface DocumentAt {
  /** The closed Proposals' ids, in relay order, joined by spaces. */
  readonly closed: string;
  readonly atoms: readonly Atom[];
}

/**
 * The state the fold builds up, one event at a time. `seated` holds the ids
 * of the closed steward Proposals whose outcome the seats already show,
 * `ruled` those of the closed rules Proposals the opt-ins already show, and
 * `judged` those of the closed removals `removals` already shows (#115), and
 * `dispatched` those of the closed Proposals carrying a Dispatch that
 * `dispatches` already reflects (#112). `founded` is the Document genesis
 * founded, before any pass, and `document` the Document as the latest
 * Proposal found it, kept until another closes.
 */
interface Draft {
  group: string | null;
  rules: Rules;
  name: string;
  chat: string | null;
  title: string;
  readonly members: Member[];
  readonly former: Member[];
  founded: readonly Atom[];
  document: DocumentAt;
  readonly proposals: OpenProposal[];
  at: number;
  stewards: readonly Seat[];
  readonly suspensions: Suspension[];
  readonly removals: Removal[];
  readonly responses: RemovalResponse[];
  readonly narrowings: Narrowing[];
  readonly vouches: Vouch[];
  readonly chatPosts: ChatPost[];
  readonly chatThreads: ChatThread[];
  readonly dispatches: Dispatch[];
  readonly doorInvites: DoorInvite[];
  epoch: number;
  readonly rotations: Rotation[];
  rotationDue: boolean;
  readonly seated: Set<string>;
  readonly ruled: Set<string>;
  readonly judged: Set<string>;
  readonly dispatched: Set<string>;
  dissolved: Dissolution | null;
  readonly recoveryShares: SealedShare[];
  readonly recoveryAlerts: SealedAlert[];
  readonly recoveryCancels: RecoveryCancel[];
  coalition: CoalitionDraft | null;
  /** The Proposals whose ballots this device has cleared (#111). */
  readonly cleared: ReadonlySet<string>;
  /** Each cleared Proposal's first result after it in relay order, found before the fold starts. */
  readonly firstResults: ReadonlyMap<string, FirstResult>;
  /** Cleared Proposals whose read-ahead result didn't hold up where it sits: read nothing ahead. */
  readonly distrusted: ReadonlySet<string>;
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
  draft.founded = genesisAtoms(body.atoms, at.id);
  draft.document = { closed: '', atoms: draft.founded };
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
  draft.founded = genesisAtoms(body.atoms, at.id);
  draft.document = { closed: '', atoms: draft.founded };
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
 * A member leaves (ADR-0010: exit is always possible), or a `remove` takes
 * them out (#115). They move from `members` to `former`, so from here on
 * `can()` refuses them everything and the fold ignores their later events. A
 * Proposal already open keeps them in its eligible set (ADR-0015 §1), so its
 * quorum and early close don't change, the ballots they sent before still
 * count, and their Proposals and versions stay on the ballot. This is the one
 * place a membership ends: a seat the member holds empties here too (#102),
 * and a suspension stays on record.
 */
function departs(draft: Draft, author: string): boolean {
  const index = draft.members.findIndex((m) => m.author === author);
  const member = draft.members[index];
  if (member === undefined) return false;
  draft.members.splice(index, 1);
  draft.former.push(member);
  draft.stewards = vacate(draft.stewards, author);
  return true;
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

/**
 * The Document as an event received at relay minute `received` finds it: the
 * founded Atoms with every pass that is final by then applied, in pass order
 * (#75). In a group it's worked out again only when the set of closed
 * Proposals changes. A coalition's is worked out every time: a closed
 * motion's results can still be contested, and its pass turns final only
 * once results stop counting, so its outcome moves while that set holds still
 * (#100).
 */
function documentAt(draft: Draft, received: number): readonly Atom[] {
  const closed = draft.proposals.filter((p) => !isOpenAt(p, received));
  const key = closed.map((p) => p.id).join(' ');
  if (key !== draft.document.closed || draft.coalition !== null) {
    const settled = closed.map((p) => settle(p, draft, received));
    draft.document = { closed: key, atoms: applyPasses(draft.founded, settled, draft.group) };
  }
  return draft.document.atoms;
}

/** True when the Atom `id` is in the Document an event received at `received` finds. */
function inDocument(draft: Draft, id: string, received: number): boolean {
  return documentAt(draft, received).some((a) => a.id === id);
}

function proposalIsValid(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  return (
    can(draft, author, 'propose') &&
    inDocument(draft, body.atom, at.received) &&
    optionFor(openOn(draft, body.atom, at.received)) === 'propose' &&
    fieldsAreValid(body)
  );
}

/**
 * An add's anchor is in the Document, or null for the start, and its text
 * isn't empty: only an edit can carry `""`, which removes its Atom (#75).
 */
function addIsValid(draft: Draft, body: AddProposalBody, author: string, at: Receipt): boolean {
  const { after } = body.target;
  return (
    can(draft, author, 'propose') &&
    body.text !== '' &&
    (after === null || inDocument(draft, after, at.received)) &&
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

/**
 * True when a result's `closedSeq`, if it names one, could be the place of the
 * ballot that closed the Proposal early (#289): the close is early, and the
 * seq comes after the Proposal's and before the result's own.
 */
function placeFits(found: ReadAhead, opened: Opening): boolean {
  const { closedSeq, closedAt } = found.body;
  if (closedSeq === undefined) return true;
  return closedAt < opened.deadline && closedSeq > opened.seq && closedSeq < found.seq;
}

/**
 * True when a result read ahead can be a Proposal's record (#111): it arrived
 * in a later minute than its close, closes the Proposal between its receipt
 * and its deadline as its counts allow, at a place that fits (#289), counts
 * the Proposal's eligible set from its first version on (version 1, under
 * the Proposal's id, or a priority vote's first option, `${id}.0`, #107), and
 * names the outcome its counts give at the Proposal's bar.
 */
function recordFits(found: ReadAhead, opened: Opening, bar: Bar): boolean {
  const { body } = found;
  const { deadline } = opened;
  return (
    found.received > body.closedAt &&
    body.closedAt >= opened.received &&
    body.closedAt <= deadline &&
    placeFits(found, opened) &&
    body.eligible === opened.eligible.length &&
    body.versions[0]?.id === opened.versions[0]?.id &&
    closeIsPossible(body, deadline) &&
    outcomeFollows(body, bar)
  );
}

/**
 * A cleared Proposal's record: its first result after it, when that result
 * is for this group and fits (`recordFits`). Null for any other Proposal.
 */
function readAheadFor(draft: Draft, opened: Opening): ReadAhead | null {
  const { id } = opened;
  if (!draft.cleared.has(id) || draft.distrusted.has(id)) return null;
  const found = draft.firstResults.get(id);
  if (found === undefined || found.group !== draft.group) return null;
  const fits = recordFits(found, opened, barOf(opened, draft.rules));
  return fits ? { id: found.id, seq: found.seq, received: found.received, body: found.body } : null;
}

/**
 * Opens a Proposal (#111): adds whether its ballots are cleared and its
 * read-ahead record, then keeps it, in relay order, and returns it. Like any
 * other, it has no early close yet: one its record gives comes when the fold
 * reaches it ({@link closeReadAhead}, #289).
 */
function openProposal(draft: Draft, opened: Opening): OpenProposal {
  const proposal: OpenProposal = {
    ...opened,
    cleared: draft.cleared.has(opened.id),
    readAhead: readAheadFor(draft, opened),
    closedAt: null,
    result: null,
    mismatched: [],
  };
  draft.proposals.push(proposal);
  return proposal;
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
  return openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: body.atom,
    target: { kind: 'edit' },
    text: body.text,
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: body.text }],
  });
}

/**
 * Opens an add (#75): its Atom, created on a pass, takes the Proposal's own
 * id. Like an edit, it runs the window its proposer chose within its class's
 * bounds, or the class default, and one outside them is ignored (#106).
 */
function applyAdd(draft: Draft, body: AddProposalBody, author: string, at: Receipt): boolean {
  if (!addIsValid(draft, body, author, at)) return false;
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: at.id,
    target: body.target,
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
  openProposal(draft, {
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
  openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: '',
    target,
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/** True while a priority vote is open at relay minute `received`. A group has at most one. */
function priorityOpenAt(draft: Draft, received: number): boolean {
  return draft.proposals.some((p) => isPriority(p) && isOpenAt(p, received));
}

/**
 * Opens a priority vote (#107): its author holds `propose`, it has 2–7
 * options, each 1–120 code points and no two the same, no other priority
 * vote is open, its window, if it names one, is within its class's bounds
 * (#106), and any Dispatch it carries fits (#112). Option `i` goes on the
 * ballot as the version `${id}.${i}`. Like any of the group's own Proposals
 * it takes the next number (#123).
 */
function applyPriority(
  draft: Draft,
  body: PriorityProposalBody,
  author: string,
  at: Receipt,
): boolean {
  if (!can(draft, author, 'propose') || !fieldsAreValid(body)) return false;
  if (!optionsAreValid(body.options) || priorityOpenAt(draft, at.received)) return false;
  const cls = targetClass(draft, body);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  // Like every Proposal, it opens through openProposal, so its ballots and notes expire (#111).
  openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: at.id,
    target: { kind: 'priority' },
    text: '',
    eligible: eligibleNow(draft, null),
    versions: body.options.map((text, i) => ({ id: optionId(at.id, i), author, text })),
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
  openProposal(draft, {
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
 * Opens a removal (ADR-0049, ADR-0075 §3, #115) when its author may propose
 * one against its member now (removal.ts). It runs the removal class's fixed
 * window, whatever the proposer wrote, at removal's own bar; its one version
 * has no text, and the member it names isn't in its eligible set, so their
 * own 0 never counts. A suspension of them running now lasts until it closes
 * (ADR-0059).
 */
function applyRemovalProposal(
  draft: Draft,
  body: RemovalProposalBody,
  author: string,
  at: Receipt,
): boolean {
  const { member } = body.target;
  if (!fieldsAreValid(body) || !mayProposeRemoval(draft, author, member)) return false;
  const cls = targetClass(draft, body);
  const proposal = openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window: draft.rules.windows[cls].default }),
    atom: '',
    target: { kind: 'remove', member },
    text: '',
    eligible: eligibleNow(draft, member),
    versions: [{ id: at.id, author, text: '' }],
  });
  // The suspension of them running now, if any, lasts until this vote closes:
  // a cleared one's early close comes once the fold reaches it (#111, #289).
  extendSuspension(draft, proposal, (s) => s.member === member && draft.at < s.until);
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
  openProposal(draft, {
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
 * Keeps the suspension `which` picks, if any, until removal `proposal` closes
 * (ADR-0059): the one running when the removal opens, to its deadline, and
 * then the one it extended, to its early close once one comes. A suspension
 * that starts while a removal is open is never tied to it.
 */
function extendSuspension(
  draft: Draft,
  proposal: OpenProposal,
  which: (suspension: Suspension) => boolean,
): void {
  const index = draft.suspensions.findIndex(which);
  const suspension = draft.suspensions[index];
  if (suspension !== undefined) {
    draft.suspensions[index] = extendedBy(suspension, draft.rules, proposal);
  }
}

/**
 * Opens a coalition motion (#100): once the coalition has formed, an edit of
 * one of its Atoms, by the group fold's own rules, deadline and bar included,
 * or admitting a group (#114, {@link applyAdmit}), with the seats it holds
 * now as the snapshot that decides it. Every other target waits: a steward,
 * rules or dissolve change would take effect in the fold while a pass can
 * still be contested, and reconciling a coalition is #122's. An edit may
 * carry a Dispatch for the coalition's readers (#124), which goes out only
 * once its pass is final ({@link advanceMotionDispatches}); an admit carries
 * none. An add (#75) has a target, so it waits too, and so does a removal,
 * an edit whose text is `""`: for now a motion only rewords one of the
 * coalition's Atoms. A priority vote (#107) has a target too, so a coalition
 * asks none.
 */
function applyMotion(
  draft: Draft,
  coalition: CoalitionDraft,
  body: ProposalEventBody,
  author: string,
  at: Receipt,
): boolean {
  if (coalition.status !== 'formed') return false;
  if ('target' in body)
    return isAdmitProposal(body) && applyAdmit(draft, coalition, body, author, at);
  // Nor does a removal (#75), whose `""` would take out one of the coalition's Atoms.
  if (body.text === '') return false;
  const motion = openEdit(draft, body, author, at);
  if (motion === null) return false;
  const seats = coalition.seats.map((s) => s.key);
  coalition.motions.push({ id: motion.id, deadline: motion.deadline, seats, admit: null });
  return true;
}

/**
 * Opens a motion to admit a group into a formed coalition (#114; ADR-0036):
 * the one motion the fold takes from someone who isn't a participant, when
 * its seat's proof for their key verifies, no seat or earlier admit motion
 * holds that seat (coalition.ts), and its seat's `kx` can take a box, for the
 * room's `inner` to reach the group once it's admitted (#313). It is
 * ordinary, for the window its proposer chose or the default, with one
 * version that has no text, and every seat in its snapshot must pass it,
 * whatever their number. Once its pass is final, the group takes its seat
 * ({@link advanceAdmissions}).
 */
function applyAdmit(
  draft: Draft,
  coalition: CoalitionDraft,
  body: AdmitProposalBody,
  author: string,
  at: Receipt,
): boolean {
  if (draft.group === null || hasJoined(draft, author) || !fieldsAreValid(body)) return false;
  // Admitting a group sends no Dispatch: the coalition's readers learn of it from its seats.
  if (body.dispatch !== undefined) return false;
  // The room's inner is wrapped to its seat's kx once it's admitted (#313): it must take a box.
  if (usableKx(body.target.kx) === null) return false;
  if (!mayAdmit(coalition, draft.group, author, body.target)) return false;
  const window = chosenWindow(draft.rules, 'ordinary', body.window);
  if (window === null) return false;
  const proposal = openProposal(draft, {
    ...opening(draft, body, author, at, { cls: 'ordinary', window }),
    atom: '',
    target: { kind: 'admit', seat: body.target.seat },
    text: '',
    eligible: [],
    versions: [{ id: at.id, author, text: '' }],
  });
  const seats = coalition.seats.map((s) => s.key);
  coalition.motions.push({
    id: at.id,
    deadline: proposal.deadline,
    seats,
    admit: { ...body.target.seat, kx: body.target.kx },
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
  if (isRemovalProposal(body)) return applyRemovalProposal(draft, body, author, at);
  if (isReconcileProposal(body)) return applyReconcile(draft, body, author, at);
  if (isPriorityProposal(body)) return applyPriority(draft, body, author, at);
  if (isStewardProposal(body)) return applySteward(draft, body, author, at);
  if (isRulesProposal(body)) return applyRules(draft, body, author, at);
  if (isDissolveProposal(body)) return applyDissolveProposal(draft, body, author, at);
  // Admitting a group is a coalition's motion (#114): a group's own log takes none.
  if (isAdmitProposal(body)) return false;
  return isAddProposal(body)
    ? applyAdd(draft, body, author, at)
    : openEdit(draft, body, author, at) !== null;
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
 * Records a wrap of the room's `inner` for a seat admitted into a coalition
 * (#313), from a current participant bound to another seat
 * (`coalition.ts`'s `recordWrap`). A wrap changes nothing else: the admitted
 * group's devices open it to read the room.
 */
function applyRoomWrap(draft: Draft, body: RoomWrapBody, author: string, at: Receipt): boolean {
  const { coalition } = draft;
  if (coalition === null || !draft.members.some((m) => m.author === author)) return false;
  return recordWrap(coalition, author, body, at);
}

/**
 * Suspends a member for the group's `suspensionDays` from the relay's receipt
 * (ADR-0016), when the author may suspend them now and the reason fits
 * (stewards.ts). Stewards can't lengthen one (ADR-0059): only a removal vote
 * against the member, opened while it runs, does ({@link extendSuspension}).
 */
function applySuspend(draft: Draft, body: SuspendBody, author: string, at: Receipt): boolean {
  const reason = body.reason ?? null;
  if (!maySuspend(draft, author, body.member) || !reasonFits(reason)) return false;
  const { id, seq, received } = at;
  const until = suspensionEnd(draft.rules, received);
  const { member } = body;
  draft.suspensions.push({ id, seq, received, by: author, member, reason, until, removal: null });
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
 * Whether a version's text fits its Proposal: a steward, rules, dissolve or
 * member removal Proposal has no text, so it takes none (#102, #117, #108,
 * #115), nor does a priority vote, whose options are fixed when it opens
 * (#107), and only an edit's version may be `""`, which removes its section;
 * an add's needs text (#75).
 */
function versionTextFits(proposal: OpenProposal, text: string): boolean {
  const { kind } = proposal.target;
  return kind === 'edit' || (kind === 'add' && text !== '');
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
 * send it now and it fits (dispatches.ts). Any `doc` must name a Document as
 * the Dispatch finds it, after every pass final by then (#75). A Dispatch
 * with no `doc` points to no Document.
 */
function applyDispatch(draft: Draft, body: DispatchBody, author: string, at: Receipt): boolean {
  const state = { ...draft, atoms: documentAt(draft, at.received) };
  if (!maySendDispatch(state, author, body)) return false;
  const { title, text, doc = null } = body;
  draft.dispatches.push({ id: at.id, by: author, title, text, doc, received: at.received });
  return true;
}

/**
 * Keeps a record of an invite sent from the front door (#121) when its author
 * may record it at its receipt (frontDoor.ts): they may invite, the door is
 * open in effect, the application id is a SHA-256, and none is kept for it
 * yet. The first valid one per application in relay order wins.
 */
function applyDoorInvited(
  draft: Draft,
  body: DoorInvitedBody,
  author: string,
  at: Receipt,
): boolean {
  const { application } = body;
  if (!mayRecordInvite(draft, author, application)) return false;
  draft.doorInvites.push({ ...at, by: author, application });
  return true;
}

/**
 * True when a cleared Proposal's record from before #289, which doesn't say
 * where in its close's minute the closing ballot came, puts this version on
 * its ballot: it arrived in that minute, before the closing ballot (#111). A
 * record that says (`closedSeq`) closes the Proposal at that place instead,
 * so a version finds it open or closed there, as with the ballots held.
 */
function listedAtClose(proposal: OpenProposal, at: Receipt): boolean {
  const body = proposal.readAhead?.body;
  if (body === undefined || body.closedSeq !== undefined) return false;
  return at.received === proposal.closedAt && body.versions.some((version) => version.id === at.id);
}

/**
 * Adds a version to an open Proposal's ballot, in relay order, while it holds
 * fewer than three (ADR-0004, ADR-0047). The author must hold `propose`.
 */
function applyVersion(draft: Draft, body: VersionBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined) return false;
  if (!isOpenAt(proposal, at.received) && !listedAtClose(proposal, at)) return false;
  if (!versionTextFits(proposal, body.text)) return false;
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

/**
 * Keeps a voter's latest valid ballot, toward an uncleared Proposal only: a
 * cleared one's counts come from its result (#111). The ballot after which
 * everyone eligible has scored every version closes the Proposal early, and a
 * suspension a removal vote extends then ends at the later of its own end and
 * that close (ADR-0059, #115).
 */
function applyVote(draft: Draft, body: VoteBody, author: string, at: Receipt): boolean {
  const proposal = draft.proposals.find((p) => p.id === body.proposal);
  if (proposal === undefined || proposal.cleared) return false;
  if (!ballotIsValid(draft, proposal, body, author, at)) return false;
  const note = body.note ?? null;
  const ballot = { ...at, voter: author, scores: body.scores, note, salt: body.salt ?? '' };
  proposal.ballots = [...proposal.ballots.filter((b) => b.voter !== author), ballot];
  if (everyoneHasScored(proposal)) {
    proposal.closedAt = at.received;
    extendSuspension(draft, proposal, (s) => s.removal === proposal.id);
  }
  return true;
}

/**
 * Keeps the response the person a removal names posts on its ballot (#115),
 * when they may post it now and it fits (removal.ts): theirs, once, while it
 * is open, suspended or not.
 */
function applyRemovalResponse(
  draft: Draft,
  body: RemovalResponseBody,
  author: string,
  at: Receipt,
): boolean {
  const { proposal, text } = body;
  if (!mayRespond(draft, author, proposal) || !responseFits(text)) return false;
  draft.responses.push({ ...at, by: author, proposal, text });
  return true;
}

/**
 * Takes the member a removal names out of the group (#115): the first valid
 * `remove` naming a removal whose pass is final (removal.ts). They leave as
 * on a leave ({@link departs}), so their seat empties and the group's key
 * changes after it (#98).
 */
function applyRemove(draft: Draft, body: RemoveBody, author: string, at: Receipt): boolean {
  if (!mayRemove(draft, author, body.proposal)) return false;
  const index = draft.removals.findIndex((removal) => removal.proposal === body.proposal);
  const removal = draft.removals[index];
  if (removal === undefined) return false;
  const { id, seq, received } = at;
  draft.removals[index] = { ...removal, removed: { id, seq, received, by: author } };
  return departs(draft, removal.member);
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
 * Where an early close came (#289): the seq of the ballot that closed it,
 * which is its last ballot, since the fold keeps a voter's latest ballot last
 * and none counts after the close. Nothing for a Proposal with no early close.
 */
function closingPlace(proposal: Pick<Proposal, 'closedAt' | 'ballots'>): { closedSeq?: number } {
  const closing = proposal.closedAt === null ? undefined : proposal.ballots.at(-1);
  return closing === undefined ? {} : { closedSeq: closing.seq };
}

/**
 * What a Proposal's own ballots give a result, apart from its outcome: the
 * close, and for an early close the closing ballot's seq (#289), the eligible
 * count, each version's counts and the commitment. A device posts this (with
 * the outcome) and checks results against it.
 */
export function heldRecord(
  proposal: Pick<Proposal, 'id' | 'closedAt' | 'deadline' | 'eligible' | 'versions' | 'ballots'>,
): Omit<ResultBody, 'outcome'> {
  const ids = proposal.versions.map((version) => version.id);
  return {
    proposal: proposal.id,
    closedAt: closeTime(proposal),
    ...closingPlace(proposal),
    eligible: proposal.eligible.length,
    versions: ids.map((id) => ({ id, counts: scoreCounts(proposal.ballots, id) })),
    commit: ballotCommit(commitEntries(ids, proposal.ballots)),
  };
}

/**
 * True when a result closes the Proposal where its own ballots do: in the
 * same minute and, when the result names one, at the same seq (#289). A
 * result from before #289 names none and still counts.
 */
function closesAsHeld(body: ResultBody, own: Omit<ResultBody, 'outcome'>): boolean {
  const place = body.closedSeq === undefined || body.closedSeq === own.closedSeq;
  return body.closedAt === own.closedAt && place;
}

/** True when a result checks out against the ballots this device holds. */
function matchesBallots(draft: Draft, proposal: OpenProposal, body: ResultBody): boolean {
  const own = heldRecord(proposal);
  return (
    body.eligible === own.eligible &&
    listsVersions(proposal, body) &&
    closesAsHeld(body, own) &&
    body.commit === own.commit &&
    sameList(lines(body.versions), lines(own.versions)) &&
    outcomeFollows(body, barOf(proposal, draft.rules))
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
 * The events a suspended member may still post: a removal's response (#115),
 * and the recovery events, which govern nothing: a recovery share (#109), and
 * a recovery alert or cancel (#118).
 */
const UNSUSPENDED: ReadonlySet<GroupEvent['type']> = new Set([
  'removal-response',
  'recovery-share',
  'recovery-alert',
  'recovery-cancel',
]);

/**
 * Whether the author of `event` may act now: anyone may leave, since exit is
 * always possible (ADR-0010, #77); once a removal of them has passed, nothing
 * else counts (#115); and while a suspension runs (ADR-0016), only their
 * response to a removal of them (ADR-0049) and their recovery events, which
 * govern nothing, do: a `recovery-share` (#109), and a `recovery-alert` or
 * `recovery-cancel` (#118), since a suspended person must still hear of a
 * recovery and be able to stop it, and a suspended contact's alert must still
 * reach them.
 */
function mayAct(draft: Draft, event: GroupEvent): boolean {
  if (event.type === 'leave') return true;
  if (isOusted(draft, event.author)) return false;
  return UNSUSPENDED.has(event.type) || !isSuspended(draft, event.author);
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
  'room-wrap',
  'leave',
]);

/** The event types only a coalition's log takes: a result (#100) and a room wrap (#313). */
const COALITION_ONLY: ReadonlySet<GroupEvent['type']> = new Set(['group-result', 'room-wrap']);

/** Whether an event's type belongs in this log: a coalition's six, or anything but theirs alone in a group. */
function fitsLog(draft: Draft, event: GroupEvent): boolean {
  return draft.coalition === null
    ? !COALITION_ONLY.has(event.type)
    : COALITION_TYPES.has(event.type);
}

/** True once a group has dissolved (#108) or a coalition was declined (#100): nothing applies after. */
function hasEnded(draft: Draft): boolean {
  return draft.dissolved !== null || draft.coalition?.status === 'declined';
}

/**
 * The one event guard: a version-1 event for a group that hasn't dissolved,
 * or a coalition that wasn't declined, of a type its log takes, from someone
 * who may act now ({@link mayAct}). After a `dissolve` the fold ignores every
 * event, a second `dissolve` included (#108), and after a coalition is
 * declined every event (#100). A coalition's log takes none of the recovery
 * events (`fitsLog`): a share (#109), and so its alert and cancel (#118),
 * travels only in a group the person shares with their contact.
 */
function admits(draft: Draft, event: GroupEvent): boolean {
  const current = !hasEnded(draft) && event.v === EVENT_VERSION;
  return current && inGroup(draft, event) && fitsLog(draft, event) && mayAct(draft, event);
}

/**
 * The events that act on a Proposal: proposing, wording, voting, its result
 * (#111), dissolving on a pass (#108), and a removal's response and `remove`
 * (#115).
 */
type ProposalEvent = Extract<
  GroupEvent,
  {
    type: 'proposal' | 'version' | 'vote' | 'result' | 'dissolve' | 'removal-response' | 'remove';
  }
>;

/** Applies one admitted event that acts on a Proposal, or returns false to ignore it. */
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
    case 'dissolve':
      return applyDissolve(draft, event.body, event.author, at);
    case 'removal-response':
      return applyRemovalResponse(draft, event.body, event.author, at);
    case 'remove':
      return applyRemove(draft, event.body, event.author, at);
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
      return departs(draft, event.author);
    case 'recovery-share':
    case 'recovery-alert':
    case 'recovery-cancel':
      return applyRecovery(draft, event, at);
    case 'message':
      // A room's message belongs to the room's own log (room.ts, #125), never a group's.
      return false;
    default:
      return applyLater(draft, event, at);
  }
}

/**
 * The events the restored features added: `suspend` (#102), `narrow` (#117),
 * `vouch` (#101), `chat-posted` (#119), `chat-thread` (#123), `dispatch`
 * (#112), `kx` and `key-rotate` (#98), `group-result` (#100), and
 * `door-invited` (#121).
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
      | 'group-result'
      | 'door-invited'
      | 'room-wrap';
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
    default:
      return applyKeyed(draft, event, at);
  }
}

/**
 * {@link applyLater} for `kx` and `key-rotate` (#98), `group-result` (#100)
 * and `door-invited` (#121), and the events that act on a Proposal
 * ({@link applyProposalEvent}).
 */
function applyKeyed(
  draft: Draft,
  event:
    | Exclude<
        LaterEvent,
        {
          readonly type:
            'suspend' | 'narrow' | 'vouch' | 'chat-posted' | 'chat-thread' | 'dispatch';
        }
      >
    | ProposalEvent,
  at: Receipt,
): boolean {
  switch (event.type) {
    case 'kx':
      return applyKx(draft, event.body, event.author);
    case 'key-rotate':
      return applyKeyRotate(draft, event.body, event.author, at);
    case 'group-result':
      return applyGroupResult(draft, event.body, event.author, at);
    case 'door-invited':
      return applyDoorInvited(draft, event.body, event.author, at);
    case 'room-wrap':
      return applyRoomWrap(draft, event.body, event.author, at);
    default:
      return applyProposalEvent(draft, event, at);
  }
}

/**
 * Whether `event` ends a membership, and so calls for a new group key (#98;
 * ADR-0072 item 11): a `leave`, or a `remove` (#115). The fold asks only of
 * events it applied. This is the one trigger.
 */
export function endsMembership(event: Pick<GroupEvent, 'type'>): boolean {
  return event.type === 'leave' || event.type === 'remove';
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

/** The recovery events (#109, #118): a share, an alert and a cancel. */
type RecoveryEvent = Extract<
  GroupEvent,
  { readonly type: 'recovery-share' | 'recovery-alert' | 'recovery-cancel' }
>;

/**
 * Keeps a recovery share (#109), alert or cancel (#118) from any current
 * member, a box unopened and a cancel's tag as it came. It changes nothing
 * else: no Atom, Proposal, member or seat reads them.
 */
function applyRecovery(draft: Draft, event: RecoveryEvent, at: Receipt): boolean {
  const by = event.author;
  if (!draft.members.some((m) => m.author === by)) return false;
  switch (event.type) {
    case 'recovery-share':
      draft.recoveryShares.push({ ...at, by, box: event.body.box });
      break;
    case 'recovery-alert':
      draft.recoveryAlerts.push({ ...at, by, box: event.body.box });
      break;
    case 'recovery-cancel':
      draft.recoveryCancels.push({ ...at, by, alert: event.body.alert });
      break;
  }
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
 * The bar a Proposal's ballots are tallied at: its class's, or for a coalition
 * motion the bar the coalition set (#100).
 */
function barOf(proposal: Pick<Proposal, 'target' | 'class'>, rules: Rules): Bar {
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
  proposal: Omit<OpenProposal, 'readAhead'>,
  coalition: CoalitionDraft,
  bar: Bar,
  relayNow: number | null,
): Proposal {
  const expired = relayNow !== null && relayNow >= settlesAt(proposal);
  const { kind } = motionOutcome(coalition, proposal.id, expired);
  const final = kind === 'fail' || expired;
  const outcome: TallyOutcome =
    kind === 'pass'
      ? { kind, version: proposal.id, bar }
      : { kind: kind === 'fail' ? kind : 'lapse', bar };
  return { ...proposal, final, outcome };
}

/**
 * Fixes a Proposal's finality and tallies it at its bar: from its ballots, or
 * from the record it read ahead once they're cleared (#111). In a coalition,
 * it decides a motion by its seats' results instead (#100).
 */
function settle(
  proposal: OpenProposal,
  draft: Pick<Draft, 'rules' | 'coalition'>,
  relayNow: number | null,
): Proposal {
  const { readAhead, ...rest } = proposal;
  const bar = barOf(rest, draft.rules);
  if (draft.coalition !== null) return settleMotion(rest, draft.coalition, bar, relayNow);
  const final = rest.closedAt !== null || (relayNow !== null && relayNow >= rest.deadline);
  const counts = rest.cleared ? (readAhead?.body.versions ?? []) : null;
  const { outcome } = tallyAt(rest, counts, bar);
  return { ...rest, final, outcome };
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

/** The winning version's text once a Proposal's pass is final, else null. */
function passedText(proposal: Proposal): string | null {
  if (!proposal.final || proposal.outcome.kind !== 'pass') return null;
  const winner = proposal.outcome.version;
  return proposal.versions.find((v) => v.id === winner)?.text ?? null;
}

/** `atoms` with `atom` right after the Atom `after`, first for null, or last when `after` is gone. */
function insertAfter(atoms: readonly Atom[], after: string | null, atom: Atom): readonly Atom[] {
  if (after === null) return [atom, ...atoms];
  const index = atoms.findIndex((a) => a.id === after);
  if (index === -1) return [...atoms, atom];
  return [...atoms.slice(0, index + 1), atom, ...atoms.slice(index + 1)];
}

/**
 * Brings the removals up to `draft.at` (#115): each removal that has passed
 * and closed by then, once, in order of close time and then relay order.
 * From then on its member only reads (`can()`), until a `remove` takes them
 * out; one who has already left needs no `remove` (removal.ts). Runs before
 * each event, before {@link advanceSeats}, so no one a removal has passed
 * against is seated.
 */
function advanceRemovals(draft: Draft): void {
  const removes = (proposal: OpenProposal) => proposal.target.kind === 'remove';
  for (const { proposal, passed } of newlyClosed(draft, draft.judged, removes)) {
    const { target } = proposal;
    if (target.kind !== 'remove' || !passed) continue;
    const passedAt = closeTime(proposal);
    draft.removals.push({ proposal: proposal.id, member: target.member, passedAt, removed: null });
  }
}

/**
 * The Atoms after one Proposal's pass, or as they were when it hasn't passed
 * or changes no Atom (a steward, rules or priority Proposal, #102, #117,
 * #107): an edit sets
 * its Atom's text or, with `""`, removes it; an add puts its Atom after its
 * anchor (#75).
 */
function applyPass(
  atoms: readonly Atom[],
  proposal: Proposal,
  documentId: string,
): readonly Atom[] {
  const text = passedText(proposal);
  const { target } = proposal;
  if (text === null) return atoms;
  if (target.kind === 'add') {
    return insertAfter(atoms, target.after, { id: proposal.id, documentId, text });
  }
  if (target.kind !== 'edit') return atoms;
  if (text === '') return atoms.filter((a) => a.id !== proposal.atom);
  return atoms.map((a) => (a.id === proposal.atom ? { ...a, text } : a));
}

/**
 * The Document a Proposal changes (#112): its Atom's, for an edit, one that
 * removes its section included, and the one Document an add's new Atom joins
 * (#75), as {@link applyPasses} gives it. An Atom that genesis didn't found
 * came from an add, so it's in that Document too. A steward, rules, dissolve
 * or member removal (#115) Proposal changes none.
 */
function documentOf(draft: Draft, proposal: OpenProposal): string | null {
  const { kind } = proposal.target;
  if (kind !== 'edit' && kind !== 'add') return null;
  const founded = draft.founded.find((atom) => atom.id === proposal.atom);
  return founded?.documentId ?? draft.group;
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
  if (draft.coalition !== null) {
    advanceMotionDispatches(draft, draft.coalition);
    return;
  }
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

/** Brings the removals, the seats, the opt-ins and the carried Dispatches up to `draft.at`, in that order. */
function advanceAll(draft: Draft): void {
  advanceRemovals(draft);
  advanceSeats(draft);
  advanceOptIns(draft);
  advanceDispatches(draft);
}

/**
 * Brings a coalition's Dispatches up to `draft.at` (#124): each motion
 * carrying one sends it once its pass is final, at deadline + 10,080, since
 * until then a contest could still turn the pass into a fail (#100). They go
 * out once each, in the order they turn final and then relay order, from the
 * motion, under its id, pointing to the coalition's Document, received in
 * that minute. A fail, a contest or a lapse sends nothing, and nor does a
 * motion still open when the coalition is declined, since relay time stops.
 */
function advanceMotionDispatches(draft: Draft, coalition: CoalitionDraft): void {
  const due = draft.proposals.filter(
    (p) => p.dispatch !== null && !draft.dispatched.has(p.id) && draft.at >= settlesAt(p),
  );
  // `proposals` is in relay order and sort is stable, so equal deadlines keep relay order.
  for (const proposal of due.sort((a, b) => a.deadline - b.deadline)) {
    draft.dispatched.add(proposal.id);
    const settled = settleMotion(proposal, coalition, barOf(proposal, draft.rules), draft.at);
    if (proposal.dispatch === null || settled.outcome.kind !== 'pass') continue;
    const { id, dispatch } = proposal;
    const doc = documentOf(draft, proposal);
    draft.dispatches.push({
      id,
      by: { proposal: id },
      ...dispatch,
      doc,
      received: settlesAt(proposal),
    });
  }
}

/**
 * Applies final passes to the founded Atoms in order of close time, then the
 * Proposals' relay order. When two adds share an anchor, the one applied later
 * ends up directly after it. A new Atom joins the one Document, `documentId`.
 */
function applyPasses(
  founded: readonly Atom[],
  proposals: readonly Proposal[],
  documentId: string | null,
): readonly Atom[] {
  return inCloseOrder(proposals).reduce(
    (atoms, p) => applyPass(atoms, p, documentId ?? ''),
    founded,
  );
}

/** The Proposals in order of close time, then relay order. */
function inCloseOrder(proposals: readonly Proposal[]): Proposal[] {
  // `proposals` is in relay order and sort is stable, so equal close times keep relay order.
  return [...proposals].sort((a, b) => closeTime(a) - closeTime(b));
}

/** A priority vote's top option, once its pass is final, else null (#107). */
function topOption(proposal: Proposal): Focus | null {
  if (!isPriority(proposal) || !proposal.final || proposal.outcome.kind !== 'pass') return null;
  const option = proposal.outcome.version;
  const text = proposal.versions.find((v) => v.id === option)?.text;
  return text === undefined ? null : { proposal: proposal.id, option, text };
}

/**
 * The group's focus (#107): the top option of the last priority vote to pass,
 * in close order. A priority vote that fails or lapses leaves it as it was,
 * and so does one still open when its group dissolves (#108), which is never
 * final.
 */
function focusOf(proposals: readonly Proposal[]): Focus | null {
  return inCloseOrder(proposals).reduce<Focus | null>((focus, p) => topOption(p) ?? focus, null);
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
 *
 * `cleared` lists the Proposals whose ballots this device has deleted (#111).
 * Each closes, counts and decides by its first result after it, read ahead,
 * so its early close falls where its ballots put it: right after the closing
 * ballot's seq the result names (#289), or, for a result from before #289
 * that names none, at the start of its minute. A ballot still in the log for
 * one is ignored. When a read-ahead result turns out not to hold up
 * where it sits, the fold runs once more without reading it ahead. Every
 * record is verified and parsed once, before either pass.
 */
export function fold(
  records: readonly LogRecord[],
  relayNow: number | null,
  outside: readonly Motion[] = [],
  cleared: readonly string[] = [],
): GroupState {
  const reads = records.map(({ seq, received, bytes, epoch = 0 }) => ({
    seq,
    received,
    epoch,
    parsed: parseRecord(bytes),
  }));
  const clearedSet = new Set(cleared);
  const pass = {
    reads,
    relayNow,
    outside,
    cleared: clearedSet,
    firstResults: firstResults(reads, clearedSet, outside),
    distrusted: new Set<string>(),
  };
  const first = foldPass(pass);
  if (first.distrusted.length === 0) return first.state;
  return foldPass({ ...pass, distrusted: new Set(first.distrusted) }).state;
}

/** A record read once: its place in the relay's log, its mailbox's epoch, and its event, or null when it doesn't verify. */
interface Read {
  readonly seq: number;
  readonly received: number;
  readonly epoch: number;
  readonly parsed: ParsedEvent | null;
}

/** A cleared Proposal's first result after it, read ahead, with the group its event names. */
type FirstResult = ReadAhead & { readonly group: string };

/**
 * Notes, in `opened`, the cleared Proposals that have opened by the time the
 * fold reaches `read`: each cleared motion from `outside` with a lower seq
 * (#100), which it takes from the front of `waiting`, in seq order, and the
 * cleared Proposal `read` itself opens.
 */
function markOpened(
  read: Read,
  cleared: ReadonlySet<string>,
  waiting: Motion[],
  opened: Set<string>,
) {
  while (waiting.length > 0 && (waiting[0]?.seq ?? read.seq) < read.seq) {
    const motion = waiting.shift();
    if (motion !== undefined) opened.add(motion.id);
  }
  const { parsed } = read;
  if (parsed?.event.type === 'proposal' && cleared.has(parsed.id)) opened.add(parsed.id);
}

/**
 * Each cleared Proposal's first `result` after it opens, in relay order, with
 * that result's seq and receipt, which the fold reads ahead (#111). A coalition
 * motion opens where `outside` puts it (#100).
 */
function firstResults(
  reads: readonly Read[],
  cleared: ReadonlySet<string>,
  outside: readonly Motion[],
): Map<string, FirstResult> {
  const waiting = outside.filter((m) => cleared.has(m.id)).sort((a, b) => a.seq - b.seq);
  const opened = new Set<string>();
  const first = new Map<string, FirstResult>();
  for (const read of reads) {
    markOpened(read, cleared, waiting, opened);
    const { seq, received, parsed } = read;
    if (parsed?.event.type !== 'result') continue;
    const { event, id } = parsed;
    const { body, group } = event;
    if (opened.has(body.proposal) && !first.has(body.proposal)) {
      first.set(body.proposal, { id, seq, received, body, group });
    }
  }
  return first;
}

/** What one pass of the fold reads: the records, read once, the motions from outside, and what #111 has cleared. */
interface Pass {
  readonly reads: readonly Read[];
  readonly relayNow: number | null;
  readonly outside: readonly Motion[];
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
    founded: [],
    document: { closed: '', atoms: [] },
    proposals: [],
    at: 0,
    stewards: EMPTY_SEATS,
    suspensions: [],
    removals: [],
    responses: [],
    narrowings: [],
    vouches: [],
    chatPosts: [],
    chatThreads: [],
    dispatches: [],
    doorInvites: [],
    epoch: 0,
    rotations: [],
    rotationDue: false,
    seated: new Set(),
    ruled: new Set(),
    judged: new Set(),
    dispatched: new Set(),
    dissolved: null,
    recoveryShares: [],
    recoveryAlerts: [],
    recoveryCancels: [],
    coalition: null,
    cleared: pass.cleared,
    firstResults: pass.firstResults,
    distrusted: pass.distrusted,
  };
  const ignored: IgnoredRecord[] = [];
  const seen = new Set<string>();
  const motions = [...pass.outside].sort((a, b) => a.seq - b.seq);
  for (const read of pass.reads) {
    openMotionsBefore(draft, motions, read.seq);
    if (!foldRecord(draft, read, seen))
      ignored.push({ seq: read.seq, id: read.parsed?.id ?? null });
  }
  openMotionsBefore(draft, motions, Infinity);
  const now = endTime(draft, pass.relayNow);
  draft.at = now ?? draft.at;
  if (draft.coalition !== null) advanceAdmissions(draft, draft.coalition);
  advanceAll(draft);
  const distrusted = draft.proposals
    .filter((p) => p.readAhead !== null && p.result === null)
    .map((p) => p.id);
  const proposals = draft.proposals.map((p) => settle(p, draft, now));
  const atoms = applyPasses(draft.founded, proposals, draft.group);
  const { group, rules, name, chat, title, members, former, at, stewards, suspensions } = draft;
  const { removals, responses, narrowings, vouches, chatPosts, chatThreads } = draft;
  const { dispatches, doorInvites, epoch, rotations, rotationDue } = draft;
  const state = {
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
    removals,
    responses,
    narrowings,
    vouches,
    chatPosts,
    chatThreads,
    dispatches,
    doorInvites,
    epoch,
    rotations,
    rotationDue,
    dissolved: draft.dissolved,
    recoveryShares: draft.recoveryShares,
    recoveryAlerts: draft.recoveryAlerts,
    recoveryCancels: draft.recoveryCancels,
    coalitions: heldSeats(proposals),
    coalition: draft.coalition,
    focus: focusOf(proposals),
    ignored,
  };
  return { state, distrusted };
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
  advanceTo(draft, motion.received, motion.seq);
  const { id, seq, received, coalition, bar, window, deadline } = motion;
  openProposal(draft, {
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

/**
 * Seats each group whose admit motion's pass has become final by `draft.at`
 * (#114), once, in order of when it became final, deadline + 10,080, and
 * then relay order: a later motion's snapshot, and a later join, see it.
 */
function advanceAdmissions(draft: Draft, coalition: CoalitionDraft): void {
  const due = coalition.motions
    .filter((m) => m.admit !== null && draft.at >= settlesAt(m))
    .sort((a, b) => a.deadline - b.deadline);
  for (const motion of due) {
    const proposal = draft.proposals.find((p) => p.id === motion.id);
    if (proposal === undefined) continue;
    // Results on it have stopped counting, so its outcome is final here.
    const settled = settleMotion(proposal, coalition, barOf(proposal, draft.rules), draft.at);
    if (settled.outcome.kind === 'pass') {
      admitSeat(coalition, motion, settlesAt(motion));
    }
  }
}

/**
 * True once the fold, at relay minute `at` and the record with relay seq
 * `seq`, has passed a record's early close (#289): its minute is over, or
 * this is that minute and the record comes after the closing ballot's seq. A
 * record from before #289 names no seq, so its close comes at the start of
 * its minute (#111).
 */
function passedClose(body: ResultBody, at: number, seq: number): boolean {
  if (at > body.closedAt) return true;
  return at === body.closedAt && (body.closedSeq === undefined || seq > body.closedSeq);
}

/**
 * Closes each cleared Proposal whose read-ahead record closed it early, once
 * the fold has passed that close (#111, #289), so a cleared Proposal closes
 * at the same point in relay order as one whose ballots are held: the rules
 * that ask whether it is open ({@link isOpenAt}) find it open before the
 * closing ballot's place and closed from there on. As the closing ballot
 * would, a removal's close then ends the suspension it extended at the later
 * of its own end and that close (ADR-0059, #115).
 */
function closeReadAhead(draft: Draft, seq: number): void {
  for (const proposal of draft.proposals) {
    const body = proposal.readAhead?.body;
    const early = body !== undefined && body.closedAt < proposal.deadline;
    if (proposal.closedAt === null && early && passedClose(body, draft.at, seq)) {
      proposal.closedAt = body.closedAt;
      extendSuspension(draft, proposal, (s) => s.removal === proposal.id);
    }
  }
}

/**
 * Moves relay time on to `received`, never back, at the record with relay
 * seq `seq`, closes each cleared Proposal the fold has passed the early
 * close of (#289), and brings the removals (#115), seats, opt-ins and
 * carried Dispatches (#112) up to it ({@link advanceAll}). A coalition still
 * forming when it reaches its `formsBy` is declined there, and relay time
 * stops at that minute (#100). A coalition seats each group admitted by then
 * (#114).
 */
function advanceTo(draft: Draft, received: number, seq: number): void {
  draft.at = Math.max(draft.at, received);
  if (draft.coalition !== null) {
    expireFormation(draft.coalition, draft.at);
    draft.at = draft.coalition.declinedAt ?? draft.at;
    advanceAdmissions(draft, draft.coalition);
  }
  closeReadAhead(draft, seq);
  advanceAll(draft);
}

/**
 * Folds one record into the draft, returning whether it was applied.
 *
 * A record read from a mailbox of another epoch than the group's now, such as
 * a stale invite's join or a late writer's Proposal after a key change (#98),
 * changes nothing at all: not relay time, and not the event ids seen, so the
 * copy its author posts again to the new mailbox folds once. Otherwise relay
 * time moves on, whatever the record holds, until the group dissolves (#108),
 * and the removals, seats, opt-ins and carried Dispatches catch up to it
 * before the event is checked. A repeated event id is ignored.
 */
function foldRecord(draft: Draft, read: Read, seen: Set<string>): boolean {
  const { seq, received, epoch, parsed } = read;
  if (epoch !== draft.epoch) return false;
  if (!hasEnded(draft)) advanceTo(draft, received, seq);
  if (parsed === null) return false;
  const { event, id } = parsed;
  const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
  seen.add(id);
  // A coalition has no group key, so a leave there ends only that participant (#100).
  if (applied && endsMembership(event) && draft.coalition === null) draft.rotationDue = true;
  return applied;
}
