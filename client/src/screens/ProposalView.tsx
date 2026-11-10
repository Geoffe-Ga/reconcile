import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-aria-components';

import { Ballot, type Scores } from '../app/Ballot';
import { ChatLink } from '../app/ChatLink';
import { Countdown } from '../app/Countdown';
import { latestLink } from '../app/latestLink';
import { ChangeInvolvement } from '../app/LevelPicker';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { SendStatus } from '../app/SendStatus';
import { AtomText } from '../app/text/AtomText';
import { WordDiff } from '../app/text/WordDiff';
import { BackLink, PageHeader } from '../app/ui';
import { VersionList } from '../app/Versions';
import { type VersionView, versionViews } from '../app/versionViews';
import { can } from '../engine/capabilities';
import { composeOption } from '../engine/composeOption';
import type { ParsedEvent, ProposalBody } from '../engine/event';
import { type GroupState, type Proposal, proposalTally } from '../engine/fold';
import { displayName } from '../engine/names';
import type { OwnBallot } from '../engine/ownBallot';
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

/**
 * Each version is a word diff against the section's text now. Once a pass has
 * changed the section, or when the section is gone, each version shows as it
 * reads instead.
 */
function comparisonFor(state: GroupState, atom: string, passed: boolean): Comparison {
  if (passed) return { title: messages.proposal.onBallot, current: null };
  const index = state.atoms.findIndex((candidate) => candidate.id === atom);
  const now = state.atoms[index];
  if (now === undefined) return { title: messages.proposal.proposed, current: null };
  return { title: messages.proposal.changes(index + 1), current: now.text };
}

/** The diff legend, under the heading, whenever the versions show as diffs. */
function Legend({ comparison }: { readonly comparison: Comparison }) {
  return comparison.current === null ? null : <p className="caption">{messages.diff.legend}</p>;
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
 * Why `me` gets no ballot on `proposal`, or null when they get one (#166).
 * Outside its eligible set, they either joined after it opened or weren't at a
 * voting level then. Inside it, they get the ballot, unchangeable once voting
 * has closed; while it's open, they need a level that votes now, and choosing
 * one gives them the ballot back.
 */
function whyNoVote(props: ProposalViewProps, proposal: Proposal): string | null {
  const { state, me, now } = props;
  if (proposal.eligible.includes(me)) {
    const closed = proposal.final || now >= proposal.deadline;
    return closed || can(state, me, 'vote') ? null : messages.levels.following;
  }
  const member = state.members.find((candidate) => candidate.author === me);
  return member !== undefined && member.seq < proposal.seq
    ? messages.proposal.notVotingLevel
    : messages.proposal.joinedAfter;
}

/** Why they can't vote, and where they change their level when theirs doesn't vote now. */
function NoVote({ state, me, reason }: { state: GroupState; me: string; reason: string }) {
  const levelDoesntVote = can(state, me, 'read') && !can(state, me, 'vote');
  return (
    <div className="stack">
      <p className="lede">{reason}</p>
      {levelDoesntVote ? <ChangeInvolvement groupId={state.group ?? ''} /> : null}
    </div>
  );
}

/** Whether this member can still add wording: the vote is open and they may propose. */
function isOpenToVersions(props: ProposalViewProps, proposal: Proposal): boolean {
  return !proposal.final && props.now < proposal.deadline && can(props.state, props.me, 'propose');
}

/** "Add your version", which opens the composer for this section, or why there's no room. */
function AddVersion({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  if (!isOpenToVersions(props, proposal)) return null;
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
  return function MeterFor(version) {
    const tallied = detail?.versions.find((candidate) => candidate.id === version.id);
    return detail === null || tallied === undefined ? null : (
      <ConsentMeter number={version.number} tally={tallied} bar={detail.bar} />
    );
  };
}

/** The versions, each with its own pills for someone who can vote on them, then "Add your version". */
function Vote({ props, proposal, versions }: VoteProps) {
  const { state, me, now, reachable, onVote } = props;
  const passed = proposal.final && proposal.outcome.kind === 'pass';
  const comparison = comparisonFor(state, proposal.atom, passed);
  const reason = whyNoVote(props, proposal);
  const mine = myBallot(props, proposal);
  const meters = metersFor(proposal);
  return (
    <Block title={comparison.title} className="vote">
      <Legend comparison={comparison} />
      {reason === null ? (
        <Ballot
          key={proposal.id}
          versions={versions}
          current={comparison.current}
          initialScores={mine.scores}
          initialNote={mine.note}
          hasVoted={mine.hasVoted}
          isDisabled={proposal.final || now >= proposal.deadline}
          pending={mine.pending}
          reachable={reachable}
          onVote={onVote}
          below={meters}
        />
      ) : (
        <>
          <VersionList versions={versions} current={comparison.current}>
            {meters}
          </VersionList>
          <NoVote state={state} me={me} reason={reason} />
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
  const { current } = comparisonFor(state, proposal.atom, false);
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

/** Who proposed it, then the countdown, each on its own line so neither breaks mid-phrase. */
function Byline({ state, proposal, now }: { state: GroupState; proposal: Proposal; now: number }) {
  const name = displayName(state, proposal.author) ?? '';
  return (
    <div className="meta-lines">
      <p className="meta">
        {messages.proposal.proposedBy} <bdi>{name}</bdi>
      </p>
      <p className="meta">
        <Countdown deadline={proposal.deadline} closedAt={proposal.closedAt} now={now} />
      </p>
    </div>
  );
}

/** A Proposal the relay has ordered: open with its ballot, or closed with its outcome first. */
function Folded({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state, now } = props;
  const versions = versionViews(state, proposal);
  const link =
    proposal.link !== null && isHttpLink(proposal.link) ? proposal.link : latestLink(state);
  const { eyebrowOpen, eyebrowClosed, pageTitle } = messages.proposal;
  return (
    <Screen state={state} wide={versions.length > 1}>
      <PageHeader
        eyebrow={proposal.final ? eyebrowClosed : eyebrowOpen}
        title={proposal.title}
        pageTitle={pageTitle}
      />
      {proposal.final ? (
        <ResultView
          state={state}
          proposal={proposal}
          me={props.me}
          own={props.own}
          onProposeAgain={props.onProposeAgain}
        />
      ) : null}
      <div className="stack">
        <Byline state={state} proposal={proposal} now={now} />
        <p className="lede" dir="auto">
          {proposal.why}
        </p>
      </div>
      <ChatLink href={link} />
      <Vote props={props} proposal={proposal} versions={versions} />
      <PendingVersions props={props} proposal={proposal} />
    </Screen>
  );
}

interface WaitingProps {
  readonly state: GroupState;
  readonly me: string;
  readonly body: ProposalBody;
  readonly pending: boolean;
  readonly reachable: boolean;
}

/** A Proposal this device made that the relay hasn't ordered yet: no deadline, no ballot. */
function Waiting({ state, me, body, pending, reachable }: WaitingProps) {
  const comparison = comparisonFor(state, body.atom, false);
  const version = { id: '', number: 1, author: displayName(state, me) ?? '', text: body.text };
  return (
    <Screen state={state}>
      <PageHeader
        eyebrow={messages.proposal.eyebrowNew}
        title={body.title}
        pageTitle={messages.proposal.pageTitle}
      />
      <p className="lede" dir="auto">
        {body.why}
      </p>
      <Block title={comparison.title} className="vote">
        <Legend comparison={comparison} />
        <VersionList versions={[version]} current={comparison.current} />
      </Block>
      <SendStatus pending={pending} reachable={reachable} sent />
    </Screen>
  );
}

/** This device's Proposal `id` while it waits in the outbox, remembered once it has left. */
function useWaitingProposal(pending: readonly ParsedEvent[], id: string) {
  const event = pending.find((candidate) => candidate.id === id)?.event;
  const body = event?.type === 'proposal' ? event.body : null;
  const [last, setLast] = useState<{ id: string; body: ProposalBody } | null>(null);
  if (body !== null && last?.body !== body) setLast({ id, body });
  const remembered = last?.id === id ? last.body : null;
  return { body: body ?? remembered, pending: body !== null };
}

/**
 * The Proposal and its ballot (`#/g/{groupId}/p/{proposalId}`; spec §8): the
 * title and why, a countdown, Join discussion, then every version side by
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
