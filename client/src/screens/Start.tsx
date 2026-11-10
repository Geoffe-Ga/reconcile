import { type SyntheticEvent, useId } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { parseInviteLink } from '../app/invite';
import { messages } from '../app/messages';
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

/** M2-03's expired-or-damaged line for anything that isn't an invite link. It never repeats the text. */
function checkInvite(text: string): string | null {
  return parseInviteLink(text) === null ? messages.join.badLink : null;
}

/**
 * Start (`#/`): every group on this device by name, each marked while its
 * leave waits for the relay (#77), Create group, and Join with an invite
 * link, a field to paste one into. The app reads the clipboard only through
 * that paste. When the browser may clear the app's data, one quiet line says
 * so (ADR-0029).
 */
export function Start({ groups, onOpenInvite, persistence = null }: StartProps) {
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
      {persistence === null || persistence === 'granted' ? null : (
        <p className="caption">{messages.start.mayClear}</p>
      )}
    </main>
  );
}
