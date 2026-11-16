/**
 * Follow a coalition (`#follow/{seed}`; #124, ADR-0003, ADR-0053, ADR-0075
 * §5): what a coalition's follow link opens.
 *
 * It reads the seed, takes it out of the address bar, opens the link's
 * envelope and shows its preview: the coalition's name, its member groups
 * and its first section. Every word came from a participant's device, so it
 * renders as plain text inside `<bdi>`, never as Markdown or HTML. Then it
 * says what following shows of the person, which is nothing, beside Follow
 * and Not now. Nothing is stored, and no key made, before Follow; Not now
 * drops the link. A seed that doesn't parse shows the expired-or-damaged
 * line and fetches nothing.
 */
import { type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import type { FollowLookup, FoundFollow } from '../app/follow';
import { messages } from '../app/messages';
import { replaceRoute, routeHref } from '../app/router';
import { BackLink, PageHeader } from '../app/ui';
import { parseFollowPayload } from '../coalition/follow';

/** Props for {@link Follow}. */
export interface FollowProps {
  /** The seed from `#follow/{seed}`, as text, or null once it has left the address bar. */
  readonly payload: string | null;
  /** The seed of a follow link pasted on Start, handed over in memory, for when there's no payload. */
  readonly heldSeed: Uint8Array | null;
  /** Opens the link the seed names, once per link and once per Try again. */
  readonly lookup: (seed: Uint8Array) => Promise<FollowLookup>;
  /** Follows the coalition found; false when that didn't finish. */
  readonly onFollow: (found: FoundFollow) => Promise<boolean>;
  /** Not now: drops the link held in memory and goes back to Start, writing nothing. */
  readonly onNotNow: () => void;
}

type Phase = { readonly kind: 'loading' } | FollowLookup;

const { follow } = messages;

/** A plain page: the way back, a title, one line, and anything after it. */
function Plain(props: {
  readonly title: string;
  readonly line: string;
  readonly children?: ReactNode;
}) {
  return (
    <main className="shell" data-scene="sky">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={props.title} pageTitle={follow.pageTitle} />
      <div className="stack">
        <p className="lede">{props.line}</p>
        {props.children}
      </div>
    </main>
  );
}

/**
 * The preview as plain text: the coalition's member groups, then its first
 * section, each in its own `<bdi>`.
 */
function Preview({ found }: { readonly found: FoundFollow }) {
  const { preview } = found;
  return (
    <div className="card invite-preview">
      <div className="follow-groups">
        <p className="eyebrow">{follow.groupsLabel}</p>
        <ul className="coalition-groups-line">
          {preview.groups.map((group, index) => (
            <li key={index}>
              {index === 0 ? null : (
                <span className="coalition-groups-separator" aria-hidden="true">
                  {messages.coalitions.groupsSeparator}
                </span>
              )}
              <bdi>{group}</bdi>
            </li>
          ))}
        </ul>
      </div>
      {preview.excerpt === '' ? null : (
        <div className="invite-document">
          <p className="eyebrow">{follow.statementLabel}</p>
          <p className="invite-excerpt">
            <bdi>{preview.excerpt}</bdi>
          </p>
        </div>
      )}
    </div>
  );
}

interface FollowFormProps {
  readonly found: FoundFollow;
  readonly onFollow: FollowProps['onFollow'];
  readonly onNotNow: FollowProps['onNotNow'];
}

/** "Follow this coalition?", what following shows of the person, Follow and Not now. */
function FollowFields({ found, onFollow, onNotNow }: FollowFormProps) {
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const question = useId();
  const hint = useId();
  const notNowHint = useId();

  const press = async () => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    const followed = await onFollow(found).catch(() => false);
    busy.current = false;
    if (!followed) setFailed(true);
  };

  return (
    <section className="join-decide stack" aria-labelledby={question}>
      <h2 id={question} className="heading-2">
        {follow.question}
      </h2>
      <p id={hint} className="lede">
        {follow.hint}
      </p>
      {failed ? (
        <p role="alert" className="form-error">
          {follow.failed}
        </p>
      ) : null}
      <div className="row form-actions">
        <Button
          className="button button-primary"
          aria-describedby={hint}
          onPress={() => {
            void press();
          }}
        >
          {follow.submit}
        </Button>
        <Button
          className="button button-quiet"
          aria-describedby={notNowHint}
          onPress={() => {
            // Once Follow is under way, the coalition is being kept: Not now waits it out.
            if (!busy.current) onNotNow();
          }}
        >
          {follow.notNow}
        </Button>
      </div>
      <p id={notNowHint} className="caption">
        {follow.notNowHint}
      </p>
    </section>
  );
}

/** The opened link: the coalition's name, its preview, then whether to follow. */
function FollowForm(props: FollowFormProps) {
  return (
    <main className="shell" data-scene="sky">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader
        eyebrow={follow.eyebrow}
        title={props.found.preview.name}
        pageTitle={follow.pageTitle}
      />
      <Preview found={props.found} />
      <FollowFields {...props} />
    </main>
  );
}

/** A coalition this device already reads: it took in what the link carried, and opens. */
function Held({ coalitionId }: { readonly coalitionId: string }) {
  return (
    <Plain title={follow.heldTitle} line={follow.held}>
      <div>
        <Link
          className="button button-primary"
          href={routeHref({ name: 'coalition', coalitionId })}
        >
          {follow.open}
        </Link>
      </div>
    </Plain>
  );
}

/** The page for one step of opening the link. */
function Step({
  phase,
  retry,
  ...form
}: Omit<FollowFormProps, 'found'> & {
  readonly phase: Phase;
  readonly retry: () => void;
}) {
  switch (phase.kind) {
    case 'loading':
      return (
        <main className="shell" data-scene="sky" aria-busy="true">
          <PageHeader title={follow.loading} pageTitle={follow.pageTitle} />
        </main>
      );
    case 'missing':
      return <Plain title={follow.badLinkTitle} line={follow.badLink} />;
    case 'offline':
      return (
        <Plain title={follow.offlineTitle} line={follow.offline}>
          <div>
            <Button className="button button-primary" onPress={retry}>
              {follow.retry}
            </Button>
          </div>
        </Plain>
      );
    case 'held':
      return <Held coalitionId={phase.coalitionId} />;
    case 'found':
      return <FollowForm found={phase.found} {...form} />;
  }
}

/**
 * Follow a coalition (`#follow/{seed}`; #124): reads the seed, takes it out
 * of the address bar, opens the link and shows its preview as plain text,
 * then asks whether to follow. Nothing is stored before Follow.
 */
export function Follow({ payload, heldSeed, lookup, onFollow, onNotNow }: FollowProps) {
  const [source, setSource] = useState(() => ({
    payload,
    seed: payload === null ? heldSeed : parseFollowPayload(payload),
  }));
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // A new link can arrive while this shows. The payload going back to null is this screen clearing it.
  if (payload !== null && payload !== source.payload) {
    setSource({ payload, seed: parseFollowPayload(payload) });
    setPhase({ kind: 'loading' });
  }
  const { seed } = source;

  useEffect(() => {
    if (payload !== null) replaceRoute({ name: 'follow', payload: null });
  }, [payload]);

  const read = useEffectEvent((link: Uint8Array) => lookup(link));

  useEffect(() => {
    if (seed === null) return;
    let live = true;
    read(seed).then(
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
  }, [seed, attempt]);

  if (seed === null) return <Plain title={follow.badLinkTitle} line={follow.badLink} />;
  const retry = () => {
    setPhase({ kind: 'loading' });
    setAttempt((count) => count + 1);
  };
  return <Step phase={phase} retry={retry} onFollow={onFollow} onNotNow={onNotNow} />;
}
