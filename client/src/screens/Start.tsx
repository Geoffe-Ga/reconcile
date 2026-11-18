import { type ReactNode, useId } from 'react';
import { Button, Link } from 'react-aria-components';

import { messages } from '../app/messages';
import { RestoreBackup, type RestoreBackupProps } from '../app/RestoreBackup';
import { routeHref } from '../app/router';
import { formatDay } from '../app/time';
import { PageHeader } from '../app/ui';
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

/** A coalition this device follows (#124), as Start lists it: its name and member groups. */
export interface StartFollowing {
  readonly coalitionId: string;
  readonly name: string;
  readonly groups: readonly string[];
}

/** Props for {@link Start}. */
export interface StartProps {
  /** The groups on this device. */
  readonly groups: readonly StartGroup[];
  /** The coalitions this device follows (#124). */
  readonly following?: readonly StartFollowing[];
  /** The applications this device sent at front doors and still keeps (#121). */
  readonly requests?: readonly StartRequest[];
  /** Opens the invite a front door's reply brought (#121). It travels in memory, never through the address bar. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** What the browser said about keeping this site's data, or null before it answered. */
  readonly persistence?: Persistence | null;
  /** Restores a backup file (#78); without it, Start offers no Restore. */
  readonly onRestore?: RestoreBackupProps['onRestore'];
  /** The recovery alert (#118), first on the page while a recovery of this person waits; none when absent. */
  readonly alert?: ReactNode;
  /** The shelf's word that a door this device sent to was removed (#491), after the alert; none when absent. */
  readonly removals?: ReactNode;
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

/**
 * "Following" (#124): each coalition this device follows, its name over its
 * member groups, opening its home. Every name sits in `<bdi>`.
 */
function Following({ following = [] }: { readonly following: StartProps['following'] }) {
  const heading = useId();
  if (following.length === 0) return null;
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.start.followingHeading}
      </h2>
      <ul className="card-list">
        {following.map(({ coalitionId, name, groups }) => (
          <li key={coalitionId}>
            <Link className="card-link" href={routeHref({ name: 'coalition', coalitionId })}>
              <span className="card-link-title">
                <span className="heading-3">
                  <bdi>{name}</bdi>
                </span>
                <span className="card-link-arrow" aria-hidden="true">
                  {messages.app.forward}
                </span>
              </span>
              <span className="caption following-groups">
                {groups.map((group, index) => (
                  <span key={index}>
                    {index === 0 ? null : (
                      <span aria-hidden="true">{messages.coalitions.groupsSeparator}</span>
                    )}
                    <bdi>{group}</bdi>
                  </span>
                ))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
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
                  <bdi>{groupName}</bdi> {door.invitedYou}
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

/** "Have an invite link?", and where it opens: the link bar at the top (#444). */
function InviteSection() {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.start.inviteHeading}
      </h2>
      <p>{messages.start.pasteInBar}</p>
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

/** "Lost every device?", and Recover with my contacts under it (#118). */
function RecoverSection() {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.start.recoverHeading}
      </h2>
      <div>
        <Link className="button button-secondary" href={routeHref({ name: 'recover' })}>
          {messages.start.recover}
        </Link>
      </div>
    </section>
  );
}

/**
 * Start (`#/`): every group on this device by name, each marked while its
 * leave waits for the relay (#77), Create group, the coalitions this device
 * follows (#124), the front doors this device asked to join at and any
 * invite they sent (#121), a card that opens Personal (#93), "Have an
 * invite link?" pointing to the link bar, where an invite or any other
 * Reconcile link opens (#444), Restore a backup (#78), Link to my other
 * device (#96), Recover with my contacts (#118), and a quiet link to
 * Settings. While a recovery of this person waits, its alert comes first
 * (#118), then any word that a door this device sent to was removed from
 * the public shelf (#491). When the browser may clear the app's data, one
 * quiet line says so (ADR-0029).
 */
export function Start(props: StartProps) {
  const { groups, requests = [], onOpenInvite } = props;
  const { persistence = null, onRestore, alert, removals } = props;

  return (
    <main className="shell" data-scene="sky">
      <PageHeader
        eyebrow={messages.app.name}
        title={messages.start.title}
        pageTitle={messages.start.pageTitle}
      />
      <div className="stack">
        {alert}
        {removals}
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
      <Following following={props.following} />
      {requests.length === 0 ? null : <Requests requests={requests} onOpenInvite={onOpenInvite} />}
      <PersonalCard />
      <InviteSection />
      {onRestore === undefined ? null : <RestoreSection onRestore={onRestore} />}
      <LinkSection />
      <RecoverSection />
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
