import { type ReactNode, type SyntheticEvent, useId } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { parseInviteLink } from '../app/invite';
import { messages } from '../app/messages';
import { RestoreBackup, type RestoreBackupProps } from '../app/RestoreBackup';
import { routeHref } from '../app/router';
import { Field, PageHeader } from '../app/ui';
import type { Persistence } from '../platform/persist';

/** A group as Start lists it. Name and title are null until its genesis reaches the relay. */
export interface StartGroup {
  readonly groupId: string;
  readonly name: string | null;
  readonly title: string | null;
  /** Whether this device's leave waits for the relay (#77); the group goes once it's there. */
  readonly leaving: boolean;
}

/** Props for {@link Start}. */
export interface StartProps {
  /** The groups on this device. */
  readonly groups: readonly StartGroup[];
  /** Opens a pasted invite's seed. It travels in memory, never through the address bar. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** What the browser said about keeping this site's data, or null before it answered. */
  readonly persistence?: Persistence | null;
  /** Restores a backup file (#78); without it, Start offers no Restore. */
  readonly onRestore?: RestoreBackupProps['onRestore'];
  /** The recovery alert (#118), first on the page while a recovery of this person waits; none when absent. */
  readonly alert?: ReactNode;
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
 * leave waits for the relay (#77), Create group, a card that opens Personal
 * (#93), Join with an invite link, a field to paste one into, Restore a
 * backup (#78), Link to my other device (#96), Recover with my contacts
 * (#118), and a quiet link to Settings. While a recovery of this person
 * waits, its alert comes first (#118). The app reads the clipboard only through that paste. When the
 * browser may clear the app's data, one quiet line says so (ADR-0029).
 */
export function Start(props: StartProps) {
  const { groups, onOpenInvite, persistence = null, onRestore, alert } = props;
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
        {alert}
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
