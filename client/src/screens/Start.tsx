import { type SyntheticEvent, useId } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { type Invite, parseInviteLink } from '../app/invite';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { Field, PageHeader } from '../app/ui';

/** A group as Start lists it. Name and title are null until its genesis reaches the relay. */
export interface StartGroup {
  readonly groupId: string;
  readonly name: string | null;
  readonly title: string | null;
}

/** Props for {@link Start}. */
export interface StartProps {
  /** The groups on this device. */
  readonly groups: readonly StartGroup[];
  /** Opens a pasted invite. The invite travels in memory, never through the address bar. */
  readonly onOpenInvite: (invite: Invite) => void;
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
      </Link>
    </li>
  );
}

function checkInvite(text: string): string | null {
  return parseInviteLink(text) === null ? messages.start.inviteInvalid : null;
}

/** Start (`#/`): the groups on this device, Create group, and a field to paste an invite link. */
export function Start({ groups, onOpenInvite }: StartProps) {
  const inviteHeading = useId();

  const openInvite = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('invite');
    const invite = typeof text === 'string' ? parseInviteLink(text) : null;
    if (invite !== null) onOpenInvite(invite);
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
    </main>
  );
}
