import { type ReactNode, useId, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import { ChatLink } from '../app/ChatLink';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { BackLink, Field, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';

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

function OpenProposals({ state }: { readonly state: GroupState }) {
  const open = state.proposals.filter((proposal) => !proposal.final);
  if (open.length === 0) return <p>{messages.home.noProposals}</p>;
  return (
    <ul className="card-list">
      {open.map((proposal) => (
        <li key={proposal.id} className="heading-3">
          <bdi>{proposal.title}</bdi>
        </li>
      ))}
    </ul>
  );
}

function People({ state }: { readonly state: GroupState }) {
  return (
    <ul className="people">
      {state.members.map((member) => (
        <li key={member.author}>
          <bdi>{member.name}</bdi>
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
  );
}

/**
 * Group home (`#/g/{groupId}`): the group's Document, its open Proposals, its
 * people and its invite link, each shown only to members whose capabilities
 * allow it (spec §8; `can()` is the only check).
 */
export function GroupHome({ state, me, inviteLink, copyText }: GroupHomeProps) {
  const groupId = state.group ?? '';
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader
        eyebrow={messages.home.eyebrow}
        title={state.name}
        pageTitle={messages.home.pageTitle}
      />
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
          <OpenProposals state={state} />
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
      </div>
      <ChatLink href={state.chat} />
    </main>
  );
}
