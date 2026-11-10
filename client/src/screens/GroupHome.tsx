import { type ReactNode, useId, useState } from 'react';
import { Button, Link, VisuallyHidden } from 'react-aria-components';

import { ChatLink } from '../app/ChatLink';
import { Countdown } from '../app/Countdown';
import { latestLink } from '../app/latestLink';
import { LevelPicker } from '../app/LevelPicker';
import { levelName } from '../app/levels';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { SendStatus } from '../app/SendStatus';
import { formatDay } from '../app/format';
import { formatSyncedAt, minuteIso } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useSaving } from '../app/useSaving';
import { can, isLevel, type Level } from '../engine/capabilities';
import type { ParsedEvent } from '../engine/event';
import type { GroupState, Proposal } from '../engine/fold';
import { displayName } from '../engine/names';

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

function OpenProposals({ state, now }: { readonly state: GroupState; readonly now: number }) {
  const groupId = state.group ?? '';
  const open = state.proposals.filter((proposal) => !proposal.final);
  if (open.length === 0) return <p>{messages.home.noProposals}</p>;
  return (
    <ul className="card-list">
      {open.map((proposal) => (
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

/** When a closed Proposal closed: early, or at its deadline, in relay minutes. */
function closedAt(proposal: Proposal): number {
  return proposal.closedAt ?? proposal.deadline;
}

/** Closed Proposals, newest first by when they closed, and by relay order within a minute. */
function decided(state: GroupState): Proposal[] {
  return state.proposals
    .filter((proposal) => proposal.final)
    .reverse()
    .sort((a, b) => closedAt(b) - closedAt(a));
}

/**
 * Decided: the group's history, each closed Proposal with its title, its
 * outcome in a word, and its close date, opening its result.
 */
function Decided({ state }: { readonly state: GroupState }) {
  const groupId = state.group ?? '';
  const closed = decided(state);
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
            <span className="meta countdown">
              <span>{messages.decided.outcomes[proposal.outcome.kind]}</span>
              <time dateTime={minuteIso(closedAt(proposal))}>{formatDay(closedAt(proposal))}</time>
            </span>
          </Link>
        </li>
      ))}
    </ul>
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

/**
 * Everyone in the group, each with who invited them and the level they chose
 * (ADR-0074: every level sees it).
 */
function People({ state }: { readonly state: GroupState }) {
  return (
    <ul className="people">
      {state.members.map((member) => (
        <li key={member.author} className="person">
          <span className="person-who">
            <bdi className="person-name">{displayName(state, member.author)}</bdi>
            {member.invitedBy === null ? null : (
              <InvitedBy state={state} inviter={member.invitedBy} />
            )}
          </span>
          <VisuallyHidden>{messages.home.levelSeparator}</VisuallyHidden>{' '}
          <span className="person-level">{levelName(member.level)}</span>
        </li>
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
  readonly onChooseLevel: GroupHomeProps['onChooseLevel'];
}

/**
 * "Your involvement": the level picker, and Save once the choice differs from
 * the level held. Saving queues one `level` event; the People list shows the
 * new level once the relay returns it (ADR-0021: self-selected).
 */
function Involvement({ current, waiting, reachable, onChooseLevel }: InvolvementProps) {
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
      <LevelPicker value={picked} onChange={setChoice} isDisabled={running} />
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

/** The People list, then this member's own involvement under it. */
function PeopleSection(props: GroupHomeProps) {
  const { state, me, pending, sync, onChooseLevel } = props;
  // Nobody chooses a level before the relay has returned their join.
  const mine = state.members.find((member) => member.author === me);
  const waiting = waitingLevel(me, pending);
  return (
    <Section title={messages.home.people}>
      <div className="stack people-stack">
        <People state={state} />
        {mine === undefined ? null : (
          <Involvement
            current={waiting ?? mine.level}
            waiting={waiting !== undefined}
            reachable={sync.reachable}
            onChooseLevel={onChooseLevel}
          />
        )}
      </div>
    </Section>
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
 * Group home (`#/g/{groupId}`): the group's Document, its open Proposals, the
 * Decided list of closed ones, its people with their levels and the viewer's
 * own involvement, and its invite link, each shown only to members whose
 * capabilities allow it (spec §8; `can()` is the only check).
 */
export function GroupHome(props: GroupHomeProps) {
  const { state, me, makeInviteLink, copyText, now, sync } = props;
  const groupId = state.group ?? '';
  const discussion = latestLink(state);
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
      </div>
      <Link className="card-link" href={routeHref({ name: 'document', groupId })}>
        <span className="eyebrow">{messages.home.documentLabel}</span>
        <span className="card-link-title">
          <span className="heading-2">
            <bdi>{state.title}</bdi>
          </span>
          <span className="card-link-arrow" aria-hidden="true">
            {messages.app.forward}
          </span>
        </span>
      </Link>
      <div className="sections">
        <Section title={messages.home.openProposals}>
          <OpenProposals state={state} now={now} />
        </Section>
        <Section title={messages.decided.title}>
          <Decided state={state} />
        </Section>
        {can(state, me, 'see-roster') ? <PeopleSection {...props} /> : null}
        {can(state, me, 'invite') ? (
          <Section title={messages.home.invite}>
            <Invite makeInviteLink={makeInviteLink} copyText={copyText} />
          </Section>
        ) : null}
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
