import { type ReactNode, useId, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import { Ballot, type Scores } from '../app/Ballot';
import { ChatLink } from '../app/ChatLink';
import { type ChatDetails, type ChatMoment, openMoment } from '../app/chatMessages';
import { Countdown } from '../app/Countdown';
import { DocumentLine } from '../app/DocumentLine';
import { documentLead, sectionPlace } from '../app/documentLines';
import { formatAverageLine, formatZeroLine } from '../app/format';
import { latestLink } from '../app/latestLink';
import { ChangeInvolvement } from '../app/LevelPicker';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { ChoiceList, OptionList } from '../app/Options';
import { routeHref } from '../app/router';
import { SendStatus } from '../app/SendStatus';
import type { ShareOutcome } from '../app/share';
import { TellYourGroup } from '../app/TellYourGroup';
import { AtomText } from '../app/text/AtomText';
import { WordDiff } from '../app/text/WordDiff';
import { BackLink, PageHeader } from '../app/ui';
import { VersionList } from '../app/Versions';
import { rulesView } from '../app/optInLines';
import { RemovalResponse } from '../app/RemovalResponse';
import { Named, SuspendedNote } from '../app/stewards';
import {
  dissolveView,
  moveView,
  protectView,
  removalView,
  stewardView,
  versionDoes,
  type VersionView,
  versionViews,
} from '../app/versionViews';
import { rightsAt } from '../engine/admission';
import { can, holdsRights, isSuspended } from '../engine/capabilities';
import { threadFor } from '../engine/chatPosts';
import { composeOption } from '../engine/composeOption';
import { MAX_LEVEL, withinCeiling } from '../engine/coalition';
import { closedByDissolve } from '../engine/dissolve';
import {
  isAddProposal,
  isClassProposal,
  isDissolveProposal,
  isMoveProposal,
  isNewDocumentProposal,
  isPriorityProposal,
  isReconcileProposal,
  isRemovalProposal,
  isRulesProposal,
  isStewardProposal,
  type ParsedEvent,
  type AddProposalBody,
  type NewDocumentProposalBody,
  type ProposalBody,
  type ProposalEventBody,
  type RulesProposalBody,
  type StewardProposalBody,
} from '../engine/event';
import { type GroupState, type Proposal, proposalTally } from '../engine/fold';
import { displayName } from '../engine/names';
import { isNarrowed, type OptIn, rulesChange, rulesChangeOf } from '../engine/optIns';
import type { OwnBallot } from '../engine/ownBallot';
import { isPriority, optionId } from '../engine/priority';
import { removalTarget, removedFrom } from '../engine/removal';
import { isSeatNumber, seatAt, stewardChangeOf } from '../engine/stewards';
import type { TallyDetail } from '../engine/tally';
import {
  motionView,
  type MotionView,
  type MotionWords,
  motionWords,
  reconcileView,
  type ReconcileView,
} from '../app/coalitionLines';
import { CoalitionProgress } from '../app/CoalitionProgress';
import { MotionTagText } from '../app/MotionTag';
import { decisionOf } from '../app/versionViews';
import type { HeldCoalition } from '../store/coalitions';
import type { CarryPlan } from '../store/db';
import { ConsentMeter } from './ConsentMeter';
import { CoalitionResult, ResultView } from './ResultView';

/** Props for {@link ProposalView}. */
export interface ProposalViewProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The Proposal's id, from the route. */
  readonly proposalId: string;
  /** This device's events the relay hasn't accepted yet, oldest first. */
  readonly pending: readonly ParsedEvent[];
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
  /** The relay's minute now, as this device estimates it. */
  readonly now: number;
  /** Where this member's own ballot stands once it closes: a late one is named to them alone. */
  readonly own: OwnBallot;
  /** Queues this member's ballot, a score for every version; rejects when it couldn't be saved. */
  readonly onVote: (scores: Scores, note: string) => Promise<void>;
  /** Opens the composer to propose this Proposal again, once it has lapsed. */
  readonly onProposeAgain: () => void;
  /** Shares `moment`'s ready-made message into the group's chat, or copies it (#77, #113). */
  readonly onTell: (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;
  /** Whether this device's leave waits for the relay (#77): then it takes no ballot or version. */
  readonly leaving?: boolean;
  /** Whether this copy came back from a backup and hasn't heard from its group (#231): the same. */
  readonly unconfirmed?: boolean;
  /**
   * Queues this member's one response on the removal of them (#115); rejects
   * when it couldn't be saved. Without it, no response form shows.
   */
  readonly onRespond?: (text: string) => Promise<void>;
  /**
   * Once a dissolved group's ballots are cleared on this device (#108): when,
   * and each decided Proposal's tally as the device kept it, by id.
   */
  readonly cleared?: {
    readonly at: number;
    readonly tallies: Readonly<Record<string, TallyDetail>>;
  };
  /** Every coalition on this device (#114): a reconcile Proposal or a motion reads its words there. */
  readonly coalitions?: readonly HeldCoalition[];
  /**
   * This device's plan to cast this person's score from another group on
   * this promotion motion (#126), if it holds one.
   */
  readonly carry?: CarryPlan | null;
  /** Keeps that score from being cast: Don't cast (#126). */
  readonly onSkipCarry?: () => Promise<void>;
  /** Notes this person wrote on the same Dispatch in their other groups, which the note may not repeat (#126). */
  readonly notesElsewhere?: readonly string[];
}

/** A labelled block: an eyebrow heading over its content. */
function Block({
  title,
  className,
  children,
}: {
  readonly title: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className={className} aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface ScreenProps {
  readonly state: GroupState;
  /** Wider than the reading column, so several versions fit side by side. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}

function Screen({ state, wide = false, children }: ScreenProps) {
  return (
    <main className={wide ? 'shell shell-wide' : 'shell'}>
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      {children}
    </main>
  );
}

/** What the versions are shown against: the section's text now, under "Changes to section N". */
interface Comparison {
  readonly title: string;
  /** The section's text now, or null when there's nothing to compare with. */
  readonly current: string | null;
}

/** A priority vote's options are shown as they are, under "Options" (#107). */
const OPTIONS: Comparison = { title: messages.proposal.options, current: null };

/**
 * Each version is a word diff against the section's text now, numbered within
 * its Document (#92), or for an add (`atom` null, #75) or a new Document's
 * first sections, against nothing, so its whole text shows as added under
 * `adding`. Once a pass has changed the section, or when the section is gone,
 * each version shows as it reads instead.
 */
function comparisonFor(
  state: GroupState,
  atom: string | null,
  passed: boolean,
  adding: string = messages.proposal.newSection,
): Comparison {
  if (passed) return { title: messages.proposal.onBallot, current: null };
  if (atom === null) return { title: adding, current: '' };
  const place = sectionPlace(state, atom);
  if (place === null) return { title: messages.proposal.proposed, current: null };
  return { title: messages.proposal.changes(place.number), current: place.atom.text };
}

/** A steward or rules ballot shows what it decides, never a diff: it changes no section (#102, #117). */
const STEWARD_BALLOT: Comparison = { title: messages.proposal.onBallot, current: null };

/**
 * A move's one card is shown under "Moving section N" while its section is
 * in place and it hasn't passed, else under "On the ballot" (#103). It shows
 * no diff: a move changes no words.
 */
function moveComparison(state: GroupState, atom: string, passed: boolean): Comparison {
  const place = passed ? null : sectionPlace(state, atom);
  if (place === null) return STEWARD_BALLOT;
  return { title: messages.proposal.moving(place.number), current: null };
}

/**
 * A class Proposal's one card is shown under "Protection for section N"
 * while its section is in place and it hasn't passed, else under "On the
 * ballot" (#116). It shows no diff: protecting a section changes no words.
 */
function classComparison(state: GroupState, atom: string, passed: boolean): Comparison {
  const place = passed ? null : sectionPlace(state, atom);
  if (place === null) return STEWARD_BALLOT;
  return { title: messages.proposal.protecting(place.number), current: null };
}

/**
 * True for a Proposal with text: an edit, an add (#75) or a new Document
 * (#92), not a steward or rules one (#102, #117).
 */
function writesText(proposal: Proposal): boolean {
  const { kind } = proposal.target;
  return kind === 'edit' || kind === 'add' || kind === 'new-document';
}

/** The section a Proposal changes, or null when it adds one (#75) or a new Document (#92). */
function changedAtom(proposal: Proposal): string | null {
  const { kind } = proposal.target;
  return kind === 'add' || kind === 'new-document' ? null : proposal.atom;
}

/** What a ballot of added text is headed: a new section (#75), or a new Document's first sections (#92). */
function addingTitle(proposal: Pick<Proposal, 'target'>): string {
  const { proposal: words } = messages;
  return proposal.target.kind === 'new-document' ? words.firstSections : words.newSection;
}

/**
 * What a folded Proposal's versions are shown against: a section, nothing for
 * an add or a new Document, whose whole text shows as added (#75, #92),
 * nothing for a steward one, a move (#103) or a class Proposal (#116), or
 * for a priority vote, its options as they are (#107).
 */
function comparisonOf(state: GroupState, proposal: Proposal, passed: boolean): Comparison {
  if (isPriority(proposal)) return OPTIONS;
  if (proposal.target.kind === 'move') return moveComparison(state, proposal.atom, passed);
  if (proposal.target.kind === 'class') return classComparison(state, proposal.atom, passed);
  return writesText(proposal)
    ? comparisonFor(state, changedAtom(proposal), passed, addingTitle(proposal))
    : STEWARD_BALLOT;
}

/**
 * What a coalition motion's one version is shown against (#120): the section
 * it rewords, as the coalition's Document reads now, under "Changes to
 * section N"; once the coalition's pass is final, or for an admission, the
 * version as it reads.
 */
function motionComparison(motion: MotionView): Comparison {
  const { section, progress } = motion;
  if (section === null || (progress.outcome === 'pass' && progress.final)) return STEWARD_BALLOT;
  return { title: messages.proposal.changes(section.number), current: section.text };
}

/** What the ballot's versions are shown against: the group's section, or a coalition motion's (#120). */
function voteComparison(state: GroupState, proposal: Proposal, motion: MotionView | null) {
  if (motion !== null) return motionComparison(motion);
  return comparisonOf(state, proposal, proposal.final && proposal.outcome.kind === 'pass');
}

/** A rules ballot opens with its opt-in's warning: what the outside platform would hold (#117). */
function OptInWarning({ optIn }: { readonly optIn: OptIn | null }) {
  return optIn === null ? null : (
    <p className="opt-in-warning">{messages.optIns.warnings[optIn]}</p>
  );
}

/**
 * The higher bar in words over a ballot that needs it for a section (#116):
 * a class Proposal, whatever it asks, or a change, move or removal of an
 * entrenched section. The consent meter draws the same lines, from the
 * Proposal's own bar.
 */
function HigherBar({ proposal }: { readonly proposal: Proposal }) {
  const { kind } = proposal.target;
  const { bar } = proposal.outcome;
  const { proposal: words } = messages;
  if (proposal.class !== 'entrenched') return null;
  const lines = [formatAverageLine(bar), formatZeroLine(bar)] as const;
  if (kind === 'class') return <p className="caption">{words.protectionBar(...lines)}</p>;
  return kind === 'edit' || kind === 'move' ? (
    <p className="caption">{words.entrenchedBar(...lines)}</p>
  ) : null;
}

/**
 * "Steward <name> turned this off at once. …" on an off-Proposal while the
 * narrowing beside it is in force (#117), so every member sees it.
 */
function NarrowedNote({ state, proposal }: { state: GroupState; proposal: Proposal }) {
  const change = rulesChangeOf(proposal);
  const narrowing = state.narrowings.find((n) => n.proposal === proposal.id);
  if (change === null || narrowing === undefined || !isNarrowed(state, change.optIn)) return null;
  const name = displayName(state, narrowing.by) ?? '';
  return (
    <p className="opt-in-narrowed">
      <Named parts={messages.optIns.narrowedBallot} name={name} />
    </p>
  );
}

/**
 * The diff legend, under the heading, whenever the versions show as diffs;
 * for a priority vote, how its options are scored and ranked, while it's open.
 */
function Legend({ comparison, open = true }: { readonly comparison: Comparison; open?: boolean }) {
  if (comparison === OPTIONS) {
    return open ? <p className="caption">{messages.proposal.optionsHint}</p> : null;
  }
  return comparison.current === null ? null : <p className="caption">{messages.diff.legend}</p>;
}

/** How a ballot or list lays its versions out: as changes, or as a priority vote's options (#107). */
function layoutOf(comparison: Comparison): 'versions' | 'options' {
  return comparison === OPTIONS ? 'options' : 'versions';
}

/** This member's latest ballot on the Proposal: one waiting in the outbox, else the folded one. */
function myBallot(props: ProposalViewProps, proposal: Proposal) {
  const waiting = props.pending
    .flatMap(({ event }) =>
      event.type === 'vote' && event.author === props.me && event.body.proposal === proposal.id
        ? [event.body]
        : [],
    )
    .at(-1);
  const folded = proposal.ballots.find((ballot) => ballot.voter === props.me);
  const ballot = waiting ?? folded;
  return {
    scores: ballot?.scores ?? {},
    note: ballot?.note ?? '',
    hasVoted: ballot !== undefined,
    pending: waiting !== undefined,
  };
}

/**
 * Why someone in the eligible set gets no ballot now, or null: they get one
 * once voting has closed (unchangeable), or while their level votes, or while
 * a suspension runs (disabled, until it ends, #102).
 */
function whyEligibleCantVote(props: ProposalViewProps, proposal: Proposal): string | null {
  const { state, me, now } = props;
  const closed = proposal.final || now >= proposal.deadline;
  const votes = can(state, me, 'vote') || isSuspended(state, me);
  return closed || votes ? null : messages.levels.following;
}

/**
 * Why `me` gets no ballot on `proposal`, or null when they get one (#166).
 * Outside its eligible set, they are the member it would remove (#115), a
 * vote has removed them since, they joined after it opened, hadn't earned a
 * vote yet when it opened (#101), weren't at a voting level then, or are the
 * steward it would recall (#102). Inside it, they get the ballot, unchangeable once voting
 * has closed; while it's open, they need a level that votes now, and choosing
 * one gives them the ballot back.
 */
function whyNoVote(props: ProposalViewProps, proposal: Proposal): string | null {
  const { state, me } = props;
  if (props.leaving === true) return messages.leave.noVoting;
  if (props.unconfirmed === true) return messages.unconfirmed.noVoting;
  if (proposal.eligible.includes(me)) return whyEligibleCantVote(props, proposal);
  if (removalTarget(proposal) === me) return messages.removal.ownRemoval;
  if (removedFrom(state, me) !== undefined) return messages.removal.readOnly;
  return whyOutside(state, me, proposal);
}

/** Why `me`, a member outside `proposal`'s eligible set, wasn't in it when it opened. */
function whyOutside(state: GroupState, me: string, proposal: Proposal): string {
  const change = stewardChangeOf(proposal);
  if (change?.member === null && change.holder === me) return messages.stewards.ownRecall;
  const member = state.members.find((candidate) => candidate.author === me);
  if (member === undefined || member.seq > proposal.seq) return messages.proposal.joinedAfter;
  return hadNoVote(state, me, proposal)
    ? messages.admission.noVoteYet
    : messages.proposal.notVotingLevel;
}

/** True when `me`'s voting rights hadn't arrived yet when `proposal` opened (#101). */
function hadNoVote(state: GroupState, me: string, proposal: Proposal): boolean {
  const arrived = rightsAt(state, me);
  return arrived === null || arrived > proposal.received;
}

interface NoVoteProps {
  readonly state: GroupState;
  readonly me: string;
  readonly reason: string;
  readonly leaving: boolean;
}

/**
 * Why they can't vote, and where they change their level when theirs doesn't
 * vote now. A newcomer gets their own line instead: no level votes until
 * their rights arrive (#101).
 */
function NoVote({ state, me, reason, leaving }: NoVoteProps) {
  const levelDoesntVote =
    !leaving && holdsRights(state, me) && !can(state, me, 'vote') && !isSuspended(state, me);
  return (
    <div className="stack">
      <p className="lede">{reason}</p>
      {levelDoesntVote ? <ChangeInvolvement groupId={state.group ?? ''} /> : null}
    </div>
  );
}

/**
 * True while this device takes nothing new for the group: its leave waits
 * (#77), or its copy back from a backup hasn't heard from the group (#231).
 */
function readsOnly(props: ProposalViewProps): boolean {
  return props.leaving === true || props.unconfirmed === true;
}

/** True while the vote takes ballots and versions, as far as this device can tell. */
function isOpen(props: ProposalViewProps, proposal: Proposal): boolean {
  return !proposal.final && props.now < proposal.deadline;
}

/** Whether this member can still add wording: the vote is open, they may propose, and they're staying. */
function isOpenToVersions(props: ProposalViewProps, proposal: Proposal): boolean {
  return isOpen(props, proposal) && !readsOnly(props) && can(props.state, props.me, 'propose');
}

/**
 * Tell your group (#113), for everyone while the vote is open and they're
 * staying: the open message, or the version line for someone who added a
 * version, then the closing message from a day before the deadline. Only a
 * folded Proposal has a deadline to share. Each moment starts a fresh,
 * unticked Include the title.
 */
function Tell({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  if (!isOpen(props, proposal) || readsOnly(props)) return null;
  const moment = openMoment(proposal, props.me, props.now);
  return <TellYourGroup key={moment} moment={moment} proposal={proposal} onTell={props.onTell} />;
}

/** "Add your version", which opens the composer for this section, or why there's no room. */
function AddVersion({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  // A steward or rules Proposal has no text, so it takes no versions (#102, #117); an edit or an add does.
  if (!writesText(proposal) || !isOpenToVersions(props, proposal)) return null;
  const option = composeOption(props.state, proposal.atom);
  if (option === 'ballot-full') return <p className="caption">{messages.proposal.ballotFull}</p>;
  const route = {
    name: 'propose',
    groupId: props.state.group ?? '',
    atomId: proposal.atom,
  } as const;
  return option === 'add-version' ? (
    <Link className="button button-quiet add-version" href={routeHref(route)}>
      {messages.proposal.addVersion}
    </Link>
  ) : null;
}

interface VoteProps {
  readonly props: ProposalViewProps;
  readonly proposal: Proposal;
  readonly versions: readonly VersionView[];
  /** The coalition motion it opens in the group (#120), or null for the group's own. */
  readonly motion: MotionView | null;
}

/**
 * Each version's consent meter while the vote is open, from the engine's
 * tally of the ballots so far, and nothing once it has closed: the result
 * gives the totals then.
 */
function metersFor(proposal: Proposal): (version: VersionView) => ReactNode {
  const detail = proposal.final ? null : proposalTally(proposal);
  const priority = isPriority(proposal);
  return function MeterFor(version) {
    const tallied = detail?.versions.find((candidate) => candidate.id === version.id);
    const label = priority ? { label: messages.meter.optionLabel(version.text) } : {};
    return detail === null || tallied === undefined ? null : (
      <ConsentMeter number={version.number} tally={tallied} bar={detail.bar} {...label} />
    );
  };
}

/**
 * True when the viewer gets the ballot: they can vote on it, and this device
 * hasn't cleared its ballots (#111), since then there's no ballot left to show.
 */
function ballotShown(reason: string | null, proposal: Proposal): boolean {
  return reason === null && !proposal.cleared;
}

/**
 * The versions, or a priority vote's options, each with its own pills for
 * someone who can vote on them, then "Add your version". Once this device has
 * cleared a Proposal's ballots (#111), there's no ballot left to show, so the
 * versions or options stand alone.
 */
function Vote({ props, proposal, versions, motion }: VoteProps) {
  const { state, me, now, reachable, onVote } = props;
  const comparison = voteComparison(state, proposal, motion);
  const layout = layoutOf(comparison);
  const reason = whyNoVote(props, proposal);
  const closed = proposal.final || now >= proposal.deadline;
  const suspended = isSuspended(state, me);
  const mine = myBallot(props, proposal);
  const meters = metersFor(proposal);
  return (
    <Block title={comparison.title} className="vote">
      <OptInWarning optIn={rulesChangeOf(proposal)?.optIn ?? null} />
      <HigherBar proposal={proposal} />
      <NarrowedNote state={state} proposal={proposal} />
      <Legend comparison={comparison} open={!proposal.final} />
      {ballotShown(reason, proposal) ? (
        <CarriedOrBallot props={props} proposal={proposal} mine={mine} closed={closed}>
          {(carried) => (
            <Ballot
              key={proposal.id}
              versions={versions}
              current={comparison.current}
              initialScores={carried ?? mine.scores}
              initialNote={mine.note}
              hasVoted={mine.hasVoted}
              isDisabled={closed || suspended}
              pending={mine.pending}
              reachable={reachable}
              onVote={onVote}
              below={meters}
              layout={layout}
              disabledNote={
                closed || !suspended ? undefined : <SuspendedNote state={state} me={me} />
              }
              refusedNotes={props.notesElsewhere ?? []}
            />
          )}
        </CarriedOrBallot>
      ) : (
        <>
          <ChoiceList versions={versions} current={comparison.current} layout={layout}>
            {meters}
          </ChoiceList>
          {reason === null ? null : (
            <NoVote state={state} me={me} reason={reason} leaving={readsOnly(props)} />
          )}
        </>
      )}
      <AddVersion props={props} proposal={proposal} />
    </Block>
  );
}

/**
 * This device's plan to carry this person's score here (#126), while it
 * stands: on this Proposal, not kept back, the vote open, and no ballot of
 * their own yet.
 */
function carryFor(
  props: ProposalViewProps,
  proposal: Proposal,
  mine: { readonly hasVoted: boolean },
  closed: boolean,
): CarryPlan | null {
  const plan = props.carry ?? null;
  if (plan?.motion !== proposal.id || plan.skipped === true) return null;
  return mine.hasVoted || closed ? null : plan;
}

/** "Your 3 from another group will be cast here before voting ends.", with Change and Don't cast (#126). */
function CarryNotice({
  score,
  onChange,
  onSkip,
}: {
  readonly score: number;
  readonly onChange: () => void;
  readonly onSkip: (() => Promise<void>) | undefined;
}) {
  const { rising } = messages;
  return (
    <div className="carry-notice">
      <p className="field-hint">{messages.ballot.visibility}</p>
      <p className="ballot-notice">{rising.carried(score)}</p>
      <div className="row">
        <Button className="button button-secondary" onPress={onChange}>
          {rising.change}
        </Button>
        <Button className="button button-quiet" onPress={() => void onSkip?.()}>
          {rising.dontCast}
        </Button>
      </div>
    </div>
  );
}

interface CarriedOrBallotProps {
  readonly props: ProposalViewProps;
  readonly proposal: Proposal;
  readonly mine: { readonly hasVoted: boolean };
  readonly closed: boolean;
  /** The ballot, given the scores to start from: a carried score's, or null for the voter's own. */
  readonly children: (carried: Scores | null) => ReactNode;
}

/**
 * Where this device carries this person's score here (#126): a score above
 * 0 shows that it will be cast, in place of the pills, until Change opens
 * the ballot with it chosen; a 0 asks for a fresh reason over a ballot with
 * the 0 chosen. Otherwise the ballot as usual.
 */
function CarriedOrBallot({ props, proposal, mine, closed, children }: CarriedOrBallotProps) {
  const [changing, setChanging] = useState(false);
  const carry = carryFor(props, proposal, mine, closed);
  if (carry === null) return children(null);
  if (carry.score !== 0 && !changing) {
    return (
      <CarryNotice
        score={carry.score}
        onChange={() => {
          setChanging(true);
        }}
        onSkip={props.onSkipCarry}
      />
    );
  }
  return (
    <>
      {carry.score === 0 ? <p className="ballot-notice">{messages.rising.freshReason}</p> : null}
      {children({ [proposal.id]: carry.score })}
    </>
  );
}

/** This member's versions of the Proposal still in the outbox, each as its change, with where it has got to. */
function PendingVersions({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state, me, pending, reachable } = props;
  const mine = pending.flatMap(({ event, id }) =>
    event.type === 'version' && event.author === me && event.body.proposal === proposal.id
      ? [{ id, text: event.body.text }]
      : [],
  );
  if (mine.length === 0) return null;
  const { current } = comparisonFor(state, changedAtom(proposal), false, addingTitle(proposal));
  return (
    <Block title={messages.proposal.yourVersion} className="text-block">
      {mine.map(({ id, text }) =>
        current === null ? (
          <AtomText key={id} text={text} className="atom-card" />
        ) : (
          <WordDiff key={id} current={current} proposed={text} />
        ),
      )}
      <SendStatus pending reachable={reachable} sent={false} />
    </Block>
  );
}

/**
 * Who proposed it, then the countdown, then, while voting is open, how many
 * days its proposer set it to run (#106), each on its own line so none breaks
 * mid-phrase.
 */
function Byline({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state, now } = props;
  const name = displayName(state, proposal.author) ?? '';
  const open = !proposal.final && now < proposal.deadline;
  const motion = motionWords(proposal, props.coalitions ?? []);
  return (
    <div className="meta-lines">
      {motion === null ? (
        <p className="meta">
          {messages.proposal.proposedBy} <bdi>{name}</bdi>
        </p>
      ) : (
        <p className="meta">
          {messages.coalitions.from} <bdi>{motion.coalition}</bdi>
        </p>
      )}
      <p className="meta">
        <Countdown deadline={proposal.deadline} closedAt={proposal.closedAt} now={now} />
      </p>
      {open ? <p className="meta">{messages.window.runs(proposal.window)}</p> : null}
    </div>
  );
}

/** How a cut-off Proposal reads: closed or still open, for its eyebrow, and the line saying why it shows no outcome. */
interface CutOffWords {
  /** True when it reads as closed, as a dissolve leaves it; false when it reads as still open. */
  readonly closed: boolean;
  readonly line: string;
}

/**
 * Where Join discussion goes: the Proposal's own Discord thread once the log
 * holds it (#123), else its own link, else the group's latest (#66).
 */
function discussionLink(state: GroupState, proposal: Proposal): string | null {
  const thread = threadFor(state, proposal.id)?.url;
  if (thread !== undefined) return thread;
  return proposal.link !== null && isHttpLink(proposal.link) ? proposal.link : latestLink(state);
}

/**
 * "Proposal N · Open" or "Proposal N · Closed", with its number among the
 * group's Proposals (#123), or for a priority vote, "Proposal N · Priority
 * vote" or "Proposal N · Closed priority vote" (#107).
 */
function eyebrowOf(proposal: Proposal, closed: boolean): ReactNode {
  const words = messages.proposal;
  if (isPriority(proposal)) {
    return (closed ? words.eyebrowPriorityClosed : words.eyebrowPriority)(proposal.number);
  }
  return (closed ? words.eyebrowClosed : words.eyebrowOpen)(proposal.number);
}

/**
 * How this device shows a Proposal it has cut off, or null when it hasn't:
 * closed, when it was still open as the group dissolved (#108), or open,
 * when a vote removed this member while it was (#115), so this device never
 * learns how it ends.
 */
function cutOffOf(props: ProposalViewProps, proposal: Proposal): CutOffWords | null {
  const { state, me } = props;
  if (closedByDissolve(state, proposal)) {
    return { closed: true, line: messages.archive.closed };
  }
  const removed = removedFrom(state, me) !== undefined && !proposal.final;
  return removed ? { closed: false, line: messages.removal.stillOpenLine } : null;
}

/**
 * A Proposal still open when its group dissolved (#108), or when a vote
 * removed this member (#115): with no outcome and no ballot, its versions, or
 * a priority vote's options (#107), as they stood, and `line` saying why.
 */
function CutOff(props: { props: ProposalViewProps; proposal: Proposal; words: CutOffWords }) {
  const { proposal } = props;
  const { closed, line } = props.words;
  const { state } = props.props;
  const versions = versionViews(state, proposal);
  const comparison = comparisonOf(state, proposal, false);
  return (
    <Screen state={state} wide={versions.length > 1}>
      <PageHeader
        eyebrow={eyebrowOf(proposal, closed)}
        title={proposal.title}
        pageTitle={messages.proposal.pageTitle}
      >
        <DocumentLine lead={documentLead(state, proposal)} groupId={state.group ?? ''} />
      </PageHeader>
      <div className="stack">
        <div className="meta-lines">
          <p className="meta">
            {messages.proposal.proposedBy} <bdi>{displayName(state, proposal.author) ?? ''}</bdi>
          </p>
          <p className="meta">{line}</p>
        </div>
        <Why why={proposal.why} />
      </div>
      <Block title={comparison.title} className="vote">
        <Legend comparison={comparison} open={false} />
        <ChoiceList
          versions={versions}
          current={comparison.current}
          layout={layoutOf(comparison)}
        />
      </Block>
    </Screen>
  );
}

/** True once this group only reads here: it dissolved (#108), or a vote removed `me` (#115). */
function isArchived(state: GroupState, me: string): boolean {
  return state.dissolved !== null || removedFrom(state, me) !== undefined;
}

/** The tally a cleared archive kept for `proposal`, if its ballots are cleared (#108). */
function clearedOf(props: ProposalViewProps, proposal: Proposal) {
  const tally = props.cleared?.tallies[proposal.id];
  return props.cleared === undefined || tally === undefined
    ? {}
    : { cleared: { at: props.cleared.at, tally } };
}

/**
 * The Dispatch an open Proposal carries (#112): "If this passes", its title
 * and its text as plain text, and that everyone in the group gets it, so
 * voters see what passing also sends. Nothing once the vote has closed: the
 * Dispatches view has it then, or it never went.
 */
function CarriedDispatch({ proposal }: { readonly proposal: Proposal }) {
  const { dispatch, target } = proposal;
  // A Dispatch that may rise shows in its own block (#126).
  if (dispatch === null || proposal.final || target.kind === 'dispatch') return null;
  if (target.kind === 'motion') return null;
  const { dispatchHeading, dispatchLine } = messages.proposal;
  return (
    <Block title={dispatchHeading} className="card dispatch dispatch-carried">
      <p className="heading-3 dispatch-title">
        <bdi>{dispatch.title}</bdi>
      </p>
      {dispatch.text === '' ? null : (
        <p className="dispatch-text" dir="auto">
          {dispatch.text}
        </p>
      )}
      <p className="caption">{dispatchLine}</p>
    </Block>
  );
}

/** A Dispatch's title and its text as plain text, which keeps its line breaks. */
function DispatchWords({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <>
      <p className="heading-3 dispatch-title">
        <bdi>{title}</bdi>
      </p>
      {text === '' ? null : (
        <p className="dispatch-text" dir="auto">
          {text}
        </p>
      )}
    </>
  );
}

/**
 * A Dispatch that may rise (#126; ADR-0037): the group's own vote on it, with
 * how far it can go (its ballot card says what passing does), or a promotion
 * motion from the coalition, with the seat that passed it and what the
 * coalition's pass does.
 */
function RisingDispatch({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { rising, sendDispatch } = messages;
  const { target, dispatch } = proposal;
  if (target.kind === 'dispatch' && dispatch !== null) {
    return (
      <Block title={rising.heading} className="card dispatch dispatch-carried">
        <DispatchWords title={dispatch.title} text={dispatch.text} />
        <p className="caption">{rising.ceiling(sendDispatch.ceilings[target.ceiling])}</p>
      </Block>
    );
  }
  const words = motionWords(proposal, props.coalitions ?? []);
  const promoted = words?.promoted ?? null;
  if (words === null || promoted === null) return null;
  const above = promoted.level < MAX_LEVEL && withinCeiling(promoted.level + 1, promoted.ceiling);
  return (
    <Block title={rising.heading} className="card dispatch dispatch-carried">
      <DispatchWords title={promoted.title} text={promoted.text} />
      <p className="caption">
        {rising.passedBy.before} <bdi>{promoted.from}</bdi>
      </p>
      <p className="caption">{rising.motionLine(words.coalition)}</p>
      {above ? <p className="caption">{rising.goesOn}</p> : null}
    </Block>
  );
}

/** The justification, as plain text, or nothing when there is none, as a card brought in may have (#114). */
function Why({ why }: { readonly why: string }) {
  return why === '' ? null : (
    <p className="lede" dir="auto">
      {why}
    </p>
  );
}

/**
 * A coalition asking into the coalition this motion is from (#122): its
 * name, its level and its member groups, as its admit motion states them,
 * which each group's vote checks.
 */
function AdmitsCoalition({ words }: { readonly words: MotionWords | null }) {
  if (words === null || words.admits === null || words.admitsLevel === 0) return null;
  const { coalitions } = messages;
  return (
    <Block title={coalitions.admitsTitle} className="card admits-coalition">
      <p className="heading-3">
        <bdi>{words.admits}</bdi>
      </p>
      <p className="caption">{coalitions.admitsLevel(words.admitsLevel)}</p>
      {words.admitsGroups.length === 0 ? null : (
        <p>
          {coalitions.admitsCoalition} <bdi>{words.admitsGroups.join(', ')}</bdi>
        </p>
      )}
    </Block>
  );
}

/**
 * A reconcile Proposal's coalition (#114): its name and statement as the
 * card set them, then, once its genesis names them, the other groups it
 * reconciles with.
 */
function ReconcileStatement({ view }: { readonly view: ReconcileView | null }) {
  if (view === null) return null;
  return (
    <Block title={messages.coalitions.statement} className="card reconcile-statement">
      <p className="heading-3">
        <bdi>{view.name}</bdi>
      </p>
      {view.others === null || view.others.length === 0 ? null : (
        <p className="reconcile-with">
          {messages.coalitions.with} <bdi>{view.others.join(', ')}</bdi>
        </p>
      )}
      <div className="document reconcile-document">
        <p className="eyebrow">
          <bdi>{view.title}</bdi>
        </p>
        {view.atoms.map((atom, index) => (
          // Sections are numbered by position; the same text may appear twice.
          <div key={index} className="atom">
            <AtomText text={atom} />
          </div>
        ))}
      </div>
    </Block>
  );
}

/**
 * The coalition's own result once it has decided a motion (#120), above the
 * group's: what changed, and each group's pass or fail.
 */
function MotionResult({ motion }: { readonly motion: MotionView | null }) {
  if (motion?.progress.outcome === undefined) return null;
  return (
    <CoalitionResult progress={motion.progress} text={motion.motion.text} author={motion.author} />
  );
}

/**
 * A coalition motion's progress while the coalition is still deciding it
 * (#120), and for one from further up, each coalition it came through (#122).
 */
function MotionProgress({ motion }: { readonly motion: MotionView | null }) {
  if (motion === null || motion.progress.outcome !== undefined) return null;
  return (
    <CoalitionProgress progress={motion.progress} steps={motion.steps} top={motion.coalition} />
  );
}

/** A removal's response block on its ballot (#115): the response, or the one-time form to its target. */
function Response(props: { props: ProposalViewProps; proposal: Proposal; readOnly: boolean }) {
  const { props: view, proposal, readOnly } = props;
  return (
    <RemovalResponse
      state={view.state}
      me={view.me}
      proposal={proposal}
      pending={view.pending}
      reachable={view.reachable}
      now={view.now}
      readOnly={readOnly}
      {...(view.onRespond === undefined ? {} : { onRespond: view.onRespond })}
    />
  );
}

/**
 * A Proposal the relay has ordered: open with its ballot, or closed with its
 * outcome first. A removal's response follows its justification (#115), and a
 * reconcile Proposal's coalition, as its card set it, follows that (#114). A
 * coalition motion (#120) is tagged with its coalition, its version is a word
 * diff against the coalition's text, and it shows the coalition's progress
 * while it decides, then the coalition's result first.
 */
function Folded({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state } = props;
  const cutOff = cutOffOf(props, proposal);
  if (cutOff !== null) return <CutOff props={props} proposal={proposal} words={cutOff} />;
  const readOnly = readsOnly(props) || isArchived(state, props.me);
  const coalitions = props.coalitions ?? [];
  const motion = motionView(proposal, state, coalitions);
  const names = motion?.state ?? state;
  const versions = versionViews(state, proposal, names);
  return (
    <Screen state={state} wide={versions.length > 1}>
      <PageHeader
        eyebrow={
          motion === null ? (
            eyebrowOf(proposal, proposal.final)
          ) : (
            <MotionTagText coalition={motion.coalition} through={motion.through} />
          )
        }
        title={proposal.title}
        pageTitle={messages.proposal.pageTitle}
      >
        <DocumentLine lead={documentLead(state, proposal)} groupId={state.group ?? ''} />
      </PageHeader>
      <MotionResult motion={motion} />
      {proposal.final ? (
        <ResultView
          state={state}
          proposal={proposal}
          me={props.me}
          own={props.own}
          onProposeAgain={props.onProposeAgain}
          onTell={props.onTell}
          leaving={readOnly}
          names={names}
          {...clearedOf(props, proposal)}
        />
      ) : null}
      <div className="stack">
        <Byline props={props} proposal={proposal} />
        <Why why={proposal.why} />
      </div>
      <Response props={props} proposal={proposal} readOnly={readOnly} />
      <MotionProgress motion={motion} />
      <ReconcileStatement view={reconcileView(proposal, coalitions)} />
      <AdmitsCoalition words={motionWords(proposal, coalitions)} />
      <CarriedDispatch proposal={proposal} />
      <RisingDispatch props={props} proposal={proposal} />
      <ChatLink href={discussionLink(state, proposal)} />
      <Tell props={props} proposal={proposal} />
      <Vote props={props} proposal={proposal} versions={versions} motion={motion} />
      <PendingVersions props={props} proposal={proposal} />
    </Screen>
  );
}

interface WaitingProps {
  readonly state: GroupState;
  readonly me: string;
  /** The Proposal's event id, which is its id once the relay has it. */
  readonly id: string;
  readonly body: ProposalEventBody;
  readonly pending: boolean;
  readonly reachable: boolean;
}

/** A waiting steward Proposal's one version: what its ballot will decide, by the seat's holder now. */
function waitingSteward(
  state: GroupState,
  author: string,
  body: StewardProposalBody,
): VersionView[] {
  const { seat, member } = body.target;
  if (!isSeatNumber(seat)) return [];
  const steward = stewardView(state, { seat, member, holder: seatAt(state, seat).holder });
  return [{ id: '', number: 1, author, text: '', steward }];
}

/**
 * A waiting rules Proposal's one version: what its ballot will decide, from
 * the standing value now, and its opt-in for the warning. Nothing for a value
 * the fold would refuse (#117).
 */
function waitingRules(state: GroupState, author: string, body: RulesProposalBody) {
  const change = rulesChange(state.rules.optIns, body.target.optIn, body.target.value);
  if (change === null) return { optIn: null, versions: [] };
  const rules = rulesView(change);
  return { optIn: change.optIn, versions: [{ id: '', number: 1, author, text: '', rules }] };
}

/**
 * What a waiting ballot decides other than a section's text: a steward,
 * rules, dissolve, member removal, move, class or coalition card (#102,
 * #117, #108, #115, #103, #116, #114), or a priority vote's options (#107);
 * null for one that changes text.
 */
function waitingDecision(state: GroupState, author: string, body: ProposalEventBody) {
  if (isStewardProposal(body)) {
    return {
      comparison: STEWARD_BALLOT,
      versions: waitingSteward(state, author, body),
      optIn: null,
    };
  }
  if (isPriorityProposal(body)) {
    const versions = body.options.map((text, i) => ({
      id: optionId('', i),
      number: i + 1,
      author,
      text,
    }));
    return { comparison: OPTIONS, versions, optIn: null };
  }
  if (isRulesProposal(body))
    return { comparison: STEWARD_BALLOT, ...waitingRules(state, author, body) };
  if (isDissolveProposal(body)) {
    const dissolve = dissolveView(body.target.wipe);
    const versions = [{ id: '', number: 1, author, text: '', dissolve }];
    return { comparison: STEWARD_BALLOT, versions, optIn: null };
  }
  if (isMoveProposal(body)) {
    const versions = [{ id: '', number: 1, author, text: '', move: moveView(state, body.target) }];
    return { comparison: moveComparison(state, body.target.atom, false), versions, optIn: null };
  }
  if (isClassProposal(body)) {
    const protect = protectView(state, body.target);
    const versions = [{ id: '', number: 1, author, text: '', protect }];
    return { comparison: classComparison(state, body.target.atom, false), versions, optIn: null };
  }
  if (isRemovalProposal(body)) {
    const removal = removalView(state, body.target.member);
    const versions = [{ id: '', number: 1, author, text: '', removal }];
    return { comparison: STEWARD_BALLOT, versions, optIn: null };
  }
  // A reconcile Proposal (#100) changes no section: its ballot decides the coalition (#114).
  if (isReconcileProposal(body)) {
    const target = { ...body.target, key: '' };
    const decision = decisionOf({ target, title: body.title, text: '' });
    const versions = [{ id: '', number: 1, author, text: '', ...decision }];
    return { comparison: STEWARD_BALLOT, versions, optIn: null };
  }
  return null;
}

/**
 * True for a Proposal whose versions hold text: an edit, a section's removal,
 * an add (#75) or a new Document (#92).
 */
function changesText(
  body: ProposalEventBody,
): body is ProposalBody | AddProposalBody | NewDocumentProposalBody {
  return !('target' in body) || isAddProposal(body) || isNewDocumentProposal(body);
}

/** How a waiting Proposal's one version shows: its text against the section, or what its ballot decides. */
function waitingVersions(state: GroupState, me: string, body: ProposalEventBody) {
  const author = displayName(state, me) ?? '';
  const decided = waitingDecision(state, author, body);
  if (decided !== null) return decided;
  // An admit target is only ever a coalition's (#114), so it waits in no group's outbox.
  if (!changesText(body)) return { comparison: STEWARD_BALLOT, versions: [], optIn: null };
  // An add's or a new Document's whole text shows as added, and an add says where it goes
  // (#75, #92); a section's removal says so too.
  const target = 'target' in body ? body.target : ({ kind: 'edit' } as const);
  const atom = 'atom' in body ? body.atom : null;
  const comparison = comparisonFor(state, atom, false, addingTitle({ target }));
  const does = versionDoes(state, target, body.text);
  const version = { id: '', number: 1, author, text: body.text };
  return { comparison, versions: [does === null ? version : { ...version, does }], optIn: null };
}

/** What a waiting Proposal changes or creates, as its page leads with it (#92), or null for none. */
function waitingLead(state: GroupState, id: string, body: ProposalEventBody) {
  if (isAddProposal(body) || isNewDocumentProposal(body)) {
    return documentLead(state, { id, atom: id, target: body.target });
  }
  if (isMoveProposal(body) || isClassProposal(body)) {
    return documentLead(state, { id, atom: body.target.atom, target: { kind: 'edit' } });
  }
  return 'atom' in body
    ? documentLead(state, { id, atom: body.atom, target: { kind: 'edit' } })
    : null;
}

/** A waiting reconcile Proposal's coalition, as its card set it: no other group is named yet (#114). */
function waitingReconcile(body: ProposalEventBody): ReconcileView | null {
  if (!isReconcileProposal(body)) return null;
  const { name, title, atoms } = body.target;
  return { name, title, atoms, others: null };
}

/** A Proposal this device made that the relay hasn't ordered yet: no deadline, no ballot. */
function Waiting({ state, me, id, body, pending, reachable }: WaitingProps) {
  const { comparison, versions, optIn } = waitingVersions(state, me, body);
  return (
    <Screen state={state}>
      <PageHeader
        eyebrow={messages.proposal.eyebrowNew}
        title={body.title}
        pageTitle={messages.proposal.pageTitle}
      >
        <DocumentLine lead={waitingLead(state, id, body)} groupId={state.group ?? ''} />
      </PageHeader>
      <Why why={body.why} />
      <ReconcileStatement view={waitingReconcile(body)} />
      <Block title={comparison.title} className="vote">
        <OptInWarning optIn={optIn} />
        <Legend comparison={comparison} />
        {comparison === OPTIONS ? (
          <OptionList options={versions} />
        ) : (
          <VersionList versions={versions} current={comparison.current} />
        )}
      </Block>
      <SendStatus pending={pending} reachable={reachable} sent />
    </Screen>
  );
}

/** This device's Proposal `id` while it waits in the outbox, remembered once it has left. */
function useWaitingProposal(pending: readonly ParsedEvent[], id: string) {
  const event = pending.find((candidate) => candidate.id === id)?.event;
  const body = event?.type === 'proposal' ? event.body : null;
  const [last, setLast] = useState<{ id: string; body: ProposalEventBody } | null>(null);
  if (body !== null && last?.body !== body) setLast({ id, body });
  const remembered = last?.id === id ? last.body : null;
  return { body: body ?? remembered, pending: body !== null };
}

/**
 * The Proposal and its ballot (`#/g/{groupId}/p/{proposalId}`; spec §8): its
 * number over the title (#123), the why, a countdown, Join discussion (its
 * Discord thread once the log holds one), then every version side by
 * side, each a word diff of the section's source with its own score pills,
 * and Add your version while the ballot has room. Who may vote, and whether
 * voting is still open, come from engine state and `can()`, never from level
 * names. While it's open, each version has a consent meter. Once it closes,
 * the result comes first: the outcome sentence, totals and ballots.
 */
export function ProposalView(props: ProposalViewProps) {
  const { state, proposalId, pending, reachable } = props;
  const proposal = state.proposals.find((candidate) => candidate.id === proposalId);
  const waiting = useWaitingProposal(pending, proposalId);
  if (proposal !== undefined) return <Folded props={props} proposal={proposal} />;
  if (waiting.body !== null) {
    return (
      <Waiting
        state={state}
        me={props.me}
        id={proposalId}
        body={waiting.body}
        pending={waiting.pending}
        reachable={reachable}
      />
    );
  }
  return (
    <Screen state={state}>
      <PageHeader title={messages.proposal.missingTitle} pageTitle={messages.proposal.pageTitle} />
      <p className="lede">{messages.proposal.missing}</p>
    </Screen>
  );
}
