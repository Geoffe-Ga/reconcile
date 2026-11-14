import { useId, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, VisuallyHidden } from 'react-aria-components';

import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { minuteIso } from '../app/time';
import type { GroupState } from '../engine/fold';
import { inviteFor, mayRecordInvite } from '../engine/frontDoor';
import { displayName } from '../engine/names';
import type { ApplicationDocument, ReceivedApplication } from '../store/applications';

/** How 'Send an invite' went. */
export type InviteOutcome = 'sent' | 'failed' | 'missing';

/** Props for {@link Applications}. */
export interface ApplicationsProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The applications this device read from the door's inbox, oldest first. */
  readonly applications: readonly ReceivedApplication[];
  /** 'Send an invite' for the application `id`. */
  readonly onInvite: (id: string) => Promise<InviteOutcome>;
  /** 'Dismiss': hides the application `id` on this device only. */
  readonly onDismiss: (id: string) => Promise<void>;
}

/** Where one card's Send an invite has got to. */
type Sending = 'idle' | 'sending' | 'sent' | 'failed';

const { door } = messages;

/** What the status line under a card says. */
const STATUS: Readonly<Record<Sending, string>> = {
  idle: '',
  sending: door.sending,
  sent: door.inviteSent,
  failed: door.inviteFailed,
};

interface CardProps extends Omit<ApplicationsProps, 'applications'> {
  readonly application: ReceivedApplication;
}

/** "Invited by <name>", once the group's log records the invite. */
function InvitedBy({ state, by }: { readonly state: GroupState; readonly by: string }) {
  return (
    <p className="application-invited">
      {door.invitedBy} <bdi>{displayName(state, by) ?? ''}</bdi>
    </p>
  );
}

/**
 * The Documents an application carries a copy of (#425; ADR-0077 §3), under
 * "Documents they sent": each a disclosure, its title the toggle, then its
 * text as the applicant wrote it, plain and pre-wrapped in `<bdi>`, so
 * Markdown and addresses stay text, never formatting or links. A copy
 * carries no id and the list never reorders, so each keeps its place as its
 * key.
 */
function SentDocuments({ documents }: { readonly documents: readonly ApplicationDocument[] }) {
  const label = useId();
  return (
    <div className="application-documents" role="group" aria-labelledby={label}>
      <p id={label} className="eyebrow">
        {door.documentsSent}
      </p>
      {documents.map(({ title, text }, place) => (
        <Disclosure key={place} className="reads-as application-document">
          <Button slot="trigger" className="reads-as-toggle">
            <bdi>{title}</bdi>
          </Button>
          <DisclosurePanel>
            <p className="application-document-text">
              <bdi>{text}</bdi>
            </p>
          </DisclosurePanel>
        </Disclosure>
      ))}
    </div>
  );
}

/**
 * One application: the name and message as plain text in `<bdi>`, the day it
 * arrived, the Documents it carries a copy of (#425), who invited them once
 * the log says so, and Send an invite, while this member may record it, and
 * Dismiss.
 */
function ApplicationCard({ state, me, application, onInvite, onDismiss }: CardProps) {
  const { id, name, message, received, documents = [] } = application;
  const [sending, setSending] = useState<Sending>('idle');
  const hint = useId();
  const invite = inviteFor(state, id);
  const offer = sending !== 'sent' && mayRecordInvite(state, me, id);
  const send = () => {
    setSending('sending');
    void onInvite(id).then(
      (outcome) => {
        setSending(outcome === 'failed' ? 'failed' : 'sent');
      },
      () => {
        setSending('failed');
      },
    );
  };
  return (
    <li className="card application">
      <div className="application-head">
        <p className="heading-3">
          <bdi>{name}</bdi>
        </p>
        <p className="meta">
          <time dateTime={minuteIso(received)}>{door.askedOn(formatDay(received))}</time>
        </p>
      </div>
      {message === '' ? null : (
        <p className="application-message">
          <bdi>{message}</bdi>
        </p>
      )}
      {documents.length === 0 ? null : <SentDocuments documents={documents} />}
      {invite === undefined ? null : <InvitedBy state={state} by={invite.by} />}
      <div className="row application-actions">
        {offer ? (
          <Button
            className="button button-secondary"
            onPress={send}
            isDisabled={sending === 'sending'}
          >
            {door.sendInvite} <VisuallyHidden>{door.forApplicant(name)}</VisuallyHidden>
          </Button>
        ) : null}
        <Button
          className="button button-quiet"
          aria-describedby={hint}
          onPress={() => {
            void onDismiss(id);
          }}
        >
          {door.dismiss} <VisuallyHidden>{door.applicationOf(name)}</VisuallyHidden>
        </Button>
        <span id={hint} className="visually-hidden">
          {door.dismissHint}
        </span>
        {/* Beside the buttons, so the live region adds no empty line to the card. */}
        <p role="status" className="status">
          {STATUS[sending]}
        </p>
      </div>
    </li>
  );
}

/**
 * Applications (#121; ADR-0038): on group home, for members who may invite
 * while the front door is open, each application this device read from the
 * door's inbox and hasn't dismissed. Nothing here is in the group's log but
 * the invite a member sends; Dismiss touches this device alone.
 */
export function Applications(props: ApplicationsProps) {
  const shown = props.applications.filter((application) => application.dismissed !== true);
  return (
    <div className="stack">
      <p className="caption">{door.applicationsLede}</p>
      {shown.length === 0 ? (
        <p className="lede">{door.noApplications}</p>
      ) : (
        <ul className="card-list">
          {shown.map((application) => (
            <ApplicationCard key={application.id} {...props} application={application} />
          ))}
        </ul>
      )}
    </div>
  );
}
