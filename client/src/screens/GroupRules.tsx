import { useId } from 'react';
import { Link, VisuallyHidden } from 'react-aria-components';

import { CopyLink } from '../app/CopyLink';
import { messages } from '../app/messages';
import { optInState, type OptInStanding } from '../app/optInLines';
import { routeHref } from '../app/router';
import { Named, SuspendedNote } from '../app/stewards';
import { BackLink, PageHeader } from '../app/ui';
import { addressOf, doorLinkOf } from '../door/page';
import { can, isSuspended } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';
import { listingHistory, listingInEffect } from '../engine/frontDoor';
import { displayName } from '../engine/names';
import { isOff, listedUnder, OPT_INS, type OptIn, openRulesProposal } from '../engine/optIns';
import { mayTurnOffNow } from '../engine/stewards';

/** Props for {@link GroupRules}. */
export interface GroupRulesProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The app's origin, which an open front door's link starts with (#121). */
  readonly origin?: string;
  /** Puts the front door's link on the clipboard; rejects when the browser blocks it. */
  readonly copyText?: (text: string) => Promise<void>;
}

interface CardProps extends GroupRulesProps {
  readonly optIn: OptIn;
}

/** Where the opt-in stands: "Now: Off", "Now: On" with the webhook's last 4, or a steward's narrowing. */
function Standing({ state, standing }: { state: GroupState; standing: OptInStanding }) {
  const { optIns } = messages;
  return (
    <div className="opt-in-standing">
      <p className="opt-in-now">
        {optIns.current} <span className="badge">{standing.label}</span>
      </p>
      {standing.kind === 'on' && standing.tail !== undefined ? (
        <p className="caption">
          {optIns.webhookEnding} <span className="webhook-tail">{standing.tail}</span>
        </p>
      ) : null}
      {standing.kind === 'narrowed' ? (
        <p className="opt-in-narrowed">
          <Named parts={optIns.narrowed} name={displayName(state, standing.by) ?? ''} />
        </p>
      ) : null}
    </div>
  );
}

/** "Your group is voting on this now.", and See the vote. */
function Voting({ state, proposal }: { state: GroupState; proposal: string }) {
  const route = { name: 'proposal', groupId: state.group ?? '', proposalId: proposal } as const;
  return (
    <div className="stack opt-in-actions">
      <p className="caption">{messages.optIns.voting}</p>
      <div className="row">
        <Link className="button button-secondary" href={routeHref(route)}>
          {messages.optIns.seeVote}
        </Link>
      </div>
    </div>
  );
}

/** Why there's no Propose link: suspended members read the note at the top; others, how to take part. */
function NotProposing({ state, me }: GroupRulesProps) {
  if (isSuspended(state, me)) return null;
  const line = can(state, me, 'vote') ? messages.levels.notProposing : messages.levels.following;
  return <p className="caption">{line}</p>;
}

/**
 * "Propose turning this on" (or off), a link to the composer and never a
 * toggle; and for a steward, Turn off now, wherever the fold would accept it.
 */
function Actions({ state, me, optIn }: CardProps) {
  const open = openRulesProposal(state, optIn);
  if (open !== undefined) return <Voting state={state} proposal={open.id} />;
  if (!can(state, me, 'propose')) return <NotProposing state={state} me={me} />;
  const { optIns } = messages;
  const groupId = state.group ?? '';
  const which = <VisuallyHidden>{optIns.forOptIn(optIns.inSentence[optIn])}</VisuallyHidden>;
  const on = isOff(optIn, state.rules.optIns[optIn]);
  return (
    <div className="row opt-in-actions">
      <Link
        className="button button-secondary"
        href={routeHref({ name: 'optIn', groupId, optIn, narrow: false })}
      >
        {on ? optIns.proposeOn : optIns.proposeOff} {which}
      </Link>
      {mayTurnOffNow(state, me, optIn) ? (
        <Link
          className="button button-secondary"
          href={routeHref({ name: 'optIn', groupId, optIn, narrow: true })}
        >
          {optIns.turnOffNow} {which}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * An open front door's link, to post anywhere, and whether its page shows the
 * count (#121): only while the door is open in effect.
 */
function DoorLink({ state, origin, copyText }: GroupRulesProps) {
  const door = state.optIns.frontDoor;
  if (door === false || origin === undefined || copyText === undefined) return null;
  const words = messages.door;
  return (
    <div className="stack door-link">
      <p className="caption">{door.showCount ? words.counted : words.uncounted}</p>
      <CopyLink
        link={doorLinkOf(origin, addressOf(door))}
        label={words.linkLabel}
        hint={words.linkHint}
        button={words.copyLink}
        primary={false}
        copyText={copyText}
      />
    </div>
  );
}

/**
 * "Listed on the public shelf…" while the front door is listed in effect
 * (#485; ADR-0081), or, once a steward's narrowing has ended its listing for
 * good, that it is off the shelf and how to list it again (#501).
 */
function Listed({ state }: { readonly state: GroupState }) {
  const { listing } = messages.optIns;
  if (listingHistory(state).ended) return <p className="caption">{listing.ended}</p>;
  if (listingInEffect(state) === null) return null;
  return <p className="caption">{listing.listed}</p>;
}

/** The listing link's words: list the door, again too once a narrowing ended its listing (#501), or take it off the shelf. */
function listingLinkLabel(state: GroupState): string {
  const { listing } = messages.optIns;
  const unlisted = listedUnder(state.rules.optIns.frontDoor) === null;
  return unlisted || listingHistory(state).ended ? listing.proposeList : listing.proposeUnlist;
}

/**
 * For someone who may propose, while the front door stands open and no
 * Proposal on it is open, a link to propose listing it or taking it off the
 * shelf (#485), and to list it again, in one vote, once a steward's
 * narrowing ended its listing (#501). It never asks a group to list: it is
 * one quiet link here, and nowhere else.
 */
function ListingLink({ state, me }: GroupRulesProps) {
  const standing = state.rules.optIns.frontDoor;
  const offer = can(state, me, 'propose') && openRulesProposal(state, 'frontDoor') === undefined;
  if (standing === false || !offer) return null;
  const groupId = state.group ?? '';
  const route = {
    name: 'optIn',
    groupId,
    optIn: 'frontDoor',
    narrow: false,
    listing: true,
  } as const;
  return (
    <div className="row opt-in-actions">
      <Link className="button button-secondary" href={routeHref(route)}>
        {listingLinkLabel(state)}
      </Link>
    </div>
  );
}

/**
 * Why the front door is closed, once a member's leave or removal closed it
 * (#288), and that a new Proposal to open it reopens it: until a door opens
 * again.
 */
function ClosedByLeave({ state }: { readonly state: GroupState }) {
  if (state.doorClosure === null) return null;
  return <p className="caption">{messages.optIns.doorClosedByLeave}</p>;
}

/** One opt-in: its name, where it stands, its warning, and what this member can do about it. */
function OptInCard(props: CardProps) {
  const { state, me, optIn } = props;
  const heading = useId();
  return (
    <section className="card opt-in" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {messages.optIns.names[optIn]}
      </h2>
      <Standing state={state} standing={optInState(state, optIn)} />
      {optIn === 'frontDoor' ? <ClosedByLeave state={state} /> : null}
      {optIn === 'frontDoor' ? <DoorLink {...props} /> : null}
      {optIn === 'frontDoor' ? <Listed state={state} /> : null}
      <p className="opt-in-warning">{messages.optIns.warnings[optIn]}</p>
      <Actions state={state} me={me} optIn={optIn} />
      {optIn === 'frontDoor' ? <ListingLink state={state} me={me} /> : null}
    </section>
  );
}

/**
 * Group rules (`#/g/{groupId}/rules`; ADR-0038, ADR-0039, ADR-0040, #117):
 * the chat bot and the front door, each with where it stands, the plain
 * warning of what the outside platform would hold, and a link to propose a
 * change. While the front door is open, its card holds its link to copy and
 * says whether its page shows the count (#121); once a member's leave or
 * removal has closed it, why, and how to reopen it (#288); and under it,
 * whether it is listed, with a link to propose listing or unlisting it
 * (#485). Nothing here changes an opt-in: only a passed Proposal does, and a
 * steward's Turn off now goes through its own off-Proposal. The other rules
 * were set at founding and don't change.
 */
export function GroupRules(props: GroupRulesProps) {
  const { state, me } = props;
  const { optIns } = messages;
  return (
    <main className="shell" data-scene="trunks">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader eyebrow={optIns.eyebrow} title={optIns.title} pageTitle={optIns.pageTitle} />
      <p className="lede">{optIns.lede}</p>
      <SuspendedNote state={state} me={me} />
      <div className="opt-ins">
        {OPT_INS.map((optIn) => (
          <OptInCard key={optIn} {...props} optIn={optIn} />
        ))}
      </div>
      <p className="caption">{optIns.founding}</p>
    </main>
  );
}
