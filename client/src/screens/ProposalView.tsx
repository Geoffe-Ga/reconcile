import { type ReactNode, useId, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

import { Ballot } from '../app/Ballot';
import { ChatLink } from '../app/ChatLink';
import { Countdown } from '../app/Countdown';
import { latestLink } from '../app/latestLink';
import { ChangeInvolvement } from '../app/LevelPicker';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { SendStatus } from '../app/SendStatus';
import { AtomText } from '../app/text/AtomText';
import { WordDiff } from '../app/text/WordDiff';
import { BackLink, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import type { ParsedEvent, ProposalBody, Score } from '../engine/event';
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';

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
  /** Queues this member's ballot; rejects when it couldn't be saved. */
  readonly onVote: (score: Score, note: string) => Promise<void>;
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

function Screen({ state, children }: { readonly state: GroupState; readonly children: ReactNode }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      {children}
    </main>
  );
}

/** The outcome sentence, first on a closed Proposal; a pass also shows the Document's new text. */
function Outcome({ proposal }: { readonly proposal: Proposal }) {
  const { outcome } = proposal;
  if (outcome.kind === 'pass') {
    const text = proposal.versions.find((version) => version.id === outcome.version)?.text ?? '';
    return (
      <Block title={messages.proposal.result} className="outcome">
        <p className="outcome-sentence">{messages.proposal.passed}</p>
        <AtomText text={text} className="atom-card" />
      </Block>
    );
  }
  const sentence = outcome.kind === 'fail' ? messages.proposal.failed : messages.proposal.lapsed;
  return (
    <Block title={messages.proposal.result} className="outcome">
      <p className="outcome-sentence">{sentence}</p>
    </Block>
  );
}

/** The proposed text as the Document will show it, one tap away from the diff. */
function ReadsAs({ text }: { readonly text: string }) {
  return (
    <Disclosure className="reads-as">
      <Heading level={3} className="reads-as-heading">
        <Button slot="trigger" className="reads-as-toggle">
          {messages.proposal.readsAs}
        </Button>
      </Heading>
      <DisclosurePanel>
        <AtomText text={text} className="atom-card" />
      </DisclosurePanel>
    </Disclosure>
  );
}

interface ChangesProps {
  readonly state: GroupState;
  /** The Atom the Proposal would change. */
  readonly atom: string;
  /** The proposed text. */
  readonly text: string;
}

/**
 * What a Proposal changes: a word diff of the section's source against the
 * proposed text, then the proposed text as it will read. A Proposal whose
 * section is gone shows its text alone.
 */
function Changes({ state, atom, text }: ChangesProps) {
  const index = state.atoms.findIndex((candidate) => candidate.id === atom);
  const current = state.atoms[index];
  if (current === undefined) {
    return (
      <Block title={messages.proposal.proposed} className="text-block">
        <AtomText text={text} className="atom-card" />
      </Block>
    );
  }
  return (
    <Block title={messages.proposal.changes(index + 1)} className="text-block">
      <WordDiff current={current.text} proposed={text} />
      <p className="caption">{messages.diff.legend}</p>
      <ReadsAs text={text} />
    </Block>
  );
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
    score: ballot?.scores[proposal.id] ?? null,
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

function Vote({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state, me, now, reachable, onVote } = props;
  const reason = whyNoVote(props, proposal);
  const mine = myBallot(props, proposal);
  return (
    <Block title={messages.ballot.heading} className="vote">
      {reason === null ? (
        <Ballot
          key={proposal.id}
          initialScore={mine.score}
          initialNote={mine.note}
          hasVoted={mine.hasVoted}
          isDisabled={proposal.final || now >= proposal.deadline}
          pending={mine.pending}
          reachable={reachable}
          onVote={onVote}
        />
      ) : (
        <NoVote state={state} me={me} reason={reason} />
      )}
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
  const passed = proposal.final && proposal.outcome.kind === 'pass';
  const link =
    proposal.link !== null && isHttpLink(proposal.link) ? proposal.link : latestLink(state);
  const { eyebrowOpen, eyebrowClosed, pageTitle } = messages.proposal;
  return (
    <Screen state={state}>
      <PageHeader
        eyebrow={proposal.final ? eyebrowClosed : eyebrowOpen}
        title={proposal.title}
        pageTitle={pageTitle}
      />
      {proposal.final ? <Outcome proposal={proposal} /> : null}
      <div className="stack">
        <Byline state={state} proposal={proposal} now={now} />
        <p className="lede" dir="auto">
          {proposal.why}
        </p>
      </div>
      <ChatLink href={link} />
      {passed ? null : <Changes state={state} atom={proposal.atom} text={proposal.text} />}
      <Vote props={props} proposal={proposal} />
    </Screen>
  );
}

interface WaitingProps {
  readonly state: GroupState;
  readonly body: ProposalBody;
  readonly pending: boolean;
  readonly reachable: boolean;
}

/** A Proposal this device made that the relay hasn't ordered yet: no deadline, no ballot. */
function Waiting({ state, body, pending, reachable }: WaitingProps) {
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
      <Changes state={state} atom={body.atom} text={body.text} />
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
 * title and why, a countdown, Join discussion, the change as a word diff of
 * the section's source, and the ballot. Who may vote, and whether voting is still open,
 * come from engine state and `can()`, never from level names. Once it closes,
 * the outcome sentence comes first.
 */
export function ProposalView(props: ProposalViewProps) {
  const { state, proposalId, pending, reachable } = props;
  const proposal = state.proposals.find((candidate) => candidate.id === proposalId);
  const waiting = useWaitingProposal(pending, proposalId);
  if (proposal !== undefined) return <Folded props={props} proposal={proposal} />;
  if (waiting.body !== null) {
    return (
      <Waiting state={state} body={waiting.body} pending={waiting.pending} reachable={reachable} />
    );
  }
  return (
    <Screen state={state}>
      <PageHeader title={messages.proposal.missingTitle} pageTitle={messages.proposal.pageTitle} />
      <p className="lede">{messages.proposal.missing}</p>
    </Screen>
  );
}
