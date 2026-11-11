/**
 * A coalition's home (`#/c/{coalitionId}`; #120, ADR-0036, ADR-0069).
 *
 * Reached from group home's Coalitions row, it shows what the coalition's own
 * log holds: its name, its open Proposals, each with its progress line and
 * deadline, its Documents, its Decided list, each closed motion with whether
 * the coalition passed it and when, and its member groups, marking those
 * this device is in. Each motion opens as the coalition vote in a member
 * group on this device whose seat decides it, where that group's own ballot
 * lives. Someone in a member group who may propose and hasn't joined is
 * offered Take part first. No count of people, ballot or voter's name from
 * any group appears here: the coalition's log holds none (ADR-0036).
 */
import { type ReactNode } from 'react';
import { Link } from 'react-aria-components';

import type { CoalitionHomeView, MotionItem } from '../app/coalitionHome';
import { ProgressLine } from '../app/CoalitionProgress';
import { TakePart } from '../app/CoalitionSection';
import { Countdown } from '../app/Countdown';
import { RisenDispatchCard } from '../app/DispatchCard';
import { formatDay } from '../app/format';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { minuteIso } from '../app/time';
import { BackLink, PageHeader, Section } from '../app/ui';

/** Props for {@link CoalitionHome}. */
export interface CoalitionHomeProps {
  /** The coalition as this device reads it (`coalitionHome`). */
  readonly view: CoalitionHomeView;
  /** The relay's minute now, as this device estimates it, for the countdowns. */
  readonly now: number;
  /** The member group Back returns to, or null for Your groups. */
  readonly back: { readonly groupId: string; readonly name: string } | null;
  /** Takes part under the seat of the group `view.standing` names, as `name`; rejects when it couldn't be saved. */
  readonly onTakePart: (name: string) => Promise<void>;
}

const { coalitions } = messages;

/** A motion's card: a link to its vote in a member group on this device, or the card alone. */
function MotionCard({ motion, children }: { motion: MotionItem; children: ReactNode }) {
  const title = (
    <span className="card-link-title">
      <span className="heading-3">
        <bdi>{motion.title}</bdi>
      </span>
      {motion.groupId === null ? null : (
        <span className="card-link-arrow" aria-hidden="true">
          {messages.app.forward}
        </span>
      )}
    </span>
  );
  if (motion.groupId === null) {
    return (
      <div className="card-link card-link-static">
        {title}
        {children}
      </div>
    );
  }
  const route = { name: 'proposal', groupId: motion.groupId, proposalId: motion.id } as const;
  return (
    <Link className="card-link" href={routeHref(route)}>
      {title}
      {children}
    </Link>
  );
}

/** The open motions, each with its progress line and deadline, then any waiting to send. */
function OpenMotions({ view, now }: { readonly view: CoalitionHomeView; readonly now: number }) {
  const { open, pending } = view;
  if (open.length === 0 && pending.length === 0) return <p>{coalitions.noOpen}</p>;
  return (
    <ul className="card-list">
      {open.map((motion) => (
        <li key={motion.id}>
          <MotionCard motion={motion}>
            <ProgressLine progress={motion.progress} inline />
            {/* Once the coalition has decided, its sentence says when the pass takes effect. */}
            {motion.progress.outcome === undefined ? (
              <span className="meta">
                <Countdown deadline={motion.deadline} closedAt={motion.closedAt} now={now} />
              </span>
            ) : null}
          </MotionCard>
        </li>
      ))}
      {pending.map((motion) => (
        <li key={motion.id} className="card coalition-pending">
          <p className="heading-3">
            <bdi>{motion.title}</bdi>
          </p>
          <p className="caption">{coalitions.pending}</p>
        </li>
      ))}
    </ul>
  );
}

/** Decided: each final motion, whether the coalition passed it, and the day it decided. */
function Decided({ decided }: { readonly decided: readonly MotionItem[] }) {
  if (decided.length === 0) return <p>{messages.decided.empty}</p>;
  return (
    <ul className="card-list">
      {decided.map((motion) => (
        <li key={motion.id}>
          <MotionCard motion={motion}>
            <span className="meta countdown">
              <span>{messages.decided.outcomes[motion.progress.outcome ?? 'fail']}</span>
              <time dateTime={minuteIso(motion.decidedAt)}>{formatDay(motion.decidedAt)}</time>
            </span>
          </MotionCard>
        </li>
      ))}
    </ul>
  );
}

/** The Dispatches the coalition passed and sent out, newest first (#126). */
function Dispatches({ view }: { readonly view: CoalitionHomeView }) {
  if (view.dispatches.length === 0) return <p>{messages.dispatches.empty}</p>;
  return (
    <ul className="dispatch-list">
      {view.dispatches.map((dispatch) => (
        <li key={dispatch.id}>
          <RisenDispatchCard {...dispatch} />
        </li>
      ))}
    </ul>
  );
}

/** The coalition's Documents, each opening the coalition's Document view. */
function Documents({ view }: { readonly view: CoalitionHomeView }) {
  return (
    <ul className="card-list">
      {view.documents.map((document) => (
        <li key={document.id}>
          <Link
            className="card-link"
            href={routeHref({
              name: 'coalitionDocument',
              coalitionId: view.coalitionId,
              documentId: document.id,
            })}
          >
            <span className="card-link-title">
              <span className="heading-2">
                <bdi>{document.title}</bdi>
              </span>
              <span className="card-link-arrow" aria-hidden="true">
                {messages.app.forward}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The badge beside a member: yours, a group's or a coalition's (#122), or a coalition's. */
function badgeOf(member: CoalitionHomeView['members'][number]): string | null {
  if (member.mine) return member.coalition ? coalitions.yourCoalition : coalitions.yourGroup;
  return member.coalition ? coalitions.coalitionSeat : null;
}

/**
 * The members in seat order, each this device is in marked "Your group", a
 * coalition in it marked "Coalition", or "Your coalition" when this device
 * takes part through it (#122).
 */
function MemberGroups({ view }: { readonly view: CoalitionHomeView }) {
  return (
    <ul className="coalition-groups">
      {view.members.map((member, index) => {
        const badge = badgeOf(member);
        return (
          <li key={index} className="coalition-group">
            <bdi>{member.name}</bdi>
            {badge === null ? null : <span className="badge">{badge}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The coalition home (#120): Take part first for whoever may, then its open
 * Proposals, the Dispatches it sent out (#126), its Documents, its Decided
 * list and its member groups.
 */
export function CoalitionHome({ view, now, back, onTakePart }: CoalitionHomeProps) {
  return (
    <main className="shell">
      {back === null ? (
        <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      ) : (
        <BackLink to={{ name: 'group', groupId: back.groupId }} label={back.name} />
      )}
      <PageHeader
        eyebrow={coalitions.homeEyebrow}
        title={view.name}
        pageTitle={coalitions.homePageTitle}
      />
      <div className="sections">
        {view.standing.kind === 'take-part' ? (
          <Section title={coalitions.takePart}>
            <div className="stack coalition-join">
              <p>{coalitions.takePartFirst}</p>
              <TakePart onTakePart={onTakePart} />
            </div>
          </Section>
        ) : null}
        <Section title={coalitions.openMotions}>
          <OpenMotions view={view} now={now} />
        </Section>
        <Section title={messages.dispatches.title}>
          <Dispatches view={view} />
        </Section>
        <Section title={coalitions.documents}>
          <Documents view={view} />
        </Section>
        <Section title={messages.decided.title}>
          <Decided decided={view.decided} />
        </Section>
        <Section title={coalitions.groups}>
          <MemberGroups view={view} />
        </Section>
      </div>
    </main>
  );
}
