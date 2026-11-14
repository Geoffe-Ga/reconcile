import { type SyntheticEvent, useRef, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { CopyLink } from '../app/CopyLink';
import { messages } from '../app/messages';
import type { CardValues } from '../app/reconcile';
import type { SharePort } from '../app/share';
import { type Route, routeHref } from '../app/router';
import { sectionsCheck, sectionsPreview } from '../app/sectionsPreview';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { WHY_MAX } from '../engine/fold';
import { NAME_MAX } from '../invite/envelope';
import { nfcLength } from '../engine/text';

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
}

/** The coalition's name, its first statement, why, and your name in it. */
function CardForm({ onSubmit, refused, hints }: FormProps) {
  const [statement, setStatement] = useState('');
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(event.currentTarget, statement);
  };
  return (
    <Form className="form" onSubmit={submit} validationErrors={refused}>
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
        {card.submit}
      </Button>
    </Form>
  );
}

/** "Making the card…", or why there's no card yet, with Try again. */
function Unsent({ phase, onRetry }: { readonly phase: Phase; readonly onRetry: () => void }) {
  if (phase.kind === 'posting') {
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
          phase={phase}
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
