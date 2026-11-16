import {
  type ReactElement,
  type SyntheticEvent,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { Button, Disclosure, DisclosurePanel, Form, VisuallyHidden } from 'react-aria-components';

import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import type { CardLookup, FoundCard } from '../app/reconcile';
import { minuteIso } from '../app/time';
import { Field } from '../app/ui';
import { fromBase64url } from '../crypto/base64url';
import { cardGoneAt } from '../door/card';
import { can } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { cardClosedFor, inviteFor, mayRecordInvite } from '../engine/frontDoor';
import { displayName } from '../engine/names';
import type { ApplicationDocument, ReceivedApplication, ReceivedCard } from '../store/applications';
import { CardPreview } from './BringCard';

/**
 * The reconcile cards at the door (#426), and what bringing or dismissing
 * one takes.
 */
export interface DoorCards {
  /** The cards this device read from the inbox, oldest first, none it has queued a close of. */
  readonly held: readonly ReceivedCard[];
  /** Opens the card a seed names, as Bring a card does. */
  readonly lookup: (seed: Uint8Array) => Promise<CardLookup>;
  /** Bring it to a vote for this group, under a name in the coalition; false when that didn't finish. */
  readonly onBring: (card: string, found: FoundCard, yourName: string) => Promise<boolean>;
  /** Dismiss: closes the card for everyone in the group. */
  readonly onDismiss: (card: string) => Promise<void>;
}

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
  /** The reconcile cards at the door (#426); none on a device that read none. */
  readonly cards?: DoorCards;
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

interface CardProps extends Omit<ApplicationsProps, 'applications' | 'cards'> {
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

/** What opening a card at the door found: still opening, expired, or a lookup's answer. */
type Look = { readonly kind: 'loading' } | { readonly kind: 'expired' } | CardLookup;

/**
 * Opens `card` once per seed, however often the screen renders, unless it
 * has surely expired by `at`, the group's relay minute, or holds no seed any
 * more: those read as expired with no request.
 */
function useLook(card: ReceivedCard, at: number, lookup: DoorCards['lookup']): Look {
  const spent = card.seed === undefined || at >= cardGoneAt(card.received);
  const [look, setLook] = useState<Look>({ kind: 'loading' });
  const { seed } = card;
  const open = useEffectEvent((bytes: Uint8Array) => lookup(bytes));
  useEffect(() => {
    if (spent || seed === undefined) return;
    let live = true;
    open(fromBase64url(seed)).then(
      (found) => {
        if (live) setLook(found);
      },
      () => {
        if (live) setLook({ kind: 'offline' });
      },
    );
    return () => {
      live = false;
    };
  }, [spent, seed]);
  return spent ? { kind: 'expired' } : look;
}

/** The line a card that can't be brought reads, by what opening it found. */
function lookLine(look: Exclude<Look, { kind: 'found' }>): string {
  switch (look.kind) {
    case 'loading':
      return messages.bring.loading;
    case 'used':
      return messages.bring.used;
    case 'offline':
      return door.cardOffline;
    default:
      return door.cardExpired;
  }
}

interface BringProps {
  readonly card: ReceivedCard;
  readonly found: FoundCard;
  readonly onBring: DoorCards['onBring'];
  /** The row's Dismiss, which closes the card for the whole group, named for its card. */
  readonly dismiss: ReactElement;
}

const checkName = (value: string) => (value.trim() === '' ? messages.bring.yourNameMissing : null);

/**
 * Your name in the coalition, then Bring it to a vote (secondary) beside
 * Dismiss (quiet): Bring a card's own `bringCard` for this group. One press
 * at a time.
 */
function BringFields({ card, found, onBring, dismiss }: BringProps) {
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    const name = new FormData(event.currentTarget).get('yourName');
    busy.current = true;
    setFailed(false);
    void onBring(card.id, found, typeof name === 'string' ? name.trim() : '')
      .catch(() => false)
      .then((brought) => {
        busy.current = false;
        if (!brought) setFailed(true);
      });
  };
  return (
    <Form className="form door-card-form" onSubmit={submit}>
      <Field
        name="yourName"
        label={messages.bring.yourNameLabel}
        hint={messages.bring.yourNameHint}
        autoComplete="off"
        isRequired
        validate={checkName}
      />
      {failed ? (
        <p role="alert" className="form-error">
          {messages.bring.failed}
        </p>
      ) : null}
      <div className="row application-actions">
        <Button type="submit" className="button button-secondary">
          {door.bringToVote} <VisuallyHidden>{door.forCard(found.card.name)}</VisuallyHidden>
        </Button>
        {dismiss}
      </div>
    </Form>
  );
}

interface CardRowProps {
  readonly card: ReceivedCard;
  readonly state: GroupState;
  /** Whether this member may propose here, so bring a card to a vote or dismiss it. */
  readonly acts: boolean;
  readonly cards: DoorCards;
}

/**
 * One card at the door: the coalition's name and the day it arrived, then
 * its preview as Bring a card shows it, your name in the coalition, Bring it
 * to a vote and Dismiss; or the line saying why it can't be brought, with
 * Dismiss. A member who can't propose reads it, with nothing to press.
 */
function CardRow({ card, state, acts, cards }: CardRowProps) {
  const look = useLook(card, state.at, cards.lookup);
  const hint = useId();
  const day = formatDay(card.received);
  const found = look.kind === 'found' ? look.found : null;
  const brings = found?.groups.some((group) => group.groupId === state.group) === true;
  const dismiss = (
    <>
      <Button
        className="button button-quiet"
        aria-describedby={hint}
        onPress={() => {
          void cards.onDismiss(card.id);
        }}
      >
        {door.dismiss}{' '}
        <VisuallyHidden>
          {found === null ? door.cardOn(day) : door.cardOf(found.card.name)}
        </VisuallyHidden>
      </Button>
      <span id={hint} className="visually-hidden">
        {door.dismissCardHint}
      </span>
    </>
  );
  return (
    <li className="card application door-card">
      <div className="application-head">
        <p className="heading-3">
          <bdi>{found === null ? door.cardUnopened : found.card.name}</bdi>
        </p>
        <p className="meta">
          <time dateTime={minuteIso(card.received)}>{door.cardArrived(day)}</time>
        </p>
      </div>
      {look.kind === 'found' ? (
        <CardPreview card={look.found.card} level={4} />
      ) : (
        <p className="application-message" {...(look.kind === 'loading' ? { role: 'status' } : {})}>
          {lookLine(look)}
        </p>
      )}
      {!acts ? null : found !== null && brings ? (
        <BringFields card={card} found={found} onBring={cards.onBring} dismiss={dismiss} />
      ) : (
        <div className="row application-actions">{dismiss}</div>
      )}
    </li>
  );
}

/**
 * Groups asking to reconcile (#426): each card at the door no member has
 * closed, oldest first, under its own heading; nothing when there's none.
 * No count and no badge: a card arrives quietly.
 */
function DoorCardList({
  state,
  me,
  cards,
}: Pick<ApplicationsProps, 'state' | 'me'> & {
  readonly cards: DoorCards;
}) {
  const heading = useId();
  const open = cards.held.filter((card) => cardClosedFor(state, card.id) === undefined);
  if (open.length === 0) return null;
  const acts = can(state, me, 'propose');
  return (
    <div className="stack">
      <h3 id={heading} className="heading-3">
        {door.cardsHeading}
      </h3>
      <ul className="card-list" aria-labelledby={heading}>
        {open.map((card) => (
          <CardRow key={card.id} card={card} state={state} acts={acts} cards={cards} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Applications (#121; ADR-0038): on group home, for members who may invite
 * while the front door is open, each application this device read from the
 * door's inbox and hasn't dismissed, then the groups asking to reconcile
 * there (#426). Nothing here is in the group's log but the invite a member
 * sends and a card's close; an application's Dismiss touches this device
 * alone, a card's every member's.
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
      {props.cards === undefined ? null : (
        <DoorCardList state={props.state} me={props.me} cards={props.cards} />
      )}
    </div>
  );
}
