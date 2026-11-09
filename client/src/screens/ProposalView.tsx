import { type ReactNode, useId, useState } from 'react';

import { Ballot } from '../app/Ballot';
import { ChatLink } from '../app/ChatLink';
import { Countdown } from '../app/Countdown';
import { latestLink } from '../app/latestLink';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { SendStatus } from '../app/SendStatus';
import { BackLink, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import type { ParsedEvent, ProposalBody, Score } from '../engine/event';
import type { GroupState, Proposal } from '../engine/fold';

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

/** One wording of a section, set in the document style. */
function AtomCard({
  text,
  current = false,
}: {
  readonly text: string;
  readonly current?: boolean;
}) {
  const className = current ? 'atom-text atom-card atom-card-current' : 'atom-text atom-card';
  return (
    <p className={className} dir="auto">
      {text}
    </p>
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
        <AtomCard text={text} />
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

/** The section as it reads now, above the proposed text. */
function Texts({ state, proposal }: { readonly state: GroupState; readonly proposal: Proposal }) {
  const index = state.atoms.findIndex((atom) => atom.id === proposal.atom);
  const atom = state.atoms[index];
  return (
    <div className="texts">
      {atom === undefined ? null : (
        <Block title={messages.proposal.current(index + 1)} className="text-block">
          <AtomCard text={atom.text} current />
        </Block>
      )}
      <Block title={messages.proposal.proposed} className="text-block">
        <AtomCard text={proposal.text} />
      </Block>
    </div>
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

function Vote({ props, proposal }: { props: ProposalViewProps; proposal: Proposal }) {
  const { state, me, now, reachable, onVote } = props;
  const eligible = proposal.eligible.includes(me) && can(state, me, 'vote');
  const mine = myBallot(props, proposal);
  return (
    <Block title={messages.ballot.heading} className="vote">
      {eligible ? (
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
        <p className="lede">{messages.proposal.notEligible}</p>
      )}
    </Block>
  );
}

/** Who proposed it, then the countdown, each on its own line so neither breaks mid-phrase. */
function Byline({ state, proposal, now }: { state: GroupState; proposal: Proposal; now: number }) {
  const name = state.members.find((member) => member.author === proposal.author)?.name ?? '';
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
      {passed ? null : <Texts state={state} proposal={proposal} />}
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
      <Block title={messages.proposal.proposed} className="text-block">
        <AtomCard text={body.text} />
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
 * title and why, the section's text now and as proposed, a countdown, Join
 * discussion, and the ballot. Who may vote, and whether voting is still open,
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
