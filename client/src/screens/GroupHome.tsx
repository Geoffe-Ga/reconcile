import { type ReactNode, useId, useState } from 'react';
import { Button, Link, VisuallyHidden } from 'react-aria-components';

import { ChatLink } from '../app/ChatLink';
import { Countdown } from '../app/Countdown';
import { latestLink } from '../app/latestLink';
import { LeaveDialog } from '../app/LeaveDialog';
import { LevelPicker } from '../app/LevelPicker';
import { levelName } from '../app/levels';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { RulesLink } from '../app/RulesLink';
import { SendStatus } from '../app/SendStatus';
import { formatDay } from '../app/format';
import { StewardSeats } from '../app/StewardSeats';
import { SuspendedNote } from '../app/stewards';
import { SuspendDialog } from '../app/SuspendDialog';
import { formatMinute, formatSyncedAt, minuteIso } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useSaving } from '../app/useSaving';
import { can, isLevel, isSuspended, type Level } from '../engine/capabilities';
import type { ParsedEvent } from '../engine/event';
import { closeTime, type GroupState, type Member, type Proposal } from '../engine/fold';
import { homeLists } from '../engine/home';
import { displayName } from '../engine/names';
import { isPriority, openPriority } from '../engine/priority';
import { activeSuspension, maySuspend, seatOf, type Suspension } from '../engine/stewards';

/** Props for {@link GroupHome}. */
export interface GroupHomeProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /**
   * Copy invite link's work: posts a fresh invite envelope and resolves to
   * its link, or rejects when the relay can't be reached (#73).
   */
  readonly makeInviteLink: () => Promise<string>;
  /** Puts text, or text still on its way, on the clipboard; rejects when that fails. */
  readonly copyText: (text: string | Promise<string>) => Promise<void>;
  /** The relay's minute now, as this device estimates it, for the countdowns. */
  readonly now: number;
  /** How syncing is going. */
  readonly sync: SyncStatus;
  /** This device's events the relay hasn't accepted yet, oldest first. */
  readonly pending: readonly ParsedEvent[];
  /** Queues this member's move to another level; rejects when it couldn't be saved. */
  readonly onChooseLevel: (level: Level) => Promise<void>;
  /** Queues this steward's suspension of the member named, with a reason, blank for none (#102). */
  readonly onSuspend: (member: string, reason: string) => Promise<void>;
  /** Queues this member's leave and marks the group as leaving; rejects when it couldn't be saved. */
  readonly onLeave: () => Promise<void>;
  /** Whether this device's leave waits for the relay (#77): the group reads, but takes no votes. */
  readonly leaving?: boolean;
}

/** Whether the relay answers, and when this device last synced. */
export interface SyncStatus {
  /** Whether the last sync pass reached the relay. */
  readonly reachable: boolean;
  /** When the last sync succeeded, in device milliseconds, or null before one. */
  readonly lastSyncAt: number | null;
  /** The device clock now, in milliseconds. */
  readonly deviceNow: number;
  /** Whether a long gap between syncs may have lost some history (#73). */
  readonly missingHistory: boolean;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const heading = useId();
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface ProposalCardsProps {
  readonly groupId: string;
  readonly proposals: readonly Proposal[];
  readonly now: number;
}

/** Open Proposals as cards, each with its title and countdown, opening its ballot. */
function ProposalCards({ groupId, proposals, now }: ProposalCardsProps) {
  return (
    <ul className="card-list">
      {proposals.map((proposal) => (
        <li key={proposal.id}>
          <Link
            className="card-link"
            href={routeHref({ name: 'proposal', groupId, proposalId: proposal.id })}
          >
            <span className="card-link-title">
              <span className="heading-3">
                <bdi>{proposal.title}</bdi>
              </span>
              <span className="card-link-arrow" aria-hidden="true">
                {messages.app.forward}
              </span>
            </span>
            <span className="meta">
              <Countdown deadline={proposal.deadline} closedAt={proposal.closedAt} now={now} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

interface OpenListsProps {
  readonly groupId: string;
  /** What goes right under Needs your vote: the current focus (#107). */
  readonly children?: ReactNode;
  /** What waits on this person; nothing while they're leaving. */
  readonly needsYourVote: readonly Proposal[];
  /** The other open Proposals, or every open one while they're leaving. */
  readonly otherOpen: readonly Proposal[];
  readonly now: number;
}

/**
 * 'Needs your vote', when anything waits on this person, then the other open
 * Proposals: "Open Proposals", or "Other open Proposals" after it. With none
 * open, one line says so.
 */
function OpenLists({ groupId, needsYourVote, otherOpen, now, children }: OpenListsProps) {
  const { home } = messages;
  const waits = needsYourVote.length > 0;
  return (
    <>
      {waits ? (
        <Section title={home.needsYourVote}>
          <ProposalCards groupId={groupId} proposals={needsYourVote} now={now} />
        </Section>
      ) : null}
      {children}
      {otherOpen.length > 0 ? (
        <Section title={waits ? home.otherOpen : home.openProposals}>
          <ProposalCards groupId={groupId} proposals={otherOpen} now={now} />
        </Section>
      ) : null}
      {waits || otherOpen.length > 0 ? null : (
        <Section title={home.openProposals}>
          <p>{home.noProposals}</p>
        </Section>
      )}
    </>
  );
}

/** A closed priority vote's top option once it passed, else null (#107). */
function topOption(proposal: Proposal): string | null {
  if (!isPriority(proposal) || proposal.outcome.kind !== 'pass') return null;
  const winner = proposal.outcome.version;
  return proposal.versions.find((version) => version.id === winner)?.text ?? null;
}

/** A passed priority vote's top option, on its Decided card. */
function TopOption({ proposal }: { readonly proposal: Proposal }) {
  const top = topOption(proposal);
  return top === null ? null : (
    <span className="card-link-focus">
      <bdi>{top}</bdi>
    </span>
  );
}

/**
 * Decided: the group's history, each closed Proposal with its title, its
 * outcome in a word, and its close date, opening its result. A priority
 * vote that passed also names its top option (#107).
 */
function Decided({
  groupId,
  closed,
}: {
  readonly groupId: string;
  readonly closed: readonly Proposal[];
}) {
  if (closed.length === 0) return <p>{messages.decided.empty}</p>;
  return (
    <ul className="card-list">
      {closed.map((proposal) => (
        <li key={proposal.id}>
          <Link
            className="card-link"
            href={routeHref({ name: 'proposal', groupId, proposalId: proposal.id })}
          >
            <span className="card-link-title">
              <span className="heading-3">
                <bdi>{proposal.title}</bdi>
              </span>
              <span className="card-link-arrow" aria-hidden="true">
                {messages.app.forward}
              </span>
            </span>
            <TopOption proposal={proposal} />
            <span className="meta countdown">
              <span>{messages.decided.outcomes[proposal.outcome.kind]}</span>
              <time dateTime={minuteIso(closeTime(proposal))}>
                {formatDay(closeTime(proposal))}
              </time>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

interface FocusProps {
  readonly state: GroupState;
  readonly me: string;
  readonly leaving: boolean;
}

/**
 * The group's current focus (#107): the top option of the latest priority
 * vote to pass, opening its result, or a sentence before there is one. Those
 * who can propose may ask what to focus on while no priority vote is open,
 * unless they're leaving.
 */
function Focus({ state, me, leaving }: FocusProps) {
  const groupId = state.group ?? '';
  const { focus } = state;
  const canAsk = !leaving && can(state, me, 'propose') && openPriority(state) === undefined;
  return (
    <Section title={messages.home.focus}>
      <div className="stack">
        {focus === null ? (
          <p>{messages.home.noFocus}</p>
        ) : (
          <Link
            className="card-link"
            href={routeHref({ name: 'proposal', groupId, proposalId: focus.proposal })}
          >
            <span className="eyebrow">{messages.home.currentFocus}</span>
            <span className="card-link-title">
              <span className="heading-3">
                <bdi>{focus.text}</bdi>
              </span>
              <span className="card-link-arrow" aria-hidden="true">
                {messages.app.forward}
              </span>
            </span>
          </Link>
        )}
        {canAsk ? (
          <div>
            <Link
              className="button button-secondary"
              href={routeHref({ name: 'priority', groupId })}
            >
              {messages.home.askFocus}
            </Link>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * "Can't reach the relay right now", and the catch-up line while some history
 * may be missing, in a live region that is always there.
 */
function SyncNotices({ sync }: { readonly sync: SyncStatus }) {
  const { reachable, lastSyncAt, deviceNow, missingHistory } = sync;
  const line =
    lastSyncAt === null
      ? messages.home.unreachable
      : messages.home.unreachableSince(formatSyncedAt(lastSyncAt, deviceNow));
  return (
    <div role="status">
      {reachable ? null : <p className="notice">{line}</p>}
      {missingHistory ? <p className="notice">{messages.home.missingHistory}</p> : null}
    </div>
  );
}

/** "invited by <name>", read after a comma, once a verified token names the inviter (#73). */
function InvitedBy({ state, inviter }: { readonly state: GroupState; readonly inviter: string }) {
  const name = displayName(state, inviter);
  if (name === null) return null;
  return (
    <span className="person-invited">
      <VisuallyHidden>{messages.home.invitedBySeparator}</VisuallyHidden> {messages.home.invitedBy}{' '}
      <bdi>{name}</bdi>
    </span>
  );
}

/** "Suspended until <date>.", and the steward's reason as plain text, on the suspended person's row. */
function SuspensionLine({ suspension }: { readonly suspension: Suspension }) {
  return (
    <div className="person-suspension">
      <p>{messages.stewards.suspendedUntil(formatMinute(suspension.until))}</p>
      {suspension.reason === null || suspension.reason.trim() === '' ? null : (
        <p className="person-reason">
          {messages.stewards.reasonPrefix} <span dir="auto">{suspension.reason}</span>
        </p>
      )}
    </div>
  );
}

interface PersonProps {
  readonly props: GroupHomeProps;
  readonly member: Member;
  /** The member this device's `suspend` in the outbox names, if one waits. */
  readonly suspending: string | undefined;
}

/**
 * One person: their name and who invited them (#73), level and Steward
 * badge, any running suspension, and Suspend when this member may suspend
 * them now, has none waiting to send and isn't leaving (stewards.ts decides,
 * as the fold does).
 */
function Person({ props, member, suspending }: PersonProps) {
  const { state, me, sync, onSuspend } = props;
  const { author } = member;
  const name = displayName(state, author) ?? '';
  const suspension = activeSuspension(state, author);
  // Nothing more is queued once this member's leave waits for the relay (#77).
  const offered =
    props.leaving !== true && suspending === undefined && maySuspend(state, me, author);
  return (
    <li className="person">
      <span className="person-who">
        <bdi className="person-name">{name}</bdi>
        {member.invitedBy === null ? null : <InvitedBy state={state} inviter={member.invitedBy} />}
      </span>
      <span className="person-tags">
        <VisuallyHidden>{messages.home.levelSeparator}</VisuallyHidden>{' '}
        <span className="person-level">{levelName(member.level)}</span>
        {seatOf(state, author) === undefined ? null : (
          <>
            <VisuallyHidden>{messages.stewards.badgeSeparator}</VisuallyHidden>{' '}
            <span className="badge">{messages.stewards.badge}</span>
          </>
        )}
        {offered ? (
          <SuspendDialog
            name={name}
            days={state.rules.suspensionDays}
            onSuspend={(reason) => onSuspend(author, reason)}
          />
        ) : null}
      </span>
      {suspension === undefined ? null : <SuspensionLine suspension={suspension} />}
      {suspending === author ? (
        <div className="person-status">
          <SendStatus pending reachable={sync.reachable} sent={false} />
        </div>
      ) : null}
    </li>
  );
}

/** Whom this member's `suspend` still in the outbox names, if one waits. */
function waitingSuspend(me: string, pending: readonly ParsedEvent[]): string | undefined {
  return pending
    .flatMap(({ event }) =>
      event.type === 'suspend' && event.author === me ? [event.body.member] : [],
    )
    .at(-1);
}

/**
 * Everyone in the group, each with who invited them, the level they chose and
 * any steward seat or suspension (ADR-0074: every level sees it; ADR-0016: everyone sees a
 * suspension).
 */
function People(props: GroupHomeProps) {
  const suspending = waitingSuspend(props.me, props.pending);
  return (
    <ul className="people">
      {props.state.members.map((member) => (
        <Person key={member.author} props={props} member={member} suspending={suspending} />
      ))}
    </ul>
  );
}

/** The level `me` last chose that's still in the outbox, or undefined when none waits. */
function waitingLevel(me: string, pending: readonly ParsedEvent[]): Level | undefined {
  return pending
    .flatMap(({ event }) =>
      event.type === 'level' && event.author === me && isLevel(event.body.level)
        ? [event.body.level]
        : [],
    )
    .at(-1);
}

interface InvolvementProps {
  readonly current: Level;
  readonly waiting: boolean;
  readonly reachable: boolean;
  /** True while a suspension runs: the fold ignores a suspended member's level change. */
  readonly suspended: boolean;
  readonly onChooseLevel: GroupHomeProps['onChooseLevel'];
}

/**
 * "Your involvement": the level picker, and Save once the choice differs from
 * the level held. Saving queues one `level` event; the People list shows the
 * new level once the relay returns it (ADR-0021: self-selected).
 */
function Involvement(props: InvolvementProps) {
  const { current, waiting, reachable, suspended, onChooseLevel } = props;
  const [choice, setChoice] = useState<Level | null>(null);
  const { run, running, outcome } = useSaving(onChooseLevel);
  const picked = choice ?? current;
  const save = () => {
    void run(picked).then((saved) => {
      if (saved) setChoice(null);
    });
  };
  return (
    <div className="involvement">
      <LevelPicker value={picked} onChange={setChoice} isDisabled={running || suspended} />
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {messages.levels.failed}
        </p>
      ) : null}
      <div className="row">
        {picked === current ? null : (
          <Button className="button button-secondary" onPress={save} isDisabled={running}>
            {messages.levels.save}
          </Button>
        )}
        <SendStatus pending={waiting} reachable={reachable} sent={outcome === 'sent'} />
      </div>
    </div>
  );
}

/**
 * The People list, the group's current members, then this member's own
 * involvement and Leave this group under it. While they're leaving, neither
 * shows: the leave already waits in the outbox.
 */
function PeopleSection(props: GroupHomeProps) {
  const { state, me, pending, sync, onChooseLevel, onLeave, leaving = false } = props;
  // Nobody chooses a level, or leaves, before the relay has returned their join.
  const mine = leaving ? undefined : state.members.find((member) => member.author === me);
  const waiting = waitingLevel(me, pending);
  return (
    <Section title={messages.home.people}>
      <div className="stack people-stack">
        <People {...props} />
        {mine === undefined ? null : (
          <>
            <Involvement
              current={waiting ?? mine.level}
              waiting={waiting !== undefined}
              reachable={sync.reachable}
              suspended={isSuspended(state, me)}
              onChooseLevel={onChooseLevel}
            />
            <div>
              <LeaveDialog onLeave={onLeave} />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

/** "Leaving…", and what that means, while this device's leave waits for the relay. */
function LeavingNote() {
  return (
    <div className="leaving-note">
      <p className="eyebrow">{messages.leave.leaving}</p>
      <p>{messages.leave.leavingNote}</p>
    </div>
  );
}

/** Where Copy invite link has got to. */
type InviteStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'made'; readonly link: string; readonly copied: boolean };

/** The status line for each step. */
function statusLine(status: InviteStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'making':
      return messages.home.making;
    case 'failed':
      return messages.home.makeFailed;
    case 'made':
      return status.copied ? messages.home.copied : messages.home.copyFailed;
  }
}

interface InviteProps {
  readonly makeInviteLink: GroupHomeProps['makeInviteLink'];
  readonly copyText: GroupHomeProps['copyText'];
}

/**
 * Copy invite link, with spec §9's warning beside it. Each press makes a new
 * link: the clipboard write starts at the press and waits for the link, and
 * the link appears only once the relay holds the whole envelope. When making
 * it fails, nothing is copied and the line says so.
 */
function Invite({ makeInviteLink, copyText }: InviteProps) {
  const [status, setStatus] = useState<InviteStatus>({ kind: 'idle' });
  const warning = useId();
  const making = status.kind === 'making';
  const copy = () => {
    if (making) return;
    setStatus({ kind: 'making' });
    const link = makeInviteLink();
    const copied = copyText(link);
    link.then(
      (made) => {
        copied.then(
          () => {
            setStatus({ kind: 'made', link: made, copied: true });
          },
          () => {
            setStatus({ kind: 'made', link: made, copied: false });
          },
        );
      },
      () => {
        copied.catch(() => undefined);
        setStatus({ kind: 'failed' });
      },
    );
  };
  return (
    <div className="stack">
      <p id={warning} className="lede">
        {messages.home.inviteWarning}
      </p>
      <Button className="button button-primary" onPress={copy} aria-describedby={warning}>
        {messages.home.copyInvite}
      </Button>
      <div className="field-status">
        {status.kind === 'made' ? (
          <Field
            label={messages.home.inviteField}
            value={status.link}
            isReadOnly
            inputClassName="input-link"
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        ) : null}
        <p role="status" className="status">
          {statusLine(status)}
        </p>
      </div>
    </div>
  );
}

/**
 * People, the Stewards (#102) and the invite, each for whoever may see it.
 * While this member's leave waits for the relay, there's no invite.
 */
function MemberSections(props: GroupHomeProps) {
  const { state, me, makeInviteLink, copyText, leaving = false } = props;
  const roster = can(state, me, 'see-roster');
  return (
    <>
      {roster ? <PeopleSection {...props} /> : null}
      {roster ? (
        <Section title={messages.stewards.heading}>
          <StewardSeats state={state} me={me} leaving={leaving} />
        </Section>
      ) : null}
      <Section title={messages.optIns.homeHeading}>
        <RulesLink state={state} />
      </Section>
      {can(state, me, 'invite') && !leaving ? (
        <Section title={messages.home.invite}>
          <Invite makeInviteLink={makeInviteLink} copyText={copyText} />
        </Section>
      ) : null}
    </>
  );
}

/**
 * Group home (`#/g/{groupId}`; spec §8), in order: Needs your vote (#77), the
 * group's current focus (#107), the other open Proposals, the group's Document, the Decided list of closed ones,
 * its people with their levels, the viewer's own involvement and Leave this
 * group, the Stewards (#102), the Rules (#117), then its invite link and its discussion, each shown only to members
 * whose capabilities allow it (`can()` is the only check). While the viewer's
 * leave waits for the relay, it says so, lists every open Proposal together,
 * and offers no level choice, invite or Leave.
 */
export function GroupHome(props: GroupHomeProps) {
  const { state, me, now, sync, leaving = false } = props;
  const groupId = state.group ?? '';
  const discussion = latestLink(state);
  const lists = homeLists(state, me, now);
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <div className="page-top">
        <PageHeader
          eyebrow={messages.home.eyebrow}
          title={state.name}
          pageTitle={messages.home.pageTitle}
        />
        <SyncNotices sync={sync} />
        {leaving ? <LeavingNote /> : null}
      </div>
      <SuspendedNote state={state} me={me} />
      <div className="sections">
        <OpenLists
          groupId={groupId}
          needsYourVote={leaving ? [] : lists.needsYourVote}
          otherOpen={leaving ? lists.open : lists.otherOpen}
          now={now}
        >
          <Focus state={state} me={me} leaving={leaving} />
        </OpenLists>
        <Section title={messages.home.documentLabel}>
          <Link className="card-link" href={routeHref({ name: 'document', groupId })}>
            <span className="card-link-title">
              <span className="heading-2">
                <bdi>{state.title}</bdi>
              </span>
              <span className="card-link-arrow" aria-hidden="true">
                {messages.app.forward}
              </span>
            </span>
          </Link>
        </Section>
        <Section title={messages.decided.title}>
          <Decided groupId={groupId} closed={lists.decided} />
        </Section>
        <MemberSections {...props} />
        {discussion === null ? null : (
          <Section title={messages.home.discussion}>
            <div>
              <ChatLink href={discussion} />
            </div>
          </Section>
        )}
      </div>
    </main>
  );
}
