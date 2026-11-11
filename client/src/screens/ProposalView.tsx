import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-aria-components';

import { Ballot, type Scores } from '../app/Ballot';
import { ChatLink } from '../app/ChatLink';
import { type ChatDetails, type ChatMoment, openMoment } from '../app/chatMessages';
import { Countdown } from '../app/Countdown';
import { DocumentLine } from '../app/DocumentLine';
import { documentLead, sectionPlace } from '../app/documentLines';
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
import { Named, SuspendedNote } from '../app/stewards';
import {
  dissolveView,
  stewardView,
  versionDoes,
  type VersionView,
  versionViews,
} from '../app/versionViews';
import { rightsAt } from '../engine/admission';
import { can, holdsRights, isSuspended } from '../engine/capabilities';
import { threadFor } from '../engine/chatPosts';
import { composeOption } from '../engine/composeOption';
import { closedByDissolve } from '../engine/dissolve';
import {
  isAddProposal,
  isDissolveProposal,
  isNewDocumentProposal,
  isPriorityProposal,
  isReconcileProposal,
  isRulesProposal,
  isStewardProposal,
  type ParsedEvent,
  type ProposalEventBody,
  type RulesProposalBody,
  type StewardProposalBody,
} from '../engine/event';
import { type GroupState, type Proposal, proposalTally } from '../engine/fold';
import { displayName } from '../engine/names';
import { isNarrowed, type OptIn, rulesChange, rulesChangeOf } from '../engine/optIns';
import type { OwnBallot } from '../engine/ownBallot';
import { isPriority, optionId } from '../engine/priority';
import { isSeatNumber, seatAt, stewardChangeOf } from '../engine/stewards';
import type { TallyDetail } from '../engine/tally';
import { ConsentMeter } from './ConsentMeter';
import { ResultView } from './ResultView';

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
  /**
   * Once a dissolved group's ballots are cleared on this device (#108): when,
   * and each decided Proposal's tally as the device kept it, by id.
   */
  readonly cleared?: {
    readonly at: number;
    readonly tallies: Readonly<Record<string, TallyDetail>>;
  };
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
 * nothing for a steward one, or for a priority vote, its options as they are
 * (#107).
 */
function comparisonOf(state: GroupState, proposal: Proposal, passed: boolean): Comparison {
  if (isPriority(proposal)) return OPTIONS;
  return writesText(proposal)
    ? comparisonFor(state, changedAtom(proposal), passed, addingTitle(proposal))
    : STEWARD_BALLOT;
}

/** A rules ballot opens with its opt-in's warning: what the outside platform would hold (#117). */
function OptInWarning({ optIn }: { readonly optIn: OptIn | null }) {
  return optIn === null ? null : (
    <p className="opt-in-warning">{messages.optIns.warnings[optIn]}</p>
  );
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
 * Outside its eligible set, they joined after it opened, hadn't earned a vote
 * yet when it opened (#101), weren't at a voting level then, or are the
 * steward it would recall (#102). Inside it, they get the ballot, unchangeable once voting
 * has closed; while it's open, they need a level that votes now, and choosing
 * one gives them the ballot back.
 */
function whyNoVote(props: ProposalViewProps, proposal: Proposal): string | null {
  const { state, me } = props;
  if (props.leaving === true) return messages.leave.noVoting;
  if (proposal.eligible.includes(me)) return whyEligibleCantVote(props, proposal);
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

/** True while the vote takes ballots and versions, as far as this device can tell. */
function isOpen(props: ProposalViewProps, proposal: Proposal): boolean {
  return !proposal.final && props.now < proposal.deadline;
}

/** Whether this member can still add wording: the vote is open, they may propose, and they're staying. */
function isOpenToVersions(props: ProposalViewProps, proposal: Proposal): boolean {
  return isOpen(props, proposal) && props.leaving !== true && can(props.state, props.me, 'propose');
}

/**
 * Tell your group (#113), for everyone while the vote is open and they're
 * staying: the open message, or the version line for someone who added a
 * version, then the closing message from a day before the deadline. Only a
 * folded Proposal has a deadline to share. Each moment starts a fresh,
 * unticked Include the title.
 */
function Tell({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  if (!isOpen(props, proposal) || props.leaving === true) return null;
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
function Vote({ props, proposal, versions }: VoteProps) {
  const { state, me, now, reachable, onVote } = props;
  const passed = proposal.final && proposal.outcome.kind === 'pass';
  const comparison = comparisonOf(state, proposal, passed);
  const layout = layoutOf(comparison);
  const reason = whyNoVote(props, proposal);
  const closed = proposal.final || now >= proposal.deadline;
  const suspended = isSuspended(state, me);
  const mine = myBallot(props, proposal);
  const meters = metersFor(proposal);
  return (
    <Block title={comparison.title} className="vote">
      <OptInWarning optIn={rulesChangeOf(proposal)?.optIn ?? null} />
      <NarrowedNote state={state} proposal={proposal} />
      <Legend comparison={comparison} open={!proposal.final} />
      {ballotShown(reason, proposal) ? (
        <Ballot
          key={proposal.id}
          versions={versions}
          current={comparison.current}
          initialScores={mine.scores}
          initialNote={mine.note}
          hasVoted={mine.hasVoted}
          isDisabled={closed || suspended}
          pending={mine.pending}
          reachable={reachable}
          onVote={onVote}
          below={meters}
          layout={layout}
          disabledNote={closed || !suspended ? undefined : <SuspendedNote state={state} me={me} />}
        />
      ) : (
        <>
          <ChoiceList versions={versions} current={comparison.current} layout={layout}>
            {meters}
          </ChoiceList>
          {reason === null ? null : (
            <NoVote state={state} me={me} reason={reason} leaving={props.leaving === true} />
          )}
        </>
      )}
      <AddVersion props={props} proposal={proposal} />
    </Block>
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
function Byline({ state, proposal, now }: { state: GroupState; proposal: Proposal; now: number }) {
  const name = displayName(state, proposal.author) ?? '';
  const open = !proposal.final && now < proposal.deadline;
  return (
    <div className="meta-lines">
      <p className="meta">
        {messages.proposal.proposedBy} <bdi>{name}</bdi>
      </p>
      <p className="meta">
        <Countdown deadline={proposal.deadline} closedAt={proposal.closedAt} now={now} />
      </p>
      {open ? <p className="meta">{messages.window.runs(proposal.window)}</p> : null}
    </div>
  );
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
function eyebrowOf(proposal: Proposal, closed: boolean): string {
  const words = messages.proposal;
  if (isPriority(proposal)) {
    return (closed ? words.eyebrowPriorityClosed : words.eyebrowPriority)(proposal.number);
  }
  return (closed ? words.eyebrowClosed : words.eyebrowOpen)(proposal.number);
}

/**
 * A Proposal still open when its group dissolved (#108): closed, with no
 * outcome and no ballot, its versions, or a priority vote's options (#107),
 * as they stood.
 */
function ClosedByDissolve({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state } = props;
  const versions = versionViews(state, proposal);
  const comparison = comparisonOf(state, proposal, false);
  return (
    <Screen state={state} wide={versions.length > 1}>
      <PageHeader
        eyebrow={eyebrowOf(proposal, true)}
        title={proposal.title}
        pageTitle={messages.proposal.pageTitle}
      />
      <DocumentLine lead={documentLead(state, proposal)} groupId={state.group ?? ''} />
      <div className="stack">
        <div className="meta-lines">
          <p className="meta">
            {messages.proposal.proposedBy} <bdi>{displayName(state, proposal.author) ?? ''}</bdi>
          </p>
          <p className="meta">{messages.archive.closed}</p>
        </div>
        <p className="lede" dir="auto">
          {proposal.why}
        </p>
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
  const { dispatch } = proposal;
  if (dispatch === null || proposal.final) return null;
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

/** A Proposal the relay has ordered: open with its ballot, or closed with its outcome first. */
function Folded({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state, now } = props;
  if (closedByDissolve(state, proposal))
    return <ClosedByDissolve props={props} proposal={proposal} />;
  const versions = versionViews(state, proposal);
  return (
    <Screen state={state} wide={versions.length > 1}>
      <PageHeader
        eyebrow={eyebrowOf(proposal, proposal.final)}
        title={proposal.title}
        pageTitle={messages.proposal.pageTitle}
      />
      <DocumentLine lead={documentLead(state, proposal)} groupId={state.group ?? ''} />
      {proposal.final ? (
        <ResultView
          state={state}
          proposal={proposal}
          me={props.me}
          own={props.own}
          onProposeAgain={props.onProposeAgain}
          onTell={props.onTell}
          leaving={props.leaving === true || state.dissolved !== null}
          {...clearedOf(props, proposal)}
        />
      ) : null}
      <div className="stack">
        <Byline state={state} proposal={proposal} now={now} />
        <p className="lede" dir="auto">
          {proposal.why}
        </p>
      </div>
      <CarriedDispatch proposal={proposal} />
      <ChatLink href={discussionLink(state, proposal)} />
      <Tell props={props} proposal={proposal} />
      <Vote props={props} proposal={proposal} versions={versions} />
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
 * How a waiting Proposal's versions show: its text against the section, what
 * its ballot decides, or a priority vote's options (#107).
 */
function waitingVersions(state: GroupState, me: string, body: ProposalEventBody) {
  const author = displayName(state, me) ?? '';
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
  // A reconcile Proposal (#100) changes no section; #114 gives it its card.
  if (isReconcileProposal(body)) {
    return {
      comparison: STEWARD_BALLOT,
      versions: [{ id: '', number: 1, author, text: '' }],
      optIn: null,
    };
  }
  // An add's or a new Document's whole text shows as added, and an add says where it goes
  // (#75, #92); a removal says so too.
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
  return 'atom' in body
    ? documentLead(state, { id, atom: body.atom, target: { kind: 'edit' } })
    : null;
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
      />
      <DocumentLine lead={waitingLead(state, id, body)} groupId={state.group ?? ''} />
      <p className="lede" dir="auto">
        {body.why}
      </p>
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
