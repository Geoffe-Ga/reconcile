/**
 * The group fold (docs/spec/phase-1-spec.md §4): a mailbox's records, in relay
 * order, become one `GroupState`.
 *
 * Every rule is checked against the state before the event. An event that
 * breaks one lands in `ignored` and changes nothing. Votes run on relay time
 * (`received`, in whole minutes); the author's `ts` plays no part. Genesis
 * founds the group with its rules and its Documents (#92), and each
 * Proposal's class, set when it opens, picks its bar and bounds the window its
 * proposer chose. A Document changes only when a Proposal's pass is final: an
 * edit sets an Atom's text or, with `""`, removes it, an add puts a new Atom
 * after its anchor in the Document it names (#75), a move takes an Atom out
 * and puts it after another in its Document (#103), a class Proposal sets an
 * Atom's class (#116), and a new Document joins after every other (#92).
 * Every Atom starts ordinary. An entrenched one needs the entrenched bar and
 * window to change, move or remove, and the fold ignores any Proposal that
 * would change, move, remove or reclass an eternal one. Final passes apply
 * in order of close time, then the Proposals' relay order. Steward seats
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
 * closing where the result says its closing ballot came (#289). A membership
 * that ends in a group closes its front door at that record, and no door
 * whose secrets someone who has left could read opens again (#288). The fold
 * is pure: no I/O, no clock, no randomness, so every device that folds the
 * same records builds the same state.
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
  type ReconcileChange,
  admitSeat,
  mayAdmit,
  mayReconcile,
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
import { documentOf, documentSections, documentTitleFits, type GroupDocument } from './documents';
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
  type FoundingDocument,
  fromBase64url,
  type GenesisBody,
  type GroupEvent,
  type GroupResultBody,
  type GroupResultValue,
  type InviteToken,
  type AddProposalBody,
  type ClassProposalBody,
  isAddProposal,
  isClassProposal,
  isCoalitionGenesis,
  isMoveProposal,
  isDissolveProposal,
  isAdmitProposal,
  isSealedReconcileProposal,
  isNewDocumentProposal,
  isPriorityProposal,
  isReconcileProposal,
  isRemovalProposal,
  isRulesProposal,
  type KeyCheckBody,
  type KeyRotateBody,
  type KxBody,
  isStewardProposal,
  type LevelBody,
  type MoveProposalBody,
  type NarrowBody,
  type NewDocumentProposalBody,
  type ParsedEvent,
  parseRecord,
  type PriorityProposalBody,
  type ProposalBody,
  type ProposalEventBody,
  type AdmitProposalBody,
  type SealedReconcileProposalBody,
  type SealedReconcileTarget,
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
import { isRefused, type KeyChecks, keyChecksOf } from './keyChecks';
import { isOpenAt } from './open';
import {
  type DoorClosure,
  doorIn,
  effectiveOptIns,
  type FrontDoor,
  isFrontDoor,
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
  type AtomClass,
  type Bar,
  type ClassChange,
  classChangeIsValid,
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
 * A key change (#98): a valid `key-rotate`, where it sits in relay order, who
 * wrote it, its epoch, its commit, its wraps by member key, and `keys`, the
 * encryption key the group held for each recipient then, which a device checks
 * every wrap against (#224). A canonical one, the first valid `key-rotate` of
 * its epoch that isn't refused, moves the group: records read from the epoch
 * before it, from its seq on, are ignored. A refused one (`keyChecks.ts`)
 * moves nothing.
 */
export interface Rotation {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly epoch: number;
  readonly commit: string;
  readonly wraps: Readonly<Record<string, string>>;
  readonly keys: Readonly<Record<string, string>>;
}

/**
 * A leave stranded in an earlier epoch's mailbox (#225): a `leave` read from
 * there after the key change out of that epoch, as a device that hadn't heard
 * of the key change posts one, from someone who is still a member. It ends no
 * membership where it sits, as no record of another epoch's mailbox changes
 * anything (#98), since a device that took up the key change before it landed
 * never reads it. A device that holds it posts it again to the current
 * epoch's mailbox (`store/epochs.ts`), where every device reads it, and the
 * membership ends there.
 */
export interface StrandedLeave {
  readonly id: string;
  readonly seq: number;
  readonly author: string;
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
 * A unit of a Document (#92). Founding Document `k`'s Atom `i` has the id
 * `${genesisId}.${i}` for the first Document and `${genesisId}:${k}.${i}` for
 * the others, and a new Document's Atom `i` is `${proposalId}.${i}`. An added
 * Atom has its add Proposal's id (#75). `documentId` is its Document's id.
 * `class` is ordinary when it's founded, added or created with a new
 * Document, and only a class Proposal's pass changes it (#116).
 */
export interface Atom {
  readonly id: string;
  readonly documentId: string;
  readonly text: string;
  readonly class: AtomClass;
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
 * after its anchor; a new Document (#92), whose `atom` is its own id too, the
 * Document it would create, so its versions gather under it as an add's do;
 * a move of `atom` (#103), whose `text` is `""` and whose one version, under
 * its own id, has no text, so it holds its section's slot as an edit does;
 * a class Proposal on `atom` (#116), which holds its slot the same way;
 * a steward change (#102); a rules change to an opt-in (#117); or dissolving
 * the group (#108). A steward, rules or dissolve
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
 * Where a group's Documents began (#104): the genesis's receipt, in relay
 * minutes, its author, and every Atom it founded, Document by Document, with
 * its founding text, whatever passes have changed since. `author` is null for
 * a coalition, whose genesis author isn't one of its participants (#100).
 */
export interface Founding {
  readonly received: number;
  readonly author: string | null;
  readonly atoms: readonly Atom[];
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
 * order (#101), visible to members like ballots (ADR-0010). `documents` are
 * the group's Documents in order (#92): those genesis founded, then each new
 * Document whose pass is final, in pass order; `atoms` holds every Document's
 * Atoms, Document by Document, each in its order. `chatPosts` holds
 * the chat bot's winning claims, the first valid `chat-posted` per (Proposal,
 * moment), in relay order (#119), and `chatThreads` each Proposal's Discord
 * thread, the first valid `chat-thread` for it, in relay order (#123).
 * `dispatches` holds the group's Dispatches in the order they went out
 * (#112): each valid `dispatch` at its receipt, and each passed Proposal's at
 * its close, in close order, ahead of any record received from that minute
 * on. `doorInvites` holds each invite a member sent from the front door, the
 * first valid `door-invited` per application, in relay order (#121).
 * `doorClosure` is the `leave` or `remove` that closed the front door, while
 * it stays closed, and `exposedDoors` the front door Proposals that were open
 * when a membership ended, whose pass opens no door (#288). `epoch` is the
 * group key's epoch: 0 at genesis, then the epoch of each canonical key
 * change, which `rotations` keeps in order (#98). `nextEpoch` is the epoch
 * the next key change must name: one past the last key change's, canonical or
 * refused, so a refused key change spends its epoch (#224). `refused` keeps
 * the key changes a recipient said don't open, in relay order (`keyChecks.ts`,
 * #224): none moved the group, and none of their authors may write another.
 * `rotationDue` is true once a membership has ended since the last canonical
 * key change, or genesis, until the next, or until the group dissolves, after
 * which no key change can land. `strandedLeaves` lists, in relay order, the
 * leaves this device read stranded in an earlier epoch's mailbox whose
 * authors are still members (#225): like `ignored`, it is what this device
 * read, not something every device folds alike. `dissolved` is when the
 * group dissolved, and whether its
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
 * focus, or null before any priority vote passes (#107). `founding` is where
 * the Documents began, the founding text a section's history starts from, or
 * null before a genesis (#104).
 */
export interface GroupState {
  readonly group: string | null;
  readonly rules: Rules;
  readonly optIns: OptIns;
  readonly name: string;
  readonly chat: string | null;
  readonly documents: readonly GroupDocument[];
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
  readonly doorClosure: DoorClosure | null;
  readonly exposedDoors: readonly string[];
  readonly epoch: number;
  readonly nextEpoch: number;
  readonly rotations: readonly Rotation[];
  readonly refused: readonly Rotation[];
  readonly rotationDue: boolean;
  readonly strandedLeaves: readonly StrandedLeave[];
  readonly dissolved: Dissolution | null;
  readonly recoveryShares: readonly SealedShare[];
  readonly recoveryAlerts: readonly SealedAlert[];
  readonly recoveryCancels: readonly RecoveryCancel[];
  readonly coalitions: readonly HeldSeat[];
  readonly coalition: Coalition | null;
  readonly focus: Focus | null;
  readonly founding: Founding | null;
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

/** A Document while the fold works it out (#92): its id, its title and its Atoms, in order. */
interface DocumentDraft extends GroupDocument {
  readonly atoms: readonly Atom[];
}

/** The Documents at some relay minute, and the closed Proposals they were worked out from. */
interface DocumentAt {
  /** The closed Proposals' ids, in relay order, joined by spaces. */
  readonly closed: string;
  readonly documents: readonly DocumentDraft[];
}

/**
 * The state the fold builds up, one event at a time. `seated` holds the ids
 * of the closed steward Proposals whose outcome the seats already show,
 * `ruled` those of the closed rules Proposals the opt-ins already show, and
 * `judged` those of the closed removals `removals` already shows (#115), and
 * `dispatched` those of the closed Proposals carrying a Dispatch that
 * `dispatches` already reflects (#112). `founded` holds the Documents
 * genesis founded, before any pass (#92), `founding` where they began
 * (#104), and `document` the Documents as the latest Proposal found them,
 * kept until another closes. `exposed` holds every front door secret, `sign`
 * and `box`, that someone who has left could read, and `carried` those the
 * records of this epoch carried since the last membership end, which the
 * next one exposes (#288).
 */
interface Draft {
  group: string | null;
  rules: Rules;
  name: string;
  chat: string | null;
  readonly members: Member[];
  readonly former: Member[];
  founded: readonly DocumentDraft[];
  founding: Founding | null;
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
  doorClosure: DoorClosure | null;
  readonly exposedDoors: string[];
  readonly exposed: Set<string>;
  readonly carried: Set<string>;
  epoch: number;
  nextEpoch: number;
  readonly rotations: Rotation[];
  readonly refused: Rotation[];
  rotationDue: boolean;
  /** The leaves read stranded in an earlier epoch's mailbox (#225), each once, members' or not by now. */
  readonly stranded: StrandedLeave[];
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
  /** Every `unwrap-failed` and `key-taken` in the log, read before the fold starts (#224). */
  readonly keyChecks: KeyChecks;
}

/** `kx` when it is a key a box can be sealed to (`crypto/box.ts`), else null (#98). */
function usableKx(kx: string | undefined): string | null {
  return kx !== undefined && isUsableKxKey(fromBase64url(kx)) ? kx : null;
}

/**
 * Founds a coalition (#100), unless its rules differ from the defaults, its
 * seats aren't two or more distinct keys, or it founds anything but one
 * valid Document, its statement (#92). Its author isn't a participant: they
 * join under a seat like anyone else, so it has no members and no steward yet.
 */
function applyCoalitionGenesis(draft: Draft, body: CoalitionGenesisBody, at: Receipt): boolean {
  const rules = foundingRules(body.rules);
  const documents = body.documents.length === 1 ? foundedDocuments(body.documents, at.id) : null;
  const coalition = rules === null ? null : newCoalition(body, rules, at.received);
  if (rules === null || coalition === null || documents === null) return false;
  draft.group = at.id;
  draft.rules = rules;
  draft.name = body.name;
  draft.chat = body.chat ?? null;
  found(draft, documents, at.received, null);
  draft.coalition = coalition;
  return true;
}

/**
 * Keeps the Documents a genesis founds, received at `received` and written by
 * `author`, or null for a coalition's (#104), as the founding text and as the
 * Documents every later event first finds.
 */
function found(
  draft: Draft,
  documents: readonly DocumentDraft[],
  received: number,
  author: string | null,
): void {
  draft.founded = documents;
  draft.founding = { received, author, atoms: documents.flatMap((d) => d.atoms) };
  draft.document = { closed: '', documents };
}

/** A Document's Atoms from their texts, `${documentId}.${i}`, in order, each ordinary (#116). */
function sectionsOf(texts: readonly string[], documentId: string): Atom[] {
  return texts.map((text, i) => ({
    id: `${documentId}.${String(i)}`,
    documentId,
    text,
    class: 'ordinary',
  }));
}

/**
 * The Documents a genesis founds (#92): the first under the genesis id, and
 * Document `k` ≥ 1 under `${genesisId}:${k}`, each with its Atoms. Null when
 * there are none, or any title doesn't fit or any Document has no Atom, which
 * makes the genesis invalid.
 */
function foundedDocuments(
  documents: readonly FoundingDocument[],
  genesisId: string,
): DocumentDraft[] | null {
  const valid = documents.every((d) => documentTitleFits(d.title) && d.atoms.length > 0);
  if (documents.length === 0 || !valid) return null;
  return documents.map(({ title, atoms }, k) => {
    const id = k === 0 ? genesisId : `${genesisId}:${String(k)}`;
    return { id, title, atoms: sectionsOf(atoms, id) };
  });
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

/**
 * Founds the group, unless its rules differ from the defaults (rules.ts) or
 * its Documents aren't valid (#92).
 */
function applyGenesis(draft: Draft, body: GenesisBody, author: string, at: Receipt): boolean {
  const rules = foundingRules(body.rules);
  const documents = foundedDocuments(body.documents, at.id);
  if (rules === null || documents === null) return false;
  draft.group = at.id;
  draft.rules = rules;
  draft.name = body.name;
  draft.chat = body.chat ?? null;
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
  found(draft, documents, at.received, author);
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
 * The Documents as an event received at relay minute `received` finds them:
 * the founded ones with every pass that is final by then applied, in pass
 * order (#75, #92). In a group they're worked out again only when the set of
 * closed Proposals changes. A coalition's are worked out every time: a closed
 * motion's results can still be contested, and its pass turns final only
 * once results stop counting, so its outcome moves while that set holds still
 * (#100).
 */
function documentsAt(draft: Draft, received: number): readonly DocumentDraft[] {
  const closed = draft.proposals.filter((p) => !isOpenAt(p, received));
  const key = closed.map((p) => p.id).join(' ');
  if (key !== draft.document.closed || draft.coalition !== null) {
    const settled = closed.map((p) => settle(p, draft, received));
    draft.document = { closed: key, documents: applyPasses(draft.founded, settled) };
  }
  return draft.document.documents;
}

/** Every Atom of every Document an event received at `received` finds, Document by Document. */
function atomsAt(draft: Draft, received: number): readonly Atom[] {
  return documentsAt(draft, received).flatMap((document) => document.atoms);
}

/**
 * True when the Atom `id` is in a Document an event received at `received`
 * finds, and isn't eternal: no vote changes or removes an eternal Atom (#116).
 */
function mayChange(draft: Draft, id: string, received: number): boolean {
  return atomsAt(draft, received).some((a) => a.id === id && a.class !== 'eternal');
}

/**
 * The class a Proposal received at `received` opens at (`targetClass`), from
 * the group's rules and the Atoms it finds, with their classes (#116).
 */
function classAt(draft: Draft, body: ProposalEventBody, received: number): ProposalClass {
  return targetClass({ rules: draft.rules, atoms: atomsAt(draft, received) }, body);
}

function proposalIsValid(draft: Draft, body: ProposalBody, author: string, at: Receipt): boolean {
  return (
    can(draft, author, 'propose') &&
    mayChange(draft, body.atom, at.received) &&
    optionFor(openOn(draft, body.atom, at.received)) === 'propose' &&
    fieldsAreValid(body)
  );
}

/**
 * Whether an add's spot is in a Document the add finds (#92): the Document it
 * names is the group's, and its anchor, unless null for the start, is in
 * that Document, not another.
 */
function anchorIsValid(draft: Draft, body: AddProposalBody, received: number): boolean {
  const { document, after } = body.target;
  const named = documentsAt(draft, received).find((d) => d.id === document);
  return named !== undefined && (after === null || named.atoms.some((a) => a.id === after));
}

/**
 * An add's anchor is in the Document it names, or null for that Document's
 * start, and its text isn't empty: only an edit can carry `""`, which removes
 * its Atom (#75, #92).
 */
function addIsValid(draft: Draft, body: AddProposalBody, author: string, at: Receipt): boolean {
  return (
    can(draft, author, 'propose') &&
    body.text !== '' &&
    anchorIsValid(draft, body, at.received) &&
    fieldsAreValid(body)
  );
}

/**
 * Whether a move's spot is in a Document the move finds (#103): its Atom is
 * in one, and isn't eternal (#116), and its anchor, unless null for the
 * start, is another Atom of that same Document, never the Atom itself. An
 * eternal anchor is fine: the eternal section stays where it is.
 */
function moveSpotIsValid(draft: Draft, body: MoveProposalBody, received: number): boolean {
  const { atom, after } = body.target;
  const document = documentsAt(draft, received).find((d) =>
    d.atoms.some((a) => a.id === atom && a.class !== 'eternal'),
  );
  if (document === undefined) return false;
  return after === null || (after !== atom && document.atoms.some((a) => a.id === after));
}

/**
 * A move (#103) needs an author who may propose, a section with no open
 * Proposal, since a move holds its section's slot as an edit does (ADR-0073),
 * and a spot in that section's Document.
 */
function moveIsValid(draft: Draft, body: MoveProposalBody, author: string, at: Receipt): boolean {
  return (
    can(draft, author, 'propose') &&
    moveSpotIsValid(draft, body, at.received) &&
    optionFor(openOn(draft, body.target.atom, at.received)) === 'propose' &&
    fieldsAreValid(body)
  );
}

/**
 * The class change a class Proposal makes (#116), or null when the fold
 * ignores it: its author may propose, its Atom is in a Document it finds,
 * `classChangeIsValid` allows the Atom's class now to go to `to`, so never
 * the class it has and never from eternal, the Atom has no open Proposal,
 * since a class Proposal holds its slot as an edit does (ADR-0073), and its
 * fields are valid.
 */
function classChangeFor(
  draft: Draft,
  body: ClassProposalBody,
  author: string,
  at: Receipt,
): ClassChange | null {
  const { atom, to } = body.target;
  const section = atomsAt(draft, at.received).find((a) => a.id === atom);
  if (section === undefined || !classChangeIsValid(section.class, to)) return null;
  const valid =
    can(draft, author, 'propose') &&
    optionFor(openOn(draft, atom, at.received)) === 'propose' &&
    fieldsAreValid(body);
  return valid ? { kind: 'class', atom, to } : null;
}

/**
 * A new Document (#92) needs an author who may propose, a title that fits,
 * and text that splits into at least one section. It names no Atom, so no
 * other Proposal can be open on it.
 */
function newDocumentIsValid(draft: Draft, body: NewDocumentProposalBody, author: string): boolean {
  return (
    can(draft, author, 'propose') &&
    documentTitleFits(body.target.title) &&
    documentSections(body.text).length > 0 &&
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
  const cls = classAt(draft, body, at.received);
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
 * Opens an add (#75) or a new Document (#92), once its own rules hold: on a
 * pass, an add's Atom takes the Proposal's own id, and so does a new
 * Document. Like an edit, it runs the window its proposer chose within its
 * class's bounds, or the class default, and one outside them is ignored (#106).
 */
function openWithText(
  draft: Draft,
  body: AddProposalBody | NewDocumentProposalBody,
  author: string,
  at: Receipt,
): boolean {
  const cls = classAt(draft, body, at.received);
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

/** Opens an add (#75) whose spot is in the Document it names (#92). */
function applyAdd(draft: Draft, body: AddProposalBody, author: string, at: Receipt): boolean {
  return addIsValid(draft, body, author, at) && openWithText(draft, body, author, at);
}

/**
 * Opens a move (#103) on its section, so no other Proposal opens there while
 * it runs. It has no text: its one version, under its own id, is the move
 * itself, and it takes no others. Like an edit, it runs the window its
 * proposer chose within its class's bounds, or the class default (#106).
 */
function applyMove(draft: Draft, body: MoveProposalBody, author: string, at: Receipt): boolean {
  if (!moveIsValid(draft, body, author, at)) return false;
  const cls = classAt(draft, body, at.received);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: body.target.atom,
    target: body.target,
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/**
 * Opens a class Proposal (#116) on its section, so no other Proposal opens
 * there while it runs. It is entrenched, whatever class it asks for, so
 * entrenchment is itself entrenched (ADR-0015 §2), and it runs the window its
 * proposer chose within the entrenched bounds, or their default (#106). It
 * has no text: its one version, under its own id, is the change itself, and
 * it takes no others.
 */
function applyClass(draft: Draft, body: ClassProposalBody, author: string, at: Receipt): boolean {
  const target = classChangeFor(draft, body, author, at);
  if (target === null) return false;
  const cls = classAt(draft, body, at.received);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return false;
  openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: target.atom,
    target,
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
  return true;
}

/** Opens a new Document (#92), whose id, on a pass, is the Proposal's own. */
function applyNewDocument(
  draft: Draft,
  body: NewDocumentProposalBody,
  author: string,
  at: Receipt,
): boolean {
  return newDocumentIsValid(draft, body, author) && openWithText(draft, body, author, at);
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
  const cls = classAt(draft, body, at.received);
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
 * Proposal, its one version has no text. A front door it carries must be
 * fresh ({@link doorIsFresh}, #288).
 */
function applyRules(draft: Draft, body: RulesProposalBody, author: string, at: Receipt): boolean {
  if (!fieldsAreValid(body) || !mayProposeRules(draft, author, body.target)) return false;
  const target = rulesChange(draft.rules.optIns, body.target.optIn, body.target.value);
  if (target === null || !doorIsFresh(draft, doorIn(target))) return false;
  const cls = classAt(draft, body, at.received);
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

/**
 * Whether a front door a rules Proposal carries may stand (#288): nobody who
 * has left could read either of its secrets ({@link noteDoor}). A change that
 * carries no door passes.
 */
function doorIsFresh(draft: Draft, door: FrontDoor | null): boolean {
  return door === null || (!draft.exposed.has(door.sign) && !draft.exposed.has(door.box));
}

/** The front door a record's rules Proposal carries, whether the fold applies it or not, or null. */
function doorCarried(parsed: ParsedEvent | null): FrontDoor | null {
  const event = parsed?.event;
  if (event?.type !== 'proposal' || !isRulesProposal(event.body)) return null;
  const { optIn, value } = event.body.target;
  return optIn === 'frontDoor' && isFrontDoor(value) ? value : null;
}

/**
 * Notes the secrets of a front door a record carries before it folds (#288),
 * whether the fold then applies it or not: anyone who holds the key it was
 * sealed under can read them. A record read from an earlier epoch's mailbox
 * after the key changed (#98), such as a late writer's, or one read while a
 * key change is due, was sealed under a key someone who has left still
 * holds, so its secrets are exposed at once, and neither it nor the copy its
 * author's device posts again to the new mailbox opens a door. Any other
 * record's are carried until the next membership end exposes them. One from
 * a later epoch, read before that epoch began, was sealed under a key no one
 * who has left holds.
 */
function noteDoor(draft: Draft, { epoch, parsed }: Read): void {
  const door = doorCarried(parsed);
  if (door === null || epoch > draft.epoch) return;
  const into = epoch < draft.epoch || draft.rotationDue ? draft.exposed : draft.carried;
  into.add(door.sign).add(door.box);
}

/**
 * A membership has ended in a group (#98, #288): the key change becomes due,
 * and whoever left keeps every front door secret the log has carried. So each
 * is exposed, each front door Proposal still open is listed in
 * `exposedDoors`, whose pass then opens nothing, and a door that stands
 * closes here, on every device, at this record. Only a new opening Proposal,
 * made once the key has changed and carrying fresh secrets, opens it again.
 */
function endMembership(draft: Draft, at: Receipt): void {
  draft.rotationDue = true;
  for (const secret of draft.carried) draft.exposed.add(secret);
  draft.carried.clear();
  for (const proposal of draft.proposals) {
    const listed = draft.exposedDoors.includes(proposal.id);
    const door = doorIn(rulesChangeOf(proposal));
    if (door !== null && !listed && isOpenAt(proposal, at.received)) {
      draft.exposedDoors.push(proposal.id);
    }
  }
  if (draft.rules.optIns.frontDoor === false) return;
  draft.rules = { ...draft.rules, optIns: { ...draft.rules.optIns, frontDoor: false } };
  draft.doorClosure = { id: at.id, seq: at.seq, received: at.received };
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
  const cls = classAt(draft, body, at.received);
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
  const cls = classAt(draft, body, at.received);
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

/** Whether a reconcile Proposal here already holds the seat key `key`: each seat is one Proposal's. */
function holdsSeatKey(draft: Pick<Draft, 'proposals'>, key: string): boolean {
  return draft.proposals.some((p) => p.target.kind === 'reconcile' && p.target.key === key);
}

/** This coalition's own seat keys in coalitions above it: each of its reconcile motions' (#122). */
function seatKeysAbove(draft: Pick<Draft, 'proposals'>): string[] {
  return draft.proposals.flatMap((p) => (p.target.kind === 'reconcile' ? [p.target.key] : []));
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
  const cls = classAt(draft, body, at.received);
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
 * Opens a reconcile Proposal, a group's (#100) or a coalition's (#122), when
 * its author may propose: ordinary, for the window its proposer chose or the
 * default, with one version that has no text, keeping `target`. A seat key
 * another reconcile Proposal here already holds is ignored, so each seat is
 * one Proposal's.
 */
function openReconcile(
  draft: Draft,
  body: ReconcileProposalBody | SealedReconcileProposalBody,
  author: string,
  at: Receipt,
  target: ReconcileChange | SealedReconcileTarget,
): OpenProposal | null {
  if (!fieldsAreValid(body) || !can(draft, author, 'propose')) return null;
  if (holdsSeatKey(draft, target.key)) return null;
  const cls = classAt(draft, body, at.received);
  const window = chosenWindow(draft.rules, cls, body.window);
  if (window === null) return null;
  return openProposal(draft, {
    ...opening(draft, body, author, at, { cls, window }),
    atom: '',
    target,
    text: '',
    eligible: eligibleNow(draft, null),
    versions: [{ id: at.id, author, text: '' }],
  });
}

/**
 * Opens a group's reconcile Proposal (#100; ADR-0036). The fold keeps its
 * target as written, secrets included, with the public seat key its seat
 * secret makes.
 */
function applyReconcile(
  draft: Draft,
  body: ReconcileProposalBody,
  author: string,
  at: Receipt,
): boolean {
  const key = seatKeyFor(body.target);
  return openReconcile(draft, body, author, at, { ...body.target, key }) !== null;
}

/**
 * Opens a coalition's motion to take a seat in a coalition above it (#122):
 * its sealed reconcile target, as written, which holds no readable secret.
 * Its seats decide it as any motion, from a snapshot at receipt. It is
 * ignored when it carries a Dispatch, as an admit is (#124), when one more
 * level would put the coalition above it past level 3, or when its key is one
 * of this coalition's own seats, whose secret a member group holds and could
 * act on above without the coalition.
 */
function applySealedReconcile(
  draft: Draft,
  coalition: CoalitionDraft,
  body: SealedReconcileProposalBody,
  author: string,
  at: Receipt,
): boolean {
  // Taking a seat above sends no Dispatch, as admitting a group sends none (#124).
  if (body.dispatch !== undefined || !mayReconcile(coalition, body.target.key)) return false;
  const motion = openReconcile(draft, body, author, at, body.target);
  if (motion === null) return false;
  const seats = coalition.seats.map((s) => s.key);
  coalition.motions.push({ id: motion.id, deadline: motion.deadline, seats, admit: null });
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
 * admitting a group (#114, {@link applyAdmit}), or taking a seat above (#122,
 * {@link applySealedReconcile}), with the seats it holds now as the snapshot
 * that decides it. Every other target waits: a steward, rules or dissolve
 * change would take effect in the fold while a pass can still be contested,
 * and a reconcile target carrying its secrets readable, as a group's does,
 * would show them to the coalition's followers. An edit may carry a Dispatch
 * for the coalition's readers (#124), which goes out only once its pass is
 * final ({@link advanceMotionDispatches}); an admit or a seat above carries
 * none. An add (#75) has a target, so it waits too, and so does a removal,
 * an edit whose text is `""`: for now a motion only rewords one of the
 * coalition's Atoms. A priority vote (#107) has a target too, so a coalition
 * asks none, and so does a class Proposal (#116): a coalition's sections stay
 * ordinary.
 */
function applyMotion(
  draft: Draft,
  coalition: CoalitionDraft,
  body: ProposalEventBody,
  author: string,
  at: Receipt,
): boolean {
  if (coalition.status !== 'formed') return false;
  if (isSealedReconcileProposal(body)) {
    return applySealedReconcile(draft, coalition, body, author, at);
  }
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
 * room's `inner` to reach the group once it's admitted (#313). A coalition
 * asking in states its level and member groups (#122); a level that would put
 * this coalition past level 3, or this coalition's own seat key above, is
 * ignored. It is ordinary, for the window its proposer chose or the default,
 * with one version that has no text, and every seat in its snapshot must pass
 * it, whatever their number. Once its pass is final, the group takes its seat
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
  if (!mayAdmit(coalition, draft.group, author, body.target, seatKeysAbove(draft))) return false;
  const window = chosenWindow(draft.rules, 'ordinary', body.window);
  if (window === null) return false;
  const proposal = openProposal(draft, {
    ...opening(draft, body, author, at, { cls: 'ordinary', window }),
    atom: '',
    target: { kind: 'admit', seat: body.target.seat, groups: body.target.groups ?? [] },
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

/**
 * Whether a Proposal's body is only ever a coalition's motion: admitting a
 * group (#114), or a sealed reconcile target (#122), since a group has no
 * inner to seal under. A group's own log takes neither.
 */
function isCoalitionOnly(
  body: ProposalEventBody,
): body is AdmitProposalBody | SealedReconcileProposalBody {
  return isAdmitProposal(body) || isSealedReconcileProposal(body);
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
  if (isCoalitionOnly(body)) return false;
  return applyDocumentChange(draft, body, author, at);
}

/**
 * Opens a group's Proposal that changes its Documents: a new Document (#92),
 * a move (#103), a class change (#116), an add (#75) or an edit of one Atom,
 * its removal included.
 */
function applyDocumentChange(
  draft: Draft,
  body:
    ProposalBody | AddProposalBody | NewDocumentProposalBody | MoveProposalBody | ClassProposalBody,
  author: string,
  at: Receipt,
): boolean {
  if (isNewDocumentProposal(body)) return applyNewDocument(draft, body, author, at);
  if (isMoveProposal(body)) return applyMove(draft, body, author, at);
  if (isClassProposal(body)) return applyClass(draft, body, author, at);
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
 * an add's needs text (#75), and a new Document's text that splits into at
 * least one section (#92).
 */
function versionTextFits(proposal: OpenProposal, text: string): boolean {
  const { kind } = proposal.target;
  if (kind === 'new-document') return documentSections(text).length > 0;
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
 * send it now and it fits (dispatches.ts). Any `doc` must name one of the
 * group's Documents as the Dispatch finds them, after every pass final by
 * then (#75, #92), even one whose sections were all removed. A Dispatch with
 * no `doc` points to no Document.
 */
function applyDispatch(draft: Draft, body: DispatchBody, author: string, at: Receipt): boolean {
  const state = { ...draft, documents: documentsAt(draft, at.received) };
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
 * the recovery events, which govern nothing: a recovery share (#109), and a
 * recovery alert or cancel (#118); and an `unwrap-failed` or `key-taken`
 * (#224).
 */
const UNSUSPENDED: ReadonlySet<GroupEvent['type']> = new Set([
  'removal-response',
  'recovery-share',
  'recovery-alert',
  'recovery-cancel',
  'unwrap-failed',
  'key-taken',
]);

/**
 * Whether the author of `event` may act now: anyone may leave, since exit is
 * always possible (ADR-0010, #77); once a removal of them has passed, nothing
 * else counts (#115); and while a suspension runs (ADR-0016), only their
 * response to a removal of them (ADR-0049), their recovery events, which
 * govern nothing: a `recovery-share` (#109), and a `recovery-alert` or
 * `recovery-cancel` (#118), since a suspended person must still hear of a
 * recovery and be able to stop it, and a suspended contact's alert must still
 * reach them; and their `unwrap-failed` and `key-taken`, since a suspended
 * member keeps their wrap and a suspension takes no one's key (#224), do.
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
      | 'unwrap-failed'
      | 'key-taken'
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
 * {@link applyLater} for `kx` and `key-rotate` (#98), `unwrap-failed` and
 * `key-taken` (#224), `group-result` (#100) and `door-invited` (#121), and the
 * events that act on a Proposal ({@link applyProposalEvent}).
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
    case 'unwrap-failed':
      return names(draft.refused, event.body, event.author);
    case 'key-taken':
      return names(draft.rotations.slice(-1), event.body, event.author);
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
 * Whether `author` may write a key change now: one is due, they are a current
 * member, and no key change of theirs was refused (#224), so whoever posts
 * one that doesn't open does it once.
 */
function mayRotate(draft: Draft, author: string): boolean {
  if (!draft.rotationDue || draft.refused.some((rotation) => rotation.by === author)) return false;
  return draft.members.some((m) => m.author === author);
}

/**
 * Changes the group key (#98; ADR-0072 item 11), when {@link mayRotate}
 * allows its author, it names the next epoch, and its wraps name exactly the
 * current members with an encryption key. The first valid one per epoch is
 * canonical (relay order decides, ADR-0073); from it on, records read from the
 * old epoch's mailbox change nothing. Unless it is refused (#224,
 * `keyChecks.ts`): then it moves nothing, its epoch is spent, so the next
 * names the one after, and the key change stays due.
 */
function applyKeyRotate(draft: Draft, body: KeyRotateBody, author: string, at: Receipt): boolean {
  const recipients = keyHolders(draft);
  const { epoch, commit, wraps } = body;
  const named = recipients.map((m) => m.author);
  if (!mayRotate(draft, author) || epoch !== draft.nextEpoch || !wrapsExactly(wraps, named)) {
    return false;
  }
  const keys = Object.fromEntries(recipients.map((m) => [m.author, m.kx]));
  const rotation = { ...at, by: author, epoch, commit, wraps, keys };
  draft.nextEpoch = epoch + 1;
  const group = draft.group ?? '';
  const ousted = draft.removals.map((removal) => removal.member);
  if (isRefused(draft.keyChecks, { ...at, group, from: draft.epoch, to: epoch, wraps, ousted })) {
    draft.refused.push(rotation);
    return true;
  }
  draft.rotations.push(rotation);
  draft.epoch = epoch;
  draft.rotationDue = false;
  return true;
}

/**
 * Whether an `unwrap-failed` or a `key-taken` counts where it sits (#224): it
 * names one of `rotations`, and its author is among that key change's
 * recipients. An `unwrap-failed` counts against a refused key change, read
 * from the old epoch's mailbox; a `key-taken` for the canonical one, read from
 * its own. The fold reads both ahead (`keyChecks.ts`), so this decides only
 * whether one shows in `ignored`.
 */
function names(rotations: readonly Rotation[], body: KeyCheckBody, author: string): boolean {
  return rotations.some((r) => r.id === body.rotation && Object.hasOwn(r.wraps, author));
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
 * time and then relay order, except one a membership end exposed while it was
 * open, which opens no door (#288). A door that opens ends any closure by a
 * membership end. A narrowing needs nothing here: it ends when its
 * off-Proposal closes. Runs before each event, beside {@link advanceSeats}.
 */
function advanceOptIns(draft: Draft): void {
  const rules = (proposal: OpenProposal) => proposal.target.kind === 'rules';
  for (const { proposal, passed } of newlyClosed(draft, draft.ruled, rules)) {
    const change = rulesChangeOf(proposal);
    if (change === null || !passed || draft.exposedDoors.includes(proposal.id)) continue;
    draft.rules = { ...draft.rules, optIns: withChange(draft.rules.optIns, change) };
    if (doorIn(change) !== null) draft.doorClosure = null;
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
 * A move's Atoms after its pass (#103): the Atom `atom` taken out of its place
 * and put right after `after`, first for null, or last once `after` is gone.
 * A Document that doesn't hold the Atom stays as it was.
 */
function moved(atoms: readonly Atom[], atom: string, after: string | null): readonly Atom[] {
  const section = atoms.find((a) => a.id === atom);
  if (section === undefined) return atoms;
  return insertAfter(
    atoms.filter((a) => a.id !== atom),
    after,
    section,
  );
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

/** An edit's Atoms after its pass: its Atom's text set to `text`, or the Atom gone for `""`. */
function edited(atoms: readonly Atom[], atom: string, text: string): readonly Atom[] {
  if (text === '') return atoms.filter((a) => a.id !== atom);
  return atoms.map((a) => (a.id === atom ? { ...a, text } : a));
}

/** A class Proposal's Atoms after its pass (#116): its Atom's class set to `to`. */
function classed(atoms: readonly Atom[], atom: string, to: AtomClass): readonly Atom[] {
  return atoms.map((a) => (a.id === atom ? { ...a, class: to } : a));
}

/** A new Document as its pass makes it (#92): its Proposal's id, title and winning text's sections. */
function newDocument(id: string, title: string, text: string): DocumentDraft {
  return { id, title, atoms: sectionsOf(documentSections(text), id) };
}

/**
 * The Documents after one Proposal's pass, or as they were when it hasn't
 * passed or changes no Atom (a steward, rules or priority Proposal, #102,
 * #117, #107): an
 * edit sets its Atom's text or, with `""`, removes it; an add puts its Atom
 * after its anchor in the Document it names, or last there once the anchor
 * is gone (#75), as an ordinary Atom; a move puts its Atom after its anchor
 * the same way, in its own Document (#103); a class Proposal sets its Atom's
 * class (#116); and a new Document joins after every other (#92). An edit
 * keeps its Atom's class. Atom ids are unique across Documents, so an edit, a
 * move or a class change touches only its own Atom's Document.
 */
function applyPass(
  documents: readonly DocumentDraft[],
  proposal: Proposal,
): readonly DocumentDraft[] {
  const text = passedText(proposal);
  const { target } = proposal;
  if (text === null) return documents;
  if (target.kind === 'new-document') {
    return [...documents, newDocument(proposal.id, target.title, text)];
  }
  if (target.kind === 'add') {
    return documents.map((d) =>
      d.id === target.document
        ? {
            ...d,
            atoms: insertAfter(d.atoms, target.after, {
              id: proposal.id,
              documentId: d.id,
              text,
              class: 'ordinary',
            }),
          }
        : d,
    );
  }
  if (target.kind === 'move') {
    return documents.map((d) => ({ ...d, atoms: moved(d.atoms, target.atom, target.after) }));
  }
  if (target.kind === 'class') {
    return documents.map((d) => ({ ...d, atoms: classed(d.atoms, target.atom, target.to) }));
  }
  if (target.kind !== 'edit') return documents;
  return documents.map((d) => ({ ...d, atoms: edited(d.atoms, proposal.atom, text) }));
}

/**
 * Brings the Dispatches up to `draft.at` (#112): each Proposal carrying one
 * that has passed and closed by then sends it, once, in order of close time
 * and then relay order, as a Dispatch from the Proposal, under the Proposal's
 * id, pointing to the Document it changed or created (`documentOf`, #92),
 * received at its close. A fail or a
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
    const doc = dispatchDocument(draft, proposal);
    draft.dispatches.push({
      id,
      by: { proposal: id },
      ...dispatch,
      doc,
      received: closeTime(proposal),
    });
  }
}

/**
 * The Document a passed Proposal's Dispatch points to: the one it changed or
 * created (`documentOf`, #92), as the Documents read at `draft.at`. A
 * coalition's motion points to the coalition's one Document.
 */
function dispatchDocument(draft: Draft, proposal: OpenProposal): string | null {
  const documents = documentsAt(draft, draft.at);
  return documentOf({ ...draft, documents, atoms: documents.flatMap((d) => d.atoms) }, proposal);
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
 * motion, under its id, pointing to the coalition's one Document (#92),
 * received in that minute. A fail, a contest or a lapse sends nothing, and
 * nor does a motion still open when the coalition is declined, since relay
 * time stops.
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
    const doc = dispatchDocument(draft, proposal);
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
 * Applies final passes to the founded Documents in order of close time, then
 * the Proposals' relay order. When two adds share an anchor, the one applied
 * later ends up directly after it, and new Documents join in the order their
 * passes apply (#92).
 */
function applyPasses(
  founded: readonly DocumentDraft[],
  proposals: readonly Proposal[],
): readonly DocumentDraft[] {
  return inCloseOrder(proposals).reduce(applyPass, founded);
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
 * A formed coalition's log takes the motions its seats above decide (#122),
 * which its own seats then decide from their results, as they do its own
 * motions (crossing.ts's `foldTogether`). `relayNow` should be the relay's latest
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
    keyChecks: keyChecksOf(reads),
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
  readonly keyChecks: KeyChecks;
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
    members: [],
    former: [],
    founded: [],
    founding: null,
    document: { closed: '', documents: [] },
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
    doorClosure: null,
    exposedDoors: [],
    exposed: new Set(),
    carried: new Set(),
    epoch: 0,
    nextEpoch: 1,
    rotations: [],
    refused: [],
    rotationDue: false,
    stranded: [],
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
    keyChecks: pass.keyChecks,
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
  const documents = applyPasses(draft.founded, proposals);
  const { group, rules, name, chat, members, former, at, stewards, suspensions } = draft;
  const { removals, responses, narrowings, vouches, chatPosts, chatThreads } = draft;
  const { dispatches, doorInvites, doorClosure, exposedDoors } = draft;
  const { epoch, nextEpoch, rotations, refused, rotationDue } = draft;
  const state = {
    group,
    rules,
    optIns: effectiveOptIns({ rules, proposals, narrowings, at }),
    name,
    chat,
    documents: documents.map(({ id, title }) => ({ id, title })),
    members,
    former,
    atoms: documents.flatMap((document) => document.atoms),
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
    doorClosure,
    exposedDoors,
    epoch,
    nextEpoch,
    rotations,
    refused,
    rotationDue,
    strandedLeaves: draft.stranded.filter((leave) => isMember(draft, leave.author)),
    dissolved: draft.dissolved,
    recoveryShares: draft.recoveryShares,
    recoveryAlerts: draft.recoveryAlerts,
    recoveryCancels: draft.recoveryCancels,
    coalitions: heldSeats(proposals, draft.coalition !== null),
    coalition: draft.coalition,
    focus: focusOf(proposals),
    founding: draft.founding,
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

/**
 * A reconcile Proposal's outcome as its seat crosses: a group's once its vote
 * is final, a lapse as `fail`. A coalition's (#122) passes as soon as its
 * seats' pass is certain, before results on it stop counting, since a pass
 * that waited for that would reach the coalition above too late; a contest
 * that later turns it into a fail crosses as a fail.
 */
function heldOutcome(proposal: Proposal, certain: boolean): HeldSeat['outcome'] {
  const pass = proposal.outcome.kind === 'pass';
  if (certain && pass) return 'pass';
  if (!proposal.final) return 'open';
  return pass ? 'pass' : 'fail';
}

/**
 * The reconcile Proposals as seats (#100): each one's key, statement and
 * outcome, a coalition's (#122) as soon as it is certain.
 */
function heldSeats(proposals: readonly Proposal[], certain: boolean): HeldSeat[] {
  return proposals.flatMap((p) => {
    if (p.target.kind !== 'reconcile') return [];
    const { key, name, title, atoms } = p.target;
    return [{ proposal: p.id, key, name, title, atoms, outcome: heldOutcome(p, certain) }];
  });
}

/**
 * Opens each coalition motion whose relay seq is below `seq` that hasn't
 * opened yet (#100), taking it from the front of `motions`, which is in seq
 * order. Relay time moves on to its receipt first, as for a record, so in a
 * group its eligible set is everyone `wouldVote` lets in there. A group that
 * hasn't been founded or has dissolved opens none; nor does a coalition
 * before it forms or once declined (#122).
 */
function openMotionsBefore(draft: Draft, motions: Motion[], seq: number): void {
  while (motions.length > 0 && (motions[0]?.seq ?? seq) < seq) {
    const motion = motions.shift();
    if (motion !== undefined) openMotion(draft, motion);
  }
}

/** Whether this log opens motions from above now: a founded group that goes on, or a formed coalition (#122). */
function opensMotions(draft: Draft): boolean {
  if (draft.group === null || hasEnded(draft)) return false;
  return draft.coalition === null || draft.coalition.status === 'formed';
}

/**
 * Opens one coalition motion as a Proposal, with the coalition's class,
 * window, deadline and bar. It isn't the log's own: it has no number (0,
 * #123), no title, text or author, and carries no Dispatch (#112), since its
 * words are the coalition's. In a coalition (#122), its seats decide it, as
 * they do its own motions, from a snapshot of them now, and it has no
 * ballots, so no eligible set.
 */
function openMotion(draft: Draft, motion: Motion): void {
  if (!opensMotions(draft) || draft.proposals.some((p) => p.id === motion.id)) return;
  advanceTo(draft, motion.received, motion.seq);
  const { id, seq, received, coalition, chain, bar, window, deadline } = motion;
  openProposal(draft, {
    id,
    seq,
    received,
    author: '',
    atom: '',
    target: { kind: 'motion', coalition, chain, bar },
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
  const seats = draft.coalition?.seats.map((s) => s.key);
  if (seats !== undefined) draft.coalition?.motions.push({ id, deadline, seats, admit: null });
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
 * copy its author posts again to the new mailbox folds once. A leave among
 * them is noted as stranded (#225), so the device posts it there too. Any
 * front door a record carries is noted first, whether it folds or not
 * ({@link noteDoor}, #288). Otherwise relay time moves on, whatever the record
 * holds, until the group dissolves (#108), and the removals, seats, opt-ins
 * and carried Dispatches catch up to it before the event is checked. A
 * repeated event id is ignored. A membership that ends in a group makes a key
 * change due and closes the front door ({@link endMembership}).
 */
function foldRecord(draft: Draft, read: Read, seen: Set<string>): boolean {
  const { seq, received, epoch, parsed } = read;
  noteDoor(draft, read);
  if (epoch !== draft.epoch) {
    noteStranded(draft, read);
    return false;
  }
  if (!hasEnded(draft)) advanceTo(draft, received, seq);
  if (parsed === null) return false;
  const { event, id } = parsed;
  const applied = !seen.has(id) && applyEvent(draft, event, { id, seq, received });
  seen.add(id);
  // A coalition has no group key or front door, so a leave there ends only that participant (#100).
  if (applied && endsMembership(event) && draft.coalition === null) {
    endMembership(draft, { id, seq, received });
  }
  return applied;
}

/** Whether `author` is a current member. */
function isMember(draft: Draft, author: string): boolean {
  return draft.members.some((m) => m.author === author);
}

/**
 * Notes `read` as a stranded leave (#225) when it was read from an earlier
 * epoch's mailbox, so after the key change out of that epoch, and holds a
 * `leave` the fold would take from a current member here, the first copy of
 * its event id. It still changes nothing.
 */
function noteStranded(draft: Draft, { seq, epoch, parsed }: Read): void {
  if (epoch > draft.epoch || parsed?.event.type !== 'leave') return;
  const { event, id } = parsed;
  if (!admits(draft, event) || !isMember(draft, event.author)) return;
  if (draft.stranded.some((leave) => leave.id === id)) return;
  draft.stranded.push({ id, seq, author: event.author });
}
