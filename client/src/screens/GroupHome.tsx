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
  /** The link Copy invite link copies. */
  readonly inviteLink: string;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
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
 * outcome in a word, and its close date, opening its result, and "Scores
 * cleared" once this device has deleted its individual ballots (#111).
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

/** "Can't reach the relay right now", in a live region that is always there. */
function Reachability({ sync }: { readonly sync: SyncStatus }) {
  const { reachable, lastSyncAt, deviceNow } = sync;
  const line =
    lastSyncAt === null
      ? messages.home.unreachable
      : messages.home.unreachableSince(formatSyncedAt(lastSyncAt, deviceNow));
  return <div role="status">{reachable ? null : <p className="notice">{line}</p>}</div>;
}

/** Everyone in the group, each with the level they chose (ADR-0074: every level sees it). */
function People({ state }: { readonly state: GroupState }) {
  return (
    <ul className="people">
      {state.members.map((member) => (
        <li key={member.author} className="person">
          <bdi className="person-name">{displayName(state, member.author)}</bdi>
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

type CopyStatus = 'idle' | 'copied' | 'blocked';

const COPY_STATUS: Readonly<Record<CopyStatus, string>> = {
  idle: '',
  copied: messages.home.copied,
  blocked: messages.home.copyFailed,
};

function Invite({
  link,
  copyText,
}: {
  readonly link: string;
  readonly copyText: GroupHomeProps['copyText'];
}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const copy = () => {
    copyText(link).then(
      () => {
        setStatus('copied');
      },
      () => {
        setStatus('blocked');
      },
    );
  };
  return (
    <div className="stack">
      <Button className="button button-primary" onPress={copy}>
        {messages.home.copyInvite}
      </Button>
      <div className="field-status">
        <Field
          label={messages.home.inviteField}
          value={link}
          isReadOnly
          inputClassName="input-link"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <p role="status" className="status">
          {COPY_STATUS[status]}
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
  const { state, me, inviteLink, copyText, now, sync } = props;
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
        <Reachability sync={sync} />
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
            <Invite link={inviteLink} copyText={copyText} />
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
