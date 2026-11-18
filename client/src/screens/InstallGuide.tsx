import { useEffect, useEffectEvent, useId, useMemo, useState } from 'react';

import type { FoundGroup, InviteLookup } from '../app/actions';
import { CopyLink } from '../app/CopyLink';
import { HELD_LINKS, type HeldLinkName } from '../app/heldLinks';
import { messages } from '../app/messages';
import { readsAsVoteToken, voteLinkOf } from '../app/voteLink';
import { PageHeader } from '../app/ui';
import { doorLinkOf, type DoorView, parseDoorPayload } from '../door/page';
import { DoorExcerpt } from './FrontDoor';
import { InvitePreview } from './InvitePreview';

/**
 * How the page was opened: plainly; with a link whose seed is held in memory,
 * an invite, a reconcile card or a follow link (#280, `heldLinks.ts`); with
 * one of those that can't be read, and its kind; with a front door's link
 * (#121), whose address is no secret; or with a vote link (#472), whose token
 * names no group.
 */
export type Arrival =
  | { readonly kind: 'plain' }
  | { readonly kind: HeldLinkName; readonly seed: Uint8Array }
  | { readonly kind: 'damaged'; readonly link: HeldLinkName }
  | { readonly kind: 'door'; readonly payload: string }
  | { readonly kind: 'vote'; readonly payload: string };

/** Props for {@link InstallGuide}. */
export interface InstallGuideProps {
  /** How the page was opened. An invite, a card or a follow link is held in memory, out of the address bar. */
  readonly arrival: Arrival;
  /** The app's origin: its address, and the start of invite links. */
  readonly origin: string;
  /** Opens the invite's envelope for its preview. It stores nothing and makes no keys. */
  readonly lookup: (seed: Uint8Array) => Promise<InviteLookup>;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Reads a front door's page (#121). It stores nothing and makes no keys. */
  readonly readDoor: (address: Uint8Array) => Promise<DoorView>;
}

type Phase = { readonly kind: 'loading' } | InviteLookup;

/** Where reading a front door has got to. */
type DoorPhase = { readonly kind: 'loading' } | DoorView | { readonly kind: 'offline' };

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

/** What a held link says once it can't be used, by its kind: its own page's line (#280). */
const UNUSABLE: Readonly<Record<HeldLinkName, string>> = {
  invite: messages.join.badLink,
  card: messages.bring.badLink,
  follow: messages.follow.badLink,
};

interface HeldCopyProps {
  readonly name: HeldLinkName;
  readonly link: string;
  readonly copyText: InstallGuideProps['copyText'];
}

/** A held link's field and its Copy, to paste into the installed app (#76, #280). */
function HeldCopy({ name, link, copyText }: HeldCopyProps) {
  const words = messages.install.held[name];
  return (
    <CopyLink
      link={link}
      label={words.label}
      hint={messages.install.heldHint}
      button={words.copy}
      primary
      copyText={copyText}
    />
  );
}

/**
 * A held link with no preview (#280): a card's or a follow link's, whose own
 * page in the installed app shows what it holds before anything happens, or
 * an invite's while the relay can't be reached.
 */
function HeldSection(props: HeldCopyProps) {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.install.held[props.name].heading}
      </h2>
      <HeldCopy {...props} />
    </section>
  );
}

interface InviteSectionProps {
  readonly group: FoundGroup;
  readonly link: string;
  readonly copyText: InstallGuideProps['copyText'];
}

/** The invite's preview, as the relay showed it, and the link to copy into the installed app. */
function InviteSection({ group, link, copyText }: InviteSectionProps) {
  const heading = useId();
  return (
    <section className="stack" aria-labelledby={heading}>
      <div className="page-head">
        <p className="eyebrow">{messages.join.eyebrow}</p>
        <h2 id={heading} className="heading-2">
          <bdi>{group.preview.groupName}</bdi>
        </h2>
      </div>
      <InvitePreview preview={group.preview} />
      <HeldCopy name="invite" link={link} copyText={copyText} />
    </section>
  );
}

interface InviteAreaProps extends Pick<InstallGuideProps, 'origin' | 'copyText'> {
  readonly seed: Uint8Array;
  readonly phase: Phase;
}

function InviteArea({ seed, phase, origin, copyText }: InviteAreaProps) {
  const link = HELD_LINKS.invite.link(origin, seed);
  switch (phase.kind) {
    case 'loading':
      return (
        <p role="status" className="lede">
          {messages.join.loading}
        </p>
      );
    case 'missing':
      return <ExpiredLink name="invite" origin={origin} copyText={copyText} />;
    case 'found':
      return <InviteSection group={phase.group} link={link} copyText={copyText} />;
    case 'offline':
    case 'joined':
      return <HeldSection name="invite" link={link} copyText={copyText} />;
  }
}

interface ExpiredLinkProps extends Pick<InstallGuideProps, 'origin' | 'copyText'> {
  readonly name: HeldLinkName;
}

/** The link's own expired-or-damaged line (M2-03's, for an invite), without it, then the app's address. */
function ExpiredLink({ name, origin, copyText }: ExpiredLinkProps) {
  return (
    <>
      <p className="lede">{UNUSABLE[name]}</p>
      <CopyAppAddress origin={origin} copyText={copyText} />
    </>
  );
}

/** Reads a front door's page once, with nothing kept on the device (#121). */
function useDoorRead(address: Uint8Array | null, read: InstallGuideProps['readDoor']): DoorPhase {
  const [phase, setPhase] = useState<DoorPhase>({ kind: 'loading' });
  const readNow = useEffectEvent((which: Uint8Array) => read(which));
  useEffect(() => {
    if (address === null) return;
    let live = true;
    readNow(address).then(
      (view) => {
        if (live) setPhase(view);
      },
      () => {
        if (live) setPhase({ kind: 'offline' });
      },
    );
    return () => {
      live = false;
    };
  }, [address]);
  return phase;
}

interface DoorAreaProps extends Pick<InstallGuideProps, 'origin' | 'copyText' | 'readDoor'> {
  readonly payload: string;
}

/**
 * A front door opened outside the installed app (#121): its page, as the
 * front door shows it, with its link to copy into the installed app instead
 * of the form. A closed or damaged door says so, then the app's address.
 */
function DoorArea({ payload, origin, copyText, readDoor }: DoorAreaProps) {
  const address = useMemo(() => parseDoorPayload(payload), [payload]);
  const phase = useDoorRead(address, readDoor);
  const heading = useId();
  const { door } = messages;
  if (address === null || phase.kind === 'closed') {
    return (
      <>
        <p className="lede">{address === null ? door.damaged : door.closed}</p>
        <CopyAppAddress origin={origin} copyText={copyText} />
      </>
    );
  }
  if (phase.kind === 'loading') {
    return (
      <p role="status" className="lede">
        {door.loading}
      </p>
    );
  }
  return (
    <section className="stack" aria-labelledby={heading}>
      <div className="page-head">
        <p className="eyebrow">{door.eyebrow}</p>
        <h2 id={heading} className="heading-2">
          {phase.kind === 'open' ? <bdi>{phase.page.name}</bdi> : door.installLabel}
        </h2>
      </div>
      {phase.kind === 'open' ? <DoorExcerpt page={phase.page} /> : null}
      <CopyLink
        link={doorLinkOf(origin, address)}
        label={door.installLabel}
        hint={door.installHint}
        button={door.copyLink}
        primary
        copyText={copyText}
      />
    </section>
  );
}

/** The last step: open the app, and with a held link or a door, where to paste its link. */
function lastStep(arrival: Arrival, phase: Phase): string {
  switch (arrival.kind) {
    case 'door':
      return messages.door.openToApply;
    case 'invite':
      // Pasting the invite into the link bar is the next step only while the link still works.
      return phase.kind === 'missing' ? messages.install.open : messages.install.openToPaste.invite;
    case 'card':
    case 'follow':
      return messages.install.openToPaste[arrival.kind];
    case 'vote':
      return readsAsVoteToken(arrival.payload)
        ? messages.install.openToPaste.vote
        : messages.install.open;
    case 'damaged':
    case 'plain':
      return messages.install.open;
  }
}

/** What follows the steps: the held link, the door, a damaged link's line, or the app's address. */
function ArrivalArea(props: InstallGuideProps & { readonly phase: Phase }) {
  const { arrival, origin, copyText, readDoor, phase } = props;
  switch (arrival.kind) {
    case 'invite':
      return <InviteArea seed={arrival.seed} phase={phase} origin={origin} copyText={copyText} />;
    case 'card':
    case 'follow': {
      const link = HELD_LINKS[arrival.kind].link(origin, arrival.seed);
      return <HeldSection name={arrival.kind} link={link} copyText={copyText} />;
    }
    case 'damaged':
      return <ExpiredLink name={arrival.link} origin={origin} copyText={copyText} />;
    case 'door':
      return (
        <DoorArea
          payload={arrival.payload}
          origin={origin}
          copyText={copyText}
          readDoor={readDoor}
        />
      );
    case 'vote':
      return <VoteArea payload={arrival.payload} origin={origin} copyText={copyText} />;
    case 'plain':
      return <CopyAppAddress origin={origin} copyText={copyText} />;
  }
}

interface VoteAreaProps extends Pick<InstallGuideProps, 'origin' | 'copyText'> {
  readonly payload: string;
}

/**
 * A vote link opened outside the installed app (#472): the link to copy into
 * the installed app, which opens it only if it's in the vote's group. A token
 * that doesn't read leaves only the app's address.
 */
function VoteArea({ payload, origin, copyText }: VoteAreaProps) {
  const heading = useId();
  if (!readsAsVoteToken(payload)) return <CopyAppAddress origin={origin} copyText={copyText} />;
  const words = messages.install.held.vote;
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {words.heading}
      </h2>
      <CopyLink
        link={voteLinkOf(origin, payload)}
        label={words.label}
        hint={messages.install.heldHint}
        button={words.copy}
        primary
        copyText={copyText}
      />
    </section>
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
 * preview, and its link to copy into the installed app; a reconcile card's
 * or a follow link shows its link to copy (#280), with no preview, since its
 * own page there shows what it holds before anything happens; a front door's
 * link shows its page, and its link to copy, in place of the form (#121); and
 * a vote link shows its link to copy (#472).
 */
export function InstallGuide(props: InstallGuideProps) {
  const { arrival, lookup } = props;
  const phase = useInviteLookup(arrival, lookup);
  const steps = [...messages.install.steps, lastStep(arrival, phase)];
  return (
    <main className="shell" data-scene="sky">
      <PageHeader title={messages.install.title} pageTitle={messages.install.pageTitle} />
      <p className="lede">{messages.install.otherApp}</p>
      <ol className="steps">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <ArrivalArea {...props} phase={phase} />
      <p className="caption">{messages.install.why}</p>
    </main>
  );
}
