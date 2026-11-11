import { type ReactNode, useId, useState } from 'react';
import { Button, Link, VisuallyHidden } from 'react-aria-components';

import { ChatLink } from '../app/ChatLink';
import { ConfirmDialog } from '../app/ConfirmDialog';
import { Countdown } from '../app/Countdown';
import { DispatchCard } from '../app/DispatchCard';
import { DocumentLine } from '../app/DocumentLine';
import { documentLead } from '../app/documentLines';
import { latestLink } from '../app/latestLink';
import { LeaveDialog } from '../app/LeaveDialog';
import { LevelPicker } from '../app/LevelPicker';
import { levelName } from '../app/levels';
import { messages } from '../app/messages';
import { NewcomerProgress, WaitingNote } from '../app/Newcomer';
import { routeHref } from '../app/router';
import { RulesLink } from '../app/RulesLink';
import { SendStatus } from '../app/SendStatus';
import { formatDay } from '../app/format';
import { StewardSeats } from '../app/StewardSeats';
import { SuspendedNote } from '../app/stewards';
import { SuspendDialog } from '../app/SuspendDialog';
import { formatDate, formatMinute, formatSyncedAt, minuteIso } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useSaving } from '../app/useSaving';
import { VouchDialog } from '../app/VouchDialog';
import { vouchWanted } from '../engine/admission';
import { can, holdsRights, isLevel, isSuspended, type Level } from '../engine/capabilities';
import { latestDispatch } from '../engine/dispatches';
import { type Dissolution, mayProposeDissolve, wipeMinute } from '../engine/dissolve';
import type { ParsedEvent } from '../engine/event';
import { closeTime, type GroupState, type Member, type Proposal } from '../engine/fold';
import { homeLists } from '../engine/home';
import { displayName } from '../engine/names';
import { isPriority, openPriority } from '../engine/priority';
import { activeSuspension, maySuspend, seatOf, type Suspension } from '../engine/stewards';
import type { KeyChange } from '../store/epochs';

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
  /** Queues this member's vouch for the newcomer named (#101); rejects when it couldn't be saved. */
  readonly onVouch: (member: string) => Promise<void>;
  /** Queues this member's leave and marks the group as leaving; rejects when it couldn't be saved. */
  readonly onLeave: () => Promise<void>;
  /** Whether this device's leave waits for the relay (#77): the group reads, but takes no votes. */
  readonly leaving?: boolean;
  /** Removes a dissolved group's read-only copy from this device (#108); rejects when it couldn't. */
  readonly onRemove?: () => Promise<void>;
  /**
   * The quiet card that suggests a backup (#78), after the open Proposals;
   * none when absent, or once the group has dissolved (#108).
   */
  readonly backupCard?: ReactNode;
  /**
   * The front door's applications (#121), under their own heading before
   * Invite people: given only while the door is open and this member may
   * invite.
   */
  readonly applications?: ReactNode;
  /** The group's Coalitions (#114), after Decided; none when absent. */
  readonly coalitions?: ReactNode;
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
  /**
   * Why this device can't read what the group writes now (#98): this
   * membership left on another device, or this device missed the group's new
   * key. Null or absent while it can.
   */
  readonly keyChange?: KeyChange | null;
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
  readonly state: GroupState;
  readonly groupId: string;
  readonly proposals: readonly Proposal[];
  readonly now: number;
  /** What each card says under its title in place of its countdown, such as why it closed (#108). */
  readonly line?: string;
}

/**
 * Open Proposals as cards, each led by the Document it changes or creates
 * (#92), with its title and countdown, opening its ballot.
 */
function ProposalCards({ state, groupId, proposals, now, line }: ProposalCardsProps) {
  return (
    <ul className="card-list">
      {proposals.map((proposal) => (
        <li key={proposal.id}>
          <Link
            className="card-link"
            href={routeHref({ name: 'proposal', groupId, proposalId: proposal.id })}
          >
            <DocumentLine lead={documentLead(state, proposal)} />
            <span className="card-link-title">
              <span className="heading-3">
                <bdi>{proposal.title}</bdi>
              </span>
              <span className="card-link-arrow" aria-hidden="true">
                {messages.app.forward}
              </span>
            </span>
            <span className="meta">
              {line ?? (
                <Countdown deadline={proposal.deadline} closedAt={proposal.closedAt} now={now} />
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

interface OpenListsProps {
  readonly state: GroupState;
  readonly groupId: string;
  /** What goes right under Needs your vote: the current focus (#107). */
  readonly children?: ReactNode;
  /** What goes right after the last list of open Proposals: the backup card (#78). */
  readonly after?: ReactNode;
  /** What waits on this person; nothing while they're leaving. */
  readonly needsYourVote: readonly Proposal[];
  /** The other open Proposals, or every open one while they're leaving. */
  readonly otherOpen: readonly Proposal[];
  readonly now: number;
}

/**
 * 'Needs your vote', when anything waits on this person, then the current
 * focus (#107), then the other open Proposals: "Open Proposals", or "Other
 * open Proposals" after it. With none open, one line says so. `after`, the
 * backup card (#78), follows the last list of Proposals, so it sits under
 * Needs your vote, ahead of the focus, when nothing else is open.
 */
function OpenLists(props: OpenListsProps) {
  const { state, groupId, needsYourVote, otherOpen, now, children, after } = props;
  const { home } = messages;
  const waits = needsYourVote.length > 0;
  const others = otherOpen.length > 0;
  // Needs your vote is the last list when nothing else is open.
  const lastIsWaits = waits && !others;
  return (
    <>
      {waits ? (
        <Section title={home.needsYourVote}>
          <ProposalCards state={state} groupId={groupId} proposals={needsYourVote} now={now} />
        </Section>
      ) : null}
      {lastIsWaits ? after : null}
      {children}
      {others ? (
        <Section title={waits ? home.otherOpen : home.openProposals}>
          <ProposalCards state={state} groupId={groupId} proposals={otherOpen} now={now} />
        </Section>
      ) : null}
      {waits || others ? null : (
        <Section title={home.openProposals}>
          <p>{home.noProposals}</p>
        </Section>
      )}
      {lastIsWaits ? null : after}
    </>
  );
}

/**
 * In a dissolved group (#108), the Proposals still open when it dissolved,
 * under "Not decided", each saying it closed then, with no outcome. Nothing
 * when there were none.
 */
function Unfinished({ state, groupId, proposals, now }: Omit<ProposalCardsProps, 'line'>) {
  if (proposals.length === 0) return null;
  const { archive } = messages;
  return (
    <Section title={archive.unfinished}>
      <ProposalCards
        state={state}
        groupId={groupId}
        proposals={proposals}
        now={now}
        line={archive.closed}
      />
    </Section>
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

interface DecidedProps {
  readonly state: GroupState;
  readonly groupId: string;
  readonly closed: readonly Proposal[];
}

/**
 * Decided: the group's history, each closed Proposal led by the Document it
 * changed or created (#92), with its title, its outcome in a word, and its
 * close date, opening its result, and "Scores cleared" once this device has
 * deleted its individual ballots (#111). A priority vote, which changes no
 * Document, has no Document line, and one that passed names its top option
 * (#107).
 */
function Decided({ state, groupId, closed }: DecidedProps) {
  if (closed.length === 0) return <p>{messages.decided.empty}</p>;
  return (
    <ul className="card-list">
      {closed.map((proposal) => (
        <li key={proposal.id}>
          <Link
            className="card-link"
            href={routeHref({ name: 'proposal', groupId, proposalId: proposal.id })}
          >
            <DocumentLine lead={documentLead(state, proposal)} />
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
              {proposal.cleared ? (
                <span className="decided-cleared">{messages.decided.cleared}</span>
              ) : null}
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
  /** True while this member leaves, or once the group has dissolved: nothing new is asked. */
  readonly readOnly: boolean;
}

/**
 * The group's current focus (#107): the top option of the latest priority
 * vote to pass, opening its result, or a sentence before there is one. Those
 * who can propose may ask what to focus on while no priority vote is open,
 * unless they're leaving or the group has dissolved (#77, #108), whose
 * read-only copy keeps the focus it had.
 */
function Focus({ state, me, readOnly }: FocusProps) {
  const groupId = state.group ?? '';
  const { focus } = state;
  const canAsk = !readOnly && can(state, me, 'propose') && openPriority(state) === undefined;
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

interface HomeDispatchesProps {
  readonly state: GroupState;
  readonly me: string;
  /** True while this member leaves, or once the group has dissolved: nothing new is sent. */
  readonly readOnly: boolean;
}

/** Send a Dispatch, quietly, and See all with an arrow: what follows the latest Dispatch. */
function DispatchLinks({ groupId, sends, any }: { groupId: string; sends: boolean; any: boolean }) {
  const { dispatches } = messages;
  return (
    <div className="row">
      {sends ? (
        <Link
          className="button button-secondary"
          href={routeHref({ name: 'sendDispatch', groupId })}
        >
          {dispatches.send}
        </Link>
      ) : null}
      {any ? (
        <Link className="forward-link" href={routeHref({ name: 'dispatches', groupId })}>
          <span>
            {dispatches.seeAll} <VisuallyHidden>{dispatches.seeAllWhat}</VisuallyHidden>
          </span>
          <span aria-hidden="true">{messages.app.forward}</span>
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Dispatches (#112): the group's latest, with See all, or a line saying there
 * are none yet; and Send a Dispatch for whoever may send one, unless the
 * group takes nothing new.
 */
function HomeDispatches({ state, me, readOnly }: HomeDispatchesProps) {
  const latest = latestDispatch(state);
  const sends = !readOnly && can(state, me, 'dispatch');
  const any = latest !== null;
  return (
    <Section title={messages.dispatches.title}>
      <div className="stack home-dispatches">
        {latest === null ? (
          <p>{messages.dispatches.empty}</p>
        ) : (
          <DispatchCard state={state} dispatch={latest} level={3} />
        )}
        {sends || any ? (
          <DispatchLinks groupId={state.group ?? ''} sends={sends} any={any} />
        ) : null}
      </div>
    </Section>
  );
}

/** What group home says when the group's key changed past this device (#98). */
const KEY_CHANGE_LINE: Readonly<Record<KeyChange, string>> = {
  left: messages.home.keyLeft,
  missed: messages.home.keyMissed,
};

/**
 * "Can't reach the relay right now", the catch-up line while some history
 * may be missing, and why this device can't read on once the group's key has
 * changed past it (#98), in a live region that is always there.
 */
function SyncNotices({ sync }: { readonly sync: SyncStatus }) {
  const { reachable, lastSyncAt, deviceNow, missingHistory, keyChange = null } = sync;
  const line =
    lastSyncAt === null
      ? messages.home.unreachable
      : messages.home.unreachableSince(formatSyncedAt(lastSyncAt, deviceNow));
  return (
    <div role="status">
      {reachable ? null : <p className="notice">{line}</p>}
      {keyChange === null ? null : <p className="notice">{KEY_CHANGE_LINE[keyChange]}</p>}
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
  /** The members this device's `vouch` events in the outbox name (#101). */
  readonly vouching: readonly string[];
}

interface NewcomerProps {
  readonly props: GroupHomeProps;
  readonly author: string;
  readonly name: string;
  readonly vouching: readonly string[];
}

/**
 * A newcomer's progress and who vouched for them, then Vouch for <name> when
 * this member may vouch for them, has none waiting to send and isn't leaving
 * (admission.ts decides, as the fold does), or the vouch's status while it
 * waits (#101). Nothing for someone who holds rights.
 */
function NewcomerRow({ props, author, name, vouching }: NewcomerProps) {
  const { state, me, sync, onVouch } = props;
  const waiting = vouching.includes(author);
  const offered = props.leaving !== true && !waiting && vouchWanted(state, me, author);
  return (
    <>
      <NewcomerProgress state={state} author={author} />
      {offered ? (
        <div className="person-vouch">
          <VouchDialog name={name} chat={latestLink(state)} onVouch={() => onVouch(author)} />
        </div>
      ) : null}
      {waiting ? (
        <div className="person-status">
          <SendStatus pending reachable={sync.reachable} sent={false} />
        </div>
      ) : null}
    </>
  );
}

/**
 * One person: their name and who invited them (#73), level and Steward
 * badge, any running suspension, and Suspend when this member may suspend
 * them now, has none waiting to send and isn't leaving (stewards.ts decides,
 * as the fold does). A newcomer's row also shows their way to a vote (#101).
 */
function Person({ props, member, suspending, vouching }: PersonProps) {
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
      <NewcomerRow props={props} author={author} name={name} vouching={vouching} />
      {suspending === author ? (
        <div className="person-status">
          <SendStatus pending reachable={sync.reachable} sent={false} />
        </div>
      ) : null}
    </li>
  );
}

/** Whom this member's `vouch` events still in the outbox name (#101). */
function waitingVouches(me: string, pending: readonly ParsedEvent[]): string[] {
  return pending.flatMap(({ event }) =>
    event.type === 'vouch' && event.author === me ? [event.body.member] : [],
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
  const vouching = waitingVouches(props.me, props.pending);
  return (
    <ul className="people">
      {props.state.members.map((member) => (
        <Person
          key={member.author}
          props={props}
          member={member}
          suspending={suspending}
          vouching={vouching}
        />
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
  /** True until this member's voting rights arrive: every level reads and follows until then (#101). */
  readonly newcomer: boolean;
  readonly onChooseLevel: GroupHomeProps['onChooseLevel'];
}

/**
 * "Your involvement": the level picker, and Save once the choice differs from
 * the level held. Saving queues one `level` event; the People list shows the
 * new level once the relay returns it (ADR-0021: self-selected).
 */
function Involvement(props: InvolvementProps) {
  const { current, waiting, reachable, suspended, newcomer, onChooseLevel } = props;
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
      {newcomer ? <p className="caption">{messages.admission.levelsWait}</p> : null}
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
              newcomer={!holdsRights(state, me)}
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

interface ArchiveNoteProps {
  readonly dissolved: Dissolution;
  readonly onRemove: GroupHomeProps['onRemove'];
}

/**
 * A dissolved group's note (#108): when it dissolved and that this is a
 * read-only copy, when this device erases it if the vote chose to wipe, and
 * Remove from this device, behind an alert dialog.
 */
function ArchiveNote({ dissolved, onRemove }: ArchiveNoteProps) {
  const { archive } = messages;
  return (
    <div className="archive-note">
      <p className="eyebrow">{archive.eyebrow}</p>
      <p>{archive.dissolvedOn(formatDate(dissolved.received))}</p>
      {dissolved.wipe ? <p>{archive.erasedOn(formatDate(wipeMinute(dissolved)))}</p> : null}
      {onRemove === undefined ? null : (
        <div>
          <ConfirmDialog
            open={archive.remove}
            title={archive.removeTitle}
            body={archive.removeBody}
            confirm={archive.removeConfirm}
            cancel={archive.cancel}
            failed={archive.removeFailed}
            onConfirm={onRemove}
          />
        </div>
      )}
    </div>
  );
}

/**
 * "Propose dissolving the group →", for someone who may propose it now
 * (#108), and nothing in a group that takes nothing new.
 */
function ProposeDissolve({ props, readOnly }: { props: GroupHomeProps; readOnly: boolean }) {
  const { state, me } = props;
  if (readOnly || !mayProposeDissolve(state, me)) return null;
  const groupId = state.group ?? '';
  return (
    <p className="dissolve-link">
      <Link className="forward-link" href={routeHref({ name: 'dissolve', groupId })}>
        {messages.dissolve.propose}
        <span aria-hidden="true">{messages.app.forward}</span>
      </Link>
    </p>
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
 * The front door's Applications (#121), given only while the door is open
 * and this member may invite, then Invite people, for whoever may invite,
 * while the group's key is this device's (#98). Neither shows while this
 * member leaves (#77).
 */
function InviteSections(props: GroupHomeProps & { readonly current: boolean }) {
  const { state, me, makeInviteLink, copyText, leaving = false, current } = props;
  if (leaving) return null;
  return (
    <>
      {props.applications === undefined ? null : (
        <Section title={messages.door.applications}>{props.applications}</Section>
      )}
      {can(state, me, 'invite') && current ? (
        <Section title={messages.home.invite}>
          <Invite makeInviteLink={makeInviteLink} copyText={copyText} />
        </Section>
      ) : null}
    </>
  );
}

/**
 * People, the Stewards (#102), the Rules (#117), the front door's
 * Applications (#121) and the invite, each for
 * whoever may see it. While this member's leave waits for the relay, there's
 * no invite, nor once the group's key changed past this device (#98): its
 * link would carry a key nobody reads any more. A dissolved group has no
 * stewards or opt-ins to speak of, so its copy leaves both out (#108).
 */
function MemberSections(props: GroupHomeProps) {
  const { state, me, leaving = false } = props;
  const roster = can(state, me, 'see-roster');
  const current = (props.sync.keyChange ?? null) === null;
  return (
    <>
      {roster ? <PeopleSection {...props} /> : null}
      {roster && state.dissolved === null ? (
        <Section title={messages.stewards.heading}>
          <StewardSeats state={state} me={me} leaving={leaving} />
        </Section>
      ) : null}
      {state.dissolved === null ? (
        <Section title={messages.optIns.homeHeading}>
          <RulesLink state={state} />
        </Section>
      ) : null}
      <InviteSections {...props} leaving={leaving} current={current} />
    </>
  );
}

/**
 * Under the heading: how syncing goes and whether this member is leaving, or,
 * in a dissolved group, the archive's note alone: a read-only copy never
 * syncs, so the relay's reach and missing history mean nothing to it (#108).
 */
function TopNotes(props: GroupHomeProps) {
  const { state, sync, leaving = false, onRemove } = props;
  const { dissolved } = state;
  if (dissolved !== null) return <ArchiveNote dissolved={dissolved} onRemove={onRemove} />;
  return (
    <>
      <SyncNotices sync={sync} />
      {leaving ? <LeavingNote /> : null}
    </>
  );
}

interface OpenSectionsProps {
  readonly groupId: string;
  readonly state: GroupState;
  readonly lists: ReturnType<typeof homeLists>;
  readonly now: number;
  readonly leaving: boolean;
  /** The current focus (#107), right under Needs your vote. */
  readonly children: ReactNode;
  /** The backup card (#78), after the open Proposals; none in a dissolved group. */
  readonly after: ReactNode;
}

/**
 * The open Proposals: Needs your vote, the current focus (#107) and the rest,
 * or every one together while this member leaves. In a dissolved group, those
 * still open when it dissolved, as closed (#108), then the focus it had.
 */
function OpenSections(props: OpenSectionsProps) {
  const { groupId, state, lists, now, leaving, children, after } = props;
  if (state.dissolved !== null) {
    return (
      <>
        <Unfinished state={state} groupId={groupId} proposals={lists.open} now={now} />
        {children}
      </>
    );
  }
  return (
    <OpenLists
      state={state}
      groupId={groupId}
      needsYourVote={leaving ? [] : lists.needsYourVote}
      otherOpen={leaving ? lists.open : lists.otherOpen}
      now={now}
      after={after}
    >
      {children}
    </OpenLists>
  );
}

interface DocumentsProps {
  readonly state: GroupState;
  readonly me: string;
  /** True while this member leaves, or once the group has dissolved: nothing new is proposed. */
  readonly readOnly: boolean;
}

/**
 * The group's Documents (#92), in order, each opening its own view, then
 * Propose a new Document for whoever may propose, unless the group takes
 * nothing new: one content cell, as Dispatches has, so the button sits under
 * the list and not in the section's label column.
 */
function Documents({ state, me, readOnly }: DocumentsProps) {
  const groupId = state.group ?? '';
  const { home } = messages;
  return (
    <Section title={home.documentsLabel}>
      <div className="stack">
        <ul className="card-list">
          {state.documents.map(({ id, title }) => (
            <li key={id}>
              <Link
                className="card-link"
                href={routeHref({ name: 'document', groupId, documentId: id })}
              >
                <span className="card-link-title">
                  <span className="heading-2">
                    <bdi>{title}</bdi>
                  </span>
                  <span className="card-link-arrow" aria-hidden="true">
                    {messages.app.forward}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {!readOnly && can(state, me, 'propose') ? (
          <div className="row">
            <Link
              className="button button-secondary"
              href={routeHref({ name: 'newDocument', groupId })}
            >
              {home.proposeDocument}
            </Link>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Group home (`#/g/{groupId}`; spec §8), in order: Needs your vote (#77), the
 * group's current focus (#107), the other open Proposals and the backup card
 * under them (#78), the latest Dispatch (#112), the group's Documents with
 * Propose a new Document (#92), the Decided list of closed ones, its
 * Coalitions (#114), its people with their levels, the viewer's own
 * involvement and Leave this
 * group, the Stewards (#102), the Rules (#117), then its invite link and its discussion, each shown only to members
 * whose capabilities allow it (`can()` is the only check), and last, for
 * whoever may propose it, Propose dissolving the group (#108). While the viewer's
 * leave waits for the relay, it says so, lists every open Proposal together,
 * and offers no level choice, invite or Leave. A dissolved group reads the
 * same way, as a read-only copy with no controls, saying when it dissolved
 * and offering Remove from this device (#108).
 */
export function GroupHome(props: GroupHomeProps) {
  const { state, me, now, leaving = false } = props;
  const groupId = state.group ?? '';
  const discussion = latestLink(state);
  const lists = homeLists(state, me, now);
  const { dissolved } = state;
  // A dissolved group takes nothing new, as a group being left doesn't (#108).
  const readOnly = leaving || dissolved !== null;
  // Every level follows the group (ADR-0003): for someone who doesn't vote, Dispatches lead (#112).
  const news = <HomeDispatches state={state} me={me} readOnly={readOnly} />;
  const leads = !can(state, me, 'vote');
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <div className="page-top">
        <PageHeader
          eyebrow={messages.home.eyebrow}
          title={state.name}
          pageTitle={messages.home.pageTitle}
        />
        <TopNotes {...props} />
      </div>
      {/* A suspension means nothing once the group has dissolved, though its end is still ahead. */}
      {dissolved === null ? <SuspendedNote state={state} me={me} /> : null}
      {/* Nor does a newcomer's wait: no vote opens once the group has dissolved (#101, #108). */}
      {readOnly ? null : <WaitingNote state={state} me={me} />}
      <div className="sections">
        {leads ? news : null}
        <OpenSections
          groupId={groupId}
          state={state}
          lists={lists}
          now={now}
          leaving={leaving}
          // No backup file carries a dissolved group's read-only copy, so none is suggested (#108).
          after={dissolved === null ? props.backupCard : null}
        >
          <Focus state={state} me={me} readOnly={readOnly} />
        </OpenSections>
        {leads ? null : news}
        <Documents state={state} me={me} readOnly={readOnly} />
        <Section title={messages.decided.title}>
          <Decided state={state} groupId={groupId} closed={lists.decided} />
        </Section>
        {props.coalitions}
        <MemberSections {...props} leaving={readOnly} />
        {discussion === null ? null : (
          <Section title={messages.home.discussion}>
            <div>
              <ChatLink href={discussion} />
            </div>
          </Section>
        )}
      </div>
      <ProposeDissolve props={props} readOnly={readOnly} />
    </main>
  );
}
