import { type SyntheticEvent, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { type Invite, parseInvitePayload } from '../app/invite';
import { messages } from '../app/messages';
import { replaceRoute, routeHref } from '../app/router';
import { BackLink, Field, PageHeader } from '../app/ui';

/** Props for {@link Join}. */
export interface JoinProps {
  /** The payload from `#/join/{payload}`, or null once it has left the address bar. */
  readonly payload: string | null;
  /** An invite pasted on Start, handed over in memory, for when there's no payload. */
  readonly heldInvite: Invite | null;
  /** Reads the invite's mailbox, once per invite and once per Try again. */
  readonly lookup: (invite: Invite) => Promise<InviteLookup>;
  /** Joins the found group under a name; false when that didn't finish. */
  readonly onJoin: (invite: Invite, group: FoundGroup, name: string) => Promise<boolean>;
}

type Phase = { readonly kind: 'loading' } | InviteLookup;

const checkName = (value: string) => (value.trim() === '' ? messages.join.nameMissing : null);

function Loading() {
  return (
    <main className="shell" aria-busy="true">
      <PageHeader title={messages.join.loading} pageTitle={messages.join.pageTitle} />
    </main>
  );
}

/** A link that's damaged, expired or empty. It never repeats the link back. */
function BadLink() {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.join.badLinkTitle} pageTitle={messages.join.pageTitle} />
      <p className="lede">{messages.join.badLink}</p>
    </main>
  );
}

function Offline({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.join.offlineTitle} pageTitle={messages.join.pageTitle} />
      <div className="stack">
        <p className="lede">{messages.join.offline}</p>
        <Button className="button button-primary" onPress={onRetry}>
          {messages.join.retry}
        </Button>
      </div>
    </main>
  );
}

function AlreadyJoined({ groupId }: { readonly groupId: string }) {
  return (
    <main className="shell">
      <PageHeader title={messages.join.memberTitle} pageTitle={messages.join.pageTitle} />
      <div className="stack">
        <p className="lede">{messages.join.alreadyJoined}</p>
        <Link className="button button-primary" href={routeHref({ name: 'group', groupId })}>
          {messages.join.openGroup}
        </Link>
      </div>
    </main>
  );
}

interface JoinFormProps {
  readonly invite: Invite;
  readonly group: FoundGroup;
  readonly onJoin: JoinProps['onJoin'];
}

function JoinForm({ invite, group, onJoin }: JoinFormProps) {
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  const join = async (name: string) => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    const joined = await onJoin(invite, group, name).catch(() => false);
    busy.current = false;
    if (!joined) setFailed(true);
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    void join(typeof name === 'string' ? name.trim() : '');
  };

  return (
    <main className="shell">
      <PageHeader
        eyebrow={messages.join.eyebrow}
        title={group.name}
        pageTitle={messages.join.pageTitle}
      />
      <div className="card">
        <p className="eyebrow">{messages.join.documentLabel}</p>
        <p className="heading-2">
          <bdi>{group.title}</bdi>
        </p>
      </div>
      <Form className="form" onSubmit={submit}>
        <Field
          name="name"
          label={messages.join.nameLabel}
          hint={messages.join.nameHint}
          autoComplete="off"
          isRequired
          validate={checkName}
        />
        <p className="lede">{messages.join.visibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.join.failed}
          </p>
        ) : null}
        <Button type="submit" className="button button-primary">
          {messages.join.submit}
        </Button>
      </Form>
    </main>
  );
}

/**
 * Join (`#/join/{payload}`): reads the invite, takes its secret out of the
 * address bar, finds the group in its mailbox, then asks for a name.
 */
export function Join({ payload, heldInvite, lookup, onJoin }: JoinProps) {
  const [source, setSource] = useState(() => ({
    payload,
    invite: payload === null ? heldInvite : parseInvitePayload(payload),
  }));
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // A new link can arrive while Join shows, as when an installed app reuses its
  // window. The payload going back to null is just this screen clearing it.
  if (payload !== null && payload !== source.payload) {
    setSource({ payload, invite: parseInvitePayload(payload) });
    setPhase({ kind: 'loading' });
  }
  const { invite } = source;

  useEffect(() => {
    if (payload !== null) replaceRoute({ name: 'join', payload: null });
  }, [payload]);

  // Reads the latest `lookup` without making a new function read the mailbox again.
  const read = useEffectEvent((which: Invite) => lookup(which));

  useEffect(() => {
    if (invite === null) return;
    let live = true;
    read(invite).then(
      (found) => {
        if (live) setPhase(found);
      },
      () => {
        if (live) setPhase({ kind: 'offline' });
      },
    );
    return () => {
      live = false;
    };
  }, [invite, attempt]);

  const retry = () => {
    setPhase({ kind: 'loading' });
    setAttempt((count) => count + 1);
  };

  if (invite === null) return <BadLink />;
  switch (phase.kind) {
    case 'loading':
      return <Loading />;
    case 'missing':
      return <BadLink />;
    case 'offline':
      return <Offline onRetry={retry} />;
    case 'joined':
      return <AlreadyJoined groupId={phase.groupId} />;
    case 'found':
      return <JoinForm invite={invite} group={phase.group} onJoin={onJoin} />;
  }
}
