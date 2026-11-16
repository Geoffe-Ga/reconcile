import {
  type SyntheticEvent,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Form, Link } from 'react-aria-components';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { foldInvite } from '../app/foldInvite';
import { parseInvitePayload } from '../app/invite';
import { InviteDocument } from '../app/InviteDocument';
import { LevelPicker } from '../app/LevelPicker';
import { messages } from '../app/messages';
import { replaceRoute, routeHref } from '../app/router';
import { BackLink, Field, PageHeader } from '../app/ui';
import { DEFAULT_JOIN_LEVEL, type Level } from '../engine/capabilities';
import { DEFAULT_RULES } from '../engine/rules';
import { InvitePreview } from './InvitePreview';

/** Props for {@link Join}. */
export interface JoinProps {
  /** The seed from `#join/{seed}`, as text, or null once it has left the address bar. */
  readonly payload: string | null;
  /** The seed of an invite pasted on Start, handed over in memory, for when there's no payload. */
  readonly heldSeed: Uint8Array | null;
  /** Opens the invite the seed names, once per invite and once per Try again. */
  readonly lookup: (seed: Uint8Array) => Promise<InviteLookup>;
  /** Joins the found group under a name, at a level; false when that didn't finish. */
  readonly onJoin: (group: FoundGroup, name: string, level: Level) => Promise<boolean>;
  /** Not now (#91): drops the invite held in memory and goes back to Start, writing nothing. */
  readonly onNotNow: () => void;
}

type Phase = { readonly kind: 'loading' } | InviteLookup;

const checkName = (value: string) => (value.trim() === '' ? messages.join.nameMissing : null);

function Loading() {
  return (
    <main className="shell" data-scene="sky" aria-busy="true">
      <PageHeader title={messages.join.loading} pageTitle={messages.join.pageTitle} />
    </main>
  );
}

/** A link that's damaged, expired or empty. It never repeats the link back. */
function BadLink() {
  return (
    <main className="shell" data-scene="sky">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.join.badLinkTitle} pageTitle={messages.join.pageTitle} />
      <p className="lede">{messages.join.badLink}</p>
    </main>
  );
}

function Offline({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <main className="shell" data-scene="sky">
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
    <main className="shell" data-scene="sky">
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
  readonly group: FoundGroup;
  readonly onJoin: JoinProps['onJoin'];
  readonly onNotNow: JoinProps['onNotNow'];
}

/**
 * The invite once opened: the group's name, then the preview card with the
 * whole founding Document as it reads now under its title, folded in memory
 * from the envelope (#91). The Document's heading takes focus. Then "Do you
 * share enough of this to join?" over the name, the level, Join and Not now.
 * Entries that hold no genesis show the expired-or-damaged line instead.
 */
function JoinForm({ group, onJoin, onNotNow }: JoinFormProps) {
  const atoms = useMemo(
    () => foldInvite({ ...group.page, cleared: group.cleared }),
    [group.page, group.cleared],
  );
  if (atoms === null) return <BadLink />;
  return (
    <main className="shell" data-scene="sky">
      <PageHeader
        eyebrow={messages.join.eyebrow}
        title={group.preview.groupName}
        pageTitle={messages.join.pageTitle}
        takesFocus={false}
      />
      <InvitePreview preview={group.preview}>
        <InviteDocument atoms={atoms} />
      </InvitePreview>
      <JoinFields group={group} onJoin={onJoin} onNotNow={onNotNow} />
    </main>
  );
}

/** The fit question, then the name, the level, who sees them, Join and Not now. */
function JoinFields({ group, onJoin, onNotNow }: JoinFormProps) {
  const [failed, setFailed] = useState(false);
  const [level, setLevel] = useState<Level>(DEFAULT_JOIN_LEVEL);
  const busy = useRef(false);
  const question = useId();
  const notNowHint = useId();

  const join = async (name: string) => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    const joined = await onJoin(group, name, level).catch(() => false);
    busy.current = false;
    if (!joined) setFailed(true);
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    void join(typeof name === 'string' ? name.trim() : '');
  };

  return (
    <section className="join-decide stack" aria-labelledby={question}>
      <h2 id={question} className="heading-2">
        {messages.join.question}
      </h2>
      <Form className="form" onSubmit={submit}>
        <Field
          name="name"
          label={messages.join.nameLabel}
          hint={messages.join.nameHint}
          autoComplete="off"
          isRequired
          validate={checkName}
        />
        <LevelPicker value={level} onChange={setLevel} />
        <p className="lede">{messages.join.visibility(DEFAULT_RULES.ballotExpiryDays)}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.join.failed}
          </p>
        ) : null}
        <div className="row form-actions">
          <Button type="submit" className="button button-primary">
            {messages.join.submit}
          </Button>
          <Button
            className="button button-quiet"
            aria-describedby={notNowHint}
            onPress={() => {
              // Once Join is under way, the group is being kept: Not now waits it out.
              if (!busy.current) onNotNow();
            }}
          >
            {messages.join.notNow}
          </Button>
        </div>
        <p id={notNowHint} className="caption">
          {messages.join.notNowHint}
        </p>
      </Form>
    </section>
  );
}

/**
 * Join (`#join/{seed}`): reads the seed, takes it out of the address bar,
 * opens the invite's envelope, shows its preview and the whole founding
 * Document (#91), then asks "Do you share enough of this to join?" over a
 * name and how involved the person wants to be, preselecting Collaborator.
 * A seed that doesn't parse shows the expired-or-damaged line and fetches
 * nothing. Nothing is stored, and no key made, before Join; Not now drops the
 * invite.
 */
export function Join({ payload, heldSeed, lookup, onJoin, onNotNow }: JoinProps) {
  const [source, setSource] = useState(() => ({
    payload,
    invite: payload === null ? heldSeed : parseInvitePayload(payload),
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
  const read = useEffectEvent((seed: Uint8Array) => lookup(seed));

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
      return <JoinForm group={phase.group} onJoin={onJoin} onNotNow={onNotNow} />;
  }
}
