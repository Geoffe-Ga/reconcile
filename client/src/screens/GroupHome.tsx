import { type ReactNode, useId, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import { ChatLink } from '../app/ChatLink';
import { Countdown } from '../app/Countdown';
import { latestLink } from '../app/latestLink';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { formatSyncedAt } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
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

/** "Can't reach the relay right now", in a live region that is always there. */
function Reachability({ sync }: { readonly sync: SyncStatus }) {
  const { reachable, lastSyncAt, deviceNow } = sync;
  const line =
    lastSyncAt === null
      ? messages.home.unreachable
      : messages.home.unreachableSince(formatSyncedAt(lastSyncAt, deviceNow));
  return <div role="status">{reachable ? null : <p className="notice">{line}</p>}</div>;
}

function People({ state }: { readonly state: GroupState }) {
  return (
    <ul className="people">
      {state.members.map((member) => (
        <li key={member.author}>
          <bdi>{displayName(state, member.author)}</bdi>
        </li>
      ))}
    </ul>
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
 * Group home (`#/g/{groupId}`): the group's Document, its open Proposals, its
 * people and its invite link, each shown only to members whose capabilities
 * allow it (spec §8; `can()` is the only check).
 */
export function GroupHome({ state, me, inviteLink, copyText, now, sync }: GroupHomeProps) {
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
        {can(state, me, 'see-roster') ? (
          <Section title={messages.home.people}>
            <People state={state} />
          </Section>
        ) : null}
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
