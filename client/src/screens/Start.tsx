import { type SyntheticEvent, useId } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { parseInviteLink } from '../app/invite';
import { messages } from '../app/messages';
import { RestoreBackup, type RestoreBackupProps } from '../app/RestoreBackup';
import { routeHref } from '../app/router';
import { formatDay } from '../app/time';
import { Field, PageHeader } from '../app/ui';
import { base64url } from '../crypto/base64url';
import { parseDoorLink } from '../door/page';
import type { Persistence } from '../platform/persist';

/** A group as Start lists it. Name and title are null until its genesis reaches the relay. */
export interface StartGroup {
  readonly groupId: string;
  readonly name: string | null;
  readonly title: string | null;
  /** Whether this device's leave waits for the relay (#77); the group goes once it's there. */
  readonly leaving: boolean;
}

/** An application this device sent at a front door (#121), as Start lists it. */
export interface StartRequest {
  readonly id: string;
  /** The group's name as its page showed it. */
  readonly groupName: string;
  /** When it was sent, in device milliseconds. */
  readonly sentAt: number;
  /** The invite seed a reply brought, or null while none has. */
  readonly invite: Uint8Array | null;
}

/** Props for {@link Start}. */
export interface StartProps {
  /** The groups on this device. */
  readonly groups: readonly StartGroup[];
  /** The applications this device sent at front doors and still keeps (#121). */
  readonly requests?: readonly StartRequest[];
  /** Opens a pasted invite's seed. It travels in memory, never through the address bar. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** Opens a pasted front door link's page (#121), by the address after `#door/`. */
  readonly onOpenDoor?: (payload: string) => void;
  /** What the browser said about keeping this site's data, or null before it answered. */
  readonly persistence?: Persistence | null;
  /** Restores a backup file (#78); without it, Start offers no Restore. */
  readonly onRestore?: RestoreBackupProps['onRestore'];
}

function GroupItem({ group }: { readonly group: StartGroup }) {
  return (
    <li>
      <Link className="card-link" href={routeHref({ name: 'group', groupId: group.groupId })}>
        <span className="card-link-title">
          <span className="heading-3">
            <bdi>{group.name ?? messages.start.settingUp}</bdi>
          </span>
          <span className="card-link-arrow" aria-hidden="true">
            {messages.app.forward}
          </span>
        </span>
        {group.title === null ? null : (
          <span className="caption">{messages.start.documentTitle(group.title)}</span>
        )}
        {group.leaving ? <span className="leaving-tag">{messages.start.leaving}</span> : null}
      </Link>
    </li>
  );
}

/** One card that opens Personal (#93): the person's own Documents, on this device only. */
function PersonalCard() {
  return (
    <div>
      <Link className="card-link" href={routeHref({ name: 'personal' })}>
        <span className="card-link-title">
          <span className="heading-3">{messages.start.personal}</span>
          <span className="card-link-arrow" aria-hidden="true">
            {messages.app.forward}
          </span>
        </span>
        <span className="caption">{messages.start.personalHint}</span>
      </Link>
    </div>
  );
}

/** M2-03's expired-or-damaged line for anything that isn't an invite link. It never repeats the text. */
function checkInvite(text: string): string | null {
  return parseInviteLink(text) === null ? messages.join.badLink : null;
}

/**
 * "Asked to join" (#121): each application this device sent at a front door,
 * with when, until an invite comes; then "<group> invited you" and the way
 * into Join.
 */
function Requests(
  props: Pick<StartProps, 'onOpenInvite'> & { readonly requests: readonly StartRequest[] },
) {
  const { requests, onOpenInvite } = props;
  const heading = useId();
  const { door } = messages;
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {door.requestsHeading}
      </h2>
      <ul className="card-list">
        {requests.map(({ id, groupName, sentAt, invite }) => (
          <li key={id} className="card request">
            {invite === null ? (
              <>
                <p className="heading-3">
                  <bdi>{groupName}</bdi>
                </p>
                <p className="caption">{door.waiting(formatDay(sentAt))}</p>
              </>
            ) : (
              <>
                <p className="heading-3 request-invited">
                  {door.invited.before}
                  <bdi>{groupName}</bdi> {door.invited.after}
                </p>
                <div>
                  <Button
                    className="button button-secondary"
                    onPress={() => {
                      onOpenInvite(invite);
                    }}
                  >
                    {door.openInvite}
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The front door line for anything that isn't a door link (#121). It never repeats the text. */
function checkDoor(text: string): string | null {
  return parseDoorLink(text) === null ? messages.door.startBadLink : null;
}

/** "Have a front door link?", a field to paste one into, and Open the front door (#121). */
function DoorSection({ onOpenDoor }: { readonly onOpenDoor: (payload: string) => void }) {
  const heading = useId();
  const { door } = messages;
  const open = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('door');
    const address = typeof text === 'string' ? parseDoorLink(text) : null;
    if (address !== null) onOpenDoor(base64url(address));
  };
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {door.startHeading}
      </h2>
      <Form className="form" onSubmit={open}>
        <Field
          name="door"
          label={door.startLabel}
          hint={door.startHint}
          autoComplete="off"
          isRequired
          validate={checkDoor}
        />
        <Button type="submit" className="button button-secondary">
          {door.startOpen}
        </Button>
      </Form>
    </section>
  );
}

/** "Have a backup file?", and Restore a backup under it (#78). */
function RestoreSection({ onRestore }: Pick<RestoreBackupProps, 'onRestore'>) {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.start.restoreHeading}
      </h2>
      <RestoreBackup onRestore={onRestore} />
    </section>
  );
}

/** "Have Reconcile on another device?", and Link to my other device under it (#96). */
function LinkSection() {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.start.linkHeading}
      </h2>
      <div>
        <Link className="button button-secondary" href={routeHref({ name: 'linkThis' })}>
          {messages.start.link}
        </Link>
      </div>
    </section>
  );
}

/**
 * Start (`#/`): every group on this device by name, each marked while its
 * leave waits for the relay (#77), Create group, the front doors this device
 * asked to join at and any invite they sent (#121), a card that opens
 * Personal (#93), Join with an invite link, a field to paste one into, a
 * field for a front door link (#121), Restore a backup (#78), Link to my
 * other device (#96), and a quiet link to Settings. The app reads the clipboard only through that paste. When the
 * browser may clear the app's data, one quiet line says so (ADR-0029).
 */
export function Start(props: StartProps) {
  const { groups, requests = [], onOpenInvite, onOpenDoor, persistence = null, onRestore } = props;
  const inviteHeading = useId();

  const openInvite = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('invite');
    const seed = typeof text === 'string' ? parseInviteLink(text) : null;
    if (seed !== null) onOpenInvite(seed);
  };

  return (
    <main className="shell">
      <PageHeader
        eyebrow={messages.app.name}
        title={messages.start.title}
        pageTitle={messages.start.pageTitle}
      />
      <div className="stack">
        {groups.length === 0 ? (
          <p className="lede">{messages.start.empty}</p>
        ) : (
          <ul className="card-list">
            {groups.map((group) => (
              <GroupItem key={group.groupId} group={group} />
            ))}
          </ul>
        )}
        <Link className="button button-primary" href={routeHref({ name: 'create' })}>
          {messages.start.create}
        </Link>
      </div>
      {requests.length === 0 ? null : <Requests requests={requests} onOpenInvite={onOpenInvite} />}
      <PersonalCard />
      <section className="stack" aria-labelledby={inviteHeading}>
        <h2 id={inviteHeading} className="heading-3">
          {messages.start.inviteHeading}
        </h2>
        <Form className="form" onSubmit={openInvite}>
          <Field
            name="invite"
            label={messages.start.inviteLabel}
            hint={messages.start.inviteHint}
            autoComplete="off"
            isRequired
            validate={checkInvite}
          />
          <Button type="submit" className="button button-secondary">
            {messages.start.openInvite}
          </Button>
        </Form>
      </section>
      {onOpenDoor === undefined ? null : <DoorSection onOpenDoor={onOpenDoor} />}
      {onRestore === undefined ? null : <RestoreSection onRestore={onRestore} />}
      <LinkSection />
      {persistence === null || persistence === 'granted' ? null : (
        <p className="caption">{messages.start.mayClear}</p>
      )}
      <div>
        <Link className="forward-link" href={routeHref({ name: 'settings' })}>
          {messages.start.settings}
        </Link>
      </div>
    </main>
  );
}
