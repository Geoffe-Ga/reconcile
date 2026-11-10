import { useEffect, useEffectEvent, useId, useState } from 'react';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { CopyLink } from '../app/CopyLink';
import { inviteLink } from '../app/invite';
import { messages } from '../app/messages';
import { PageHeader } from '../app/ui';
import { InvitePreview } from './InvitePreview';

/** How the page was opened: plainly, with an invite link, or with one that can't be read. */
export type Arrival =
  | { readonly kind: 'plain' }
  | { readonly kind: 'invite'; readonly seed: Uint8Array }
  | { readonly kind: 'damaged' };

/** Props for {@link InstallGuide}. */
export interface InstallGuideProps {
  /** How the page was opened. An invite is held in memory, out of the address bar. */
  readonly arrival: Arrival;
  /** The app's origin: its address, and the start of invite links. */
  readonly origin: string;
  /** Opens the invite's envelope for its preview. It stores nothing and makes no keys. */
  readonly lookup: (seed: Uint8Array) => Promise<InviteLookup>;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
}

type Phase = { readonly kind: 'loading' } | InviteLookup;

/** Copies the app's own address, for leaving an in-app browser for Safari. */
function CopyAppAddress({ origin, copyText }: Pick<InstallGuideProps, 'origin' | 'copyText'>) {
  return (
    <CopyLink
      link={`${origin}/`}
      label={messages.install.appLabel}
      hint={messages.install.appHint}
      button={messages.install.copyApp}
      primary={false}
      copyText={copyText}
    />
  );
}

interface InviteSectionProps {
  readonly group: FoundGroup | null;
  readonly link: string;
  readonly copyText: InstallGuideProps['copyText'];
}

/** The invite's preview, when the relay showed one, and the link to copy into the installed app. */
function InviteSection({ group, link, copyText }: InviteSectionProps) {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      {group === null ? (
        <h2 id={heading} className="heading-3">
          {messages.install.inviteHeading}
        </h2>
      ) : (
        <>
          <div className="page-head">
            <p className="eyebrow">{messages.join.eyebrow}</p>
            <h2 id={heading} className="heading-2">
              <bdi>{group.preview.groupName}</bdi>
            </h2>
          </div>
          <InvitePreview preview={group.preview} />
        </>
      )}
      <CopyLink
        link={link}
        label={messages.install.inviteLabel}
        hint={messages.install.inviteHint}
        button={messages.install.copyInvite}
        primary
        copyText={copyText}
      />
    </section>
  );
}

interface InviteAreaProps extends Pick<InstallGuideProps, 'origin' | 'copyText'> {
  readonly seed: Uint8Array;
  readonly phase: Phase;
}

function InviteArea({ seed, phase, origin, copyText }: InviteAreaProps) {
  switch (phase.kind) {
    case 'loading':
      return (
        <p role="status" className="lede">
          {messages.join.loading}
        </p>
      );
    case 'missing':
      return <ExpiredLink origin={origin} copyText={copyText} />;
    case 'found':
      return (
        <InviteSection group={phase.group} link={inviteLink(origin, seed)} copyText={copyText} />
      );
    case 'offline':
    case 'joined':
      return <InviteSection group={null} link={inviteLink(origin, seed)} copyText={copyText} />;
  }
}

/** M2-03's expired-or-damaged line, without the link, then the app's address. */
function ExpiredLink({ origin, copyText }: Pick<InstallGuideProps, 'origin' | 'copyText'>) {
  return (
    <>
      <p className="lede">{messages.join.badLink}</p>
      <CopyAppAddress origin={origin} copyText={copyText} />
    </>
  );
}

/** Reads the invite's preview once, with nothing kept on the device. */
function useInviteLookup(arrival: Arrival, lookup: InstallGuideProps['lookup']): Phase {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const seed = arrival.kind === 'invite' ? arrival.seed : null;
  const read = useEffectEvent((which: Uint8Array) => lookup(which));
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
  }, [seed]);
  return phase;
}

/**
 * The install guide (ADR-0029, spec §8.1): what an iPhone or iPad shows in
 * any browser outside the installed app, where nothing may create keys. One
 * guide for every iOS browser. An invite link opened here still shows its
 * preview, and its link to copy into the installed app.
 */
export function InstallGuide({ arrival, origin, lookup, copyText }: InstallGuideProps) {
  const phase = useInviteLookup(arrival, lookup);
  // Join with an invite link is the next step only while the link still works.
  const toJoin = arrival.kind === 'invite' && phase.kind !== 'missing';
  const steps = [
    ...messages.install.steps,
    toJoin ? messages.install.openToJoin : messages.install.open,
  ];
  return (
    <main className="shell">
      <PageHeader title={messages.install.title} pageTitle={messages.install.pageTitle} />
      <p className="lede">{messages.install.otherApp}</p>
      <ol className="steps">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {arrival.kind === 'invite' ? (
        <InviteArea seed={arrival.seed} phase={phase} origin={origin} copyText={copyText} />
      ) : arrival.kind === 'damaged' ? (
        <ExpiredLink origin={origin} copyText={copyText} />
      ) : (
        <CopyAppAddress origin={origin} copyText={copyText} />
      )}
      <p className="caption">{messages.install.why}</p>
    </main>
  );
}
