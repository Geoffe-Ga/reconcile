import { type ReactNode, type SyntheticEvent, useRef, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { CopyLink } from '../app/CopyLink';
import { messages } from '../app/messages';
import type { CardGroup, CardValues } from '../app/reconcile';
import type { SharePort } from '../app/share';
import { type Route, routeHref } from '../app/router';
import { sectionsCheck, sectionsPreview } from '../app/sectionsPreview';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { WHY_MAX } from '../engine/fold';
import { NAME_MAX } from '../invite/envelope';
import { nfcLength } from '../engine/text';
import { GroupPicker } from './BringCard';

/** Where making a card got to: refused as too large, or queued with its post still to run. */
export type CardStep =
  | { readonly kind: 'too-large' }
  | {
      readonly kind: 'queued';
      /** The group's reconcile Proposal. */
      readonly proposalId: string;
      /** Posts the card's envelope and resolves to its link; rejects when the relay can't be reached. */
      readonly post: () => Promise<string>;
    };

/** Props for {@link ReconcileCard}. */
export interface ReconcileCardProps {
  readonly groupId: string;
  /** The group's name, for the way back. */
  readonly groupName: string;
  /**
   * For Reconcile with another coalition (#122), the coalition's genesis id:
   * the way back, and the way on once the card is made, go to its home.
   */
  readonly coalitionId?: string;
  /** Queues the group's reconcile Proposal and keeps the coalition's entry, from valid entries. */
  readonly onMake: (values: CardValues) => Promise<CardStep>;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Where the made card's Share sends its link (#424): the device's share sheet, or the clipboard. */
  readonly sharing: SharePort;
}

/** Text trimmed, required, and at most `max` code points after NFC (spec §4). */
function required(missing: string, max: number, tooLong: string) {
  return (value: string): string | null => {
    const text = value.trim();
    if (text === '') return missing;
    return nfcLength(text) > max ? tooLong : null;
  };
}

const { card } = messages;
const checkName = required(card.nameMissing, NAME_MAX, card.nameTooLong(NAME_MAX));
const checkWhy = required(card.whyMissing, WHY_MAX, card.whyTooLong(WHY_MAX));
const checkYourName = (value: string) => (value.trim() === '' ? card.yourNameMissing : null);
const checkStatement = sectionsCheck(card.statementMissing);

function readValues(form: HTMLFormElement, statement: string): CardValues {
  const data = new FormData(form);
  const read = (name: string): string => {
    const value = data.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  return { name: read('name'), statement, why: read('why'), yourName: read('yourName') };
}

/** The form's title, lede and hints: a group's card's, or a coalition's (#122). */
function wordsFor(coalitionId: string | undefined) {
  if (coalitionId === undefined) {
    const { title, lede, nameHint, statementHint, whyHint } = card;
    return { title, lede, nameHint, statementHint, whyHint };
  }
  return {
    title: card.coalitionTitle,
    lede: card.coalitionLede,
    nameHint: card.coalitionNameHint,
    statementHint: card.coalitionStatementHint,
    whyHint: card.coalitionWhyHint,
  };
}

/** Where the screen is: the form, posting the card, a post that failed, or the link. */
type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'posting'; readonly step: Queued }
  | { readonly kind: 'unsent'; readonly step: Queued }
  | { readonly kind: 'made'; readonly step: Queued; readonly link: string };

type Queued = Extract<CardStep, { kind: 'queued' }>;

interface MadeProps {
  readonly groupId: string;
  readonly proposalId: string;
  readonly link: string;
  readonly copyText: ReconcileCardProps['copyText'];
  readonly sharing: SharePort;
  /** A coalition's card (#122): its home, where its reconcile motion shows. */
  readonly coalitionId?: string | undefined;
}

/**
 * The card's link, once the relay holds its envelope: a read-only field with
 * Copy, and Share beside it (#424), under the warning about who can read it,
 * then the way to the group's own Proposal, or for a coalition's card, to the
 * coalition's home (#122).
 */
export function CardMade(props: MadeProps) {
  const { groupId, proposalId, link, copyText, sharing, coalitionId } = props;
  const next =
    coalitionId === undefined
      ? { href: routeHref({ name: 'proposal', groupId, proposalId }), label: card.proposalLink }
      : { href: routeHref({ name: 'coalition', coalitionId }), label: card.coalitionLink };
  return (
    <div className="stack">
      <CopyLink
        link={link}
        label={card.linkLabel}
        hint={coalitionId === undefined ? card.warning : card.coalitionWarning}
        button={card.copy}
        primary
        copyText={copyText}
        sharing={sharing}
      />
      <p>
        <Link className="forward-link" href={next.href}>
          {next.label}
          <span aria-hidden="true">{messages.app.forward}</span>
        </Link>
      </p>
    </div>
  );
}

interface FormProps {
  readonly onSubmit: (form: HTMLFormElement, statement: string) => Promise<void>;
  readonly refused: Record<string, string>;
  /** The hints under the name, the statement and Why: a group's, or a coalition's (#122). */
  readonly hints: Pick<ReturnType<typeof wordsFor>, 'nameHint' | 'statementHint' | 'whyHint'>;
  /** What comes first in the form: at a front door, the group it's from (#426). */
  readonly lead?: ReactNode;
  /** Submit's words, Make the card unless given. */
  readonly submit?: string;
}

/** The coalition's name, its first statement, why, and your name in it. */
function CardForm({ onSubmit, refused, hints, lead, submit: label = card.submit }: FormProps) {
  const [statement, setStatement] = useState('');
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(event.currentTarget, statement);
  };
  return (
    <Form className="form" onSubmit={submit} validationErrors={refused}>
      {lead}
      <Field
        name="name"
        label={card.nameLabel}
        hint={hints.nameHint}
        autoComplete="off"
        isRequired
        validate={checkName}
      />
      <MarkdownField
        name="statement"
        label={card.statementLabel}
        hint={hints.statementHint}
        value={statement}
        onChange={setStatement}
        isRequired
        validate={checkStatement}
        preview={sectionsPreview}
      />
      <Field
        name="why"
        label={card.whyLabel}
        hint={hints.whyHint}
        multiline
        isRequired
        validate={checkWhy}
      />
      <Field
        name="yourName"
        label={card.yourNameLabel}
        hint={card.yourNameHint}
        autoComplete="off"
        isRequired
        validate={checkYourName}
      />
      <Button type="submit" className="button button-primary">
        {label}
      </Button>
    </Form>
  );
}

/** "Making the card…", or why there's no card yet, with Try again. */
function Unsent({ posting, onRetry }: { readonly posting: boolean; readonly onRetry: () => void }) {
  if (posting) {
    return (
      <p role="status" className="status">
        {card.making}
      </p>
    );
  }
  return (
    <div className="stack">
      <p role="alert" className="form-error">
        {card.failed}
      </p>
      <div>
        <Button className="button button-primary" onPress={onRetry}>
          {card.retry}
        </Button>
      </div>
    </div>
  );
}

/**
 * Reconcile with another group (`#/g/{groupId}/reconcile`; #114): the
 * coalition's name, its first statement in Write and Preview tabs, why, and
 * your name in the coalition. Submit queues the group's reconcile Proposal,
 * then posts the card; only once the relay holds it does its link show, with
 * Copy and the warning about who can read it. When posting fails, the
 * Proposal stays queued and Try again posts the same card. Given a
 * `coalitionId`, it is Reconcile with another coalition
 * (`#/c/{coalitionId}/reconcile`; #122), the same form one level up.
 */
export function ReconcileCard(props: ReconcileCardProps) {
  const { groupId, groupName, onMake, copyText, sharing, coalitionId } = props;
  const busy = useRef(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [refused, setRefused] = useState<Record<string, string>>({});

  const post = (step: Queued) => {
    setPhase({ kind: 'posting', step });
    step.post().then(
      (link) => {
        setPhase({ kind: 'made', step, link });
      },
      () => {
        setPhase({ kind: 'unsent', step });
      },
    );
  };

  const make = async (form: HTMLFormElement, statement: string) => {
    if (busy.current) return;
    busy.current = true;
    setRefused({});
    const step = await onMake(readValues(form, statement)).finally(() => {
      busy.current = false;
    });
    if (step.kind === 'too-large') setRefused({ statement: card.tooLarge });
    else post(step);
  };

  const made = phase.kind === 'made';
  const words = wordsFor(coalitionId);
  const back: Route =
    coalitionId === undefined ? { name: 'group', groupId } : { name: 'coalition', coalitionId };
  return (
    <main className="shell">
      <BackLink to={back} label={groupName} />
      <PageHeader
        title={made ? card.madeTitle : words.title}
        pageTitle={words.title}
        eyebrow={messages.coalitions.heading}
      />
      {phase.kind === 'form' ? (
        <>
          <p className="lede">{words.lede}</p>
          <CardForm onSubmit={make} refused={refused} hints={words} />
        </>
      ) : null}
      {phase.kind === 'posting' || phase.kind === 'unsent' ? (
        <Unsent
          posting={phase.kind === 'posting'}
          onRetry={() => {
            post(phase.step);
          }}
        />
      ) : null}
      {phase.kind === 'made' ? (
        <CardMade
          groupId={groupId}
          proposalId={phase.step.proposalId}
          link={phase.link}
          copyText={copyText}
          sharing={sharing}
          coalitionId={coalitionId}
        />
      ) : null}
    </main>
  );
}

/** Where making a card at a front door got to (#426): refused as too large, or queued with its post to run. */
export type DoorCardStep =
  | { readonly kind: 'too-large' }
  | {
      readonly kind: 'queued';
      /** The picked group's reconcile Proposal. */
      readonly proposalId: string;
      /** Sends the card and leaves it at the door; rejects when the relay can't be reached. */
      readonly post: () => Promise<void>;
    };

/** Props for {@link ReconcileAtDoor}. */
export interface ReconcileAtDoorProps {
  /** The door's group's name, as its page shows it. */
  readonly doorName: string;
  /** This device's groups that may propose reconciling with it, first picked to start. */
  readonly groups: readonly CardGroup[];
  /** Queues the picked group's reconcile Proposal, from valid entries. */
  readonly onMake: (groupId: string, values: CardValues) => Promise<DoorCardStep>;
  /** Back to the door's page, sending nothing. */
  readonly onBack: () => void;
}

/** Where Propose reconciling is: the form, posting, a post that failed, or sent. */
type DoorPhase =
  | { readonly kind: 'form' }
  | {
      readonly kind: 'posting' | 'unsent' | 'sent';
      readonly step: DoorQueued;
      readonly groupId: string;
    };

type DoorQueued = Extract<DoorCardStep, { kind: 'queued' }>;

/** A line of `parts` around the door's group's name, in its own `<bdi>`. */
function AroundName(props: {
  readonly parts: { readonly before: string; readonly after: string };
  readonly name: string;
}) {
  const { parts, name } = props;
  return (
    <>
      {parts.before} <bdi>{name}</bdi>
      {parts.after}
    </>
  );
}

/** "Your card is at <group>'s front door. …", and the way to the group's own Proposal. */
function DoorSent(props: {
  readonly doorName: string;
  readonly groupId: string;
  readonly proposalId: string;
}) {
  const { doorName, groupId, proposalId } = props;
  return (
    <div className="stack">
      <p role="status" className="lede">
        <AroundName parts={card.doorSent} name={doorName} />
      </p>
      <p>
        <Link className="forward-link" href={routeHref({ name: 'proposal', groupId, proposalId })}>
          {card.proposalLink}
          <span aria-hidden="true">{messages.app.forward}</span>
        </Link>
      </p>
    </div>
  );
}

/**
 * Propose reconciling with this group (#426; ADR-0077 §5), from another
 * group's front door: which of this person's groups it's from, as Bring a
 * card's radio offers them, then Reconcile with another group's own fields.
 * Submit queues that group's reconcile Proposal, then sends the card and
 * leaves it at the door; only once the relay holds both does it say so,
 * with the way to the Proposal. When posting fails, the Proposal stays
 * queued and Try again sends the card again. Under the eyebrow "Front door",
 * like the door's page, and the tab's title never carries a group's name.
 */
export function ReconcileAtDoor({ doorName, groups, onMake, onBack }: ReconcileAtDoorProps) {
  const busy = useRef(false);
  const [groupId, setGroupId] = useState(groups[0]?.groupId ?? '');
  const [phase, setPhase] = useState<DoorPhase>({ kind: 'form' });
  const [refused, setRefused] = useState<Record<string, string>>({});

  const post = (step: DoorQueued, from: string) => {
    setPhase({ kind: 'posting', step, groupId: from });
    step.post().then(
      () => {
        setPhase({ kind: 'sent', step, groupId: from });
      },
      () => {
        setPhase({ kind: 'unsent', step, groupId: from });
      },
    );
  };

  const make = async (form: HTMLFormElement, statement: string) => {
    if (busy.current) return;
    busy.current = true;
    setRefused({});
    const from = groupId;
    const step = await onMake(from, readValues(form, statement)).finally(() => {
      busy.current = false;
    });
    if (step.kind === 'too-large') setRefused({ statement: card.tooLarge });
    else post(step, from);
  };

  const picker = (
    <GroupPicker
      groups={groups}
      value={groupId}
      onChange={setGroupId}
      words={{ label: card.doorGroupLabel, hint: card.doorGroupHint }}
    />
  );
  return (
    <main className="shell">
      <div>
        <Button className="back-link door-back" onPress={onBack}>
          <span aria-hidden="true">{messages.app.back}</span>
          {card.doorBack}
        </Button>
      </div>
      <PageHeader
        eyebrow={messages.door.eyebrow}
        title={card.doorTitle}
        pageTitle={messages.door.pageTitle}
      />
      {phase.kind === 'form' ? (
        <>
          <p className="lede">
            <AroundName parts={card.doorLede} name={doorName} />
          </p>
          <CardForm
            onSubmit={make}
            refused={refused}
            hints={card}
            lead={picker}
            submit={card.doorSubmit}
          />
        </>
      ) : null}
      {phase.kind === 'posting' || phase.kind === 'unsent' ? (
        <Unsent
          posting={phase.kind === 'posting'}
          onRetry={() => {
            post(phase.step, phase.groupId);
          }}
        />
      ) : null}
      {phase.kind === 'sent' ? (
        <DoorSent doorName={doorName} groupId={phase.groupId} proposalId={phase.step.proposalId} />
      ) : null}
    </main>
  );
}
