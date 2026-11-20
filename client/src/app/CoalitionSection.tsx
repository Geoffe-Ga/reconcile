import { type ReactNode, type SyntheticEvent, useId, useRef, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import type { AboveRow, CoalitionLine, CoalitionRow } from './coalitionLines';
import { CopyLink } from './CopyLink';
import { messages } from './messages';
import { ResultMismatch } from './ResultMismatch';
import { routeHref } from './router';
import { SectionGlyph } from './SectionGlyph';
import type { SharePort } from './share';
import { Field } from './ui';

/** Props for {@link CoalitionSection}. */
export interface CoalitionSectionProps {
  readonly groupId: string;
  /** The group's coalitions, one row per reconcile Proposal (`coalitionRows`). */
  readonly rows: readonly CoalitionRow[];
  /** Whether this person may start one: they can propose, and the group takes new things. */
  readonly starts: boolean;
  /** Takes part in a coalition under the group's seat, as `name`; rejects when it couldn't be saved. */
  readonly onTakePart: (entryId: string, name: string) => Promise<void>;
  /** Makes a card from a formed coalition and resolves to its link; rejects when the relay can't be reached. */
  readonly makeCardLink: (entryId: string) => Promise<string>;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Where a made card's Share sends its link (#424): the device's share sheet, or the clipboard. */
  readonly sharing: SharePort;
}

const { coalitions } = messages;

/** What each status reads as, above the coalition's name. */
const STATUS: Readonly<Record<CoalitionRow['status'], string>> = {
  forming: coalitions.forming,
  formed: coalitions.formed,
  declined: coalitions.declined,
};

/** One line under a coalition's name, each group's name in its own `<bdi>`. */
function Line({ line }: { readonly line: CoalitionLine }) {
  switch (line.kind) {
    case 'waiting':
      return (
        <p>
          {coalitions.waitingBefore} <bdi>{line.group}</bdi>
          {coalitions.waitingAfter}
          {line.notPassing === true ? ` ${coalitions.tagSeparator} ${coalitions.notPassing}` : null}
        </p>
      );
    case 'didnt-pass':
      return (
        <p>
          <bdi>{line.group}</bdi> {coalitions.didntPassAfter}
        </p>
      );
    case 'waiting-card':
      return <p>{coalitions.waitingCard}</p>;
    case 'lapsed':
      return <p>{coalitions.lapsed}</p>;
  }
}

/** The member groups of a formed coalition, comma-separated, each in its own `<bdi>`. */
function Members({ names }: { readonly names: readonly string[] }) {
  const parts: ReactNode[] = [];
  names.forEach((name, index) => {
    if (index > 0) parts.push(', ');
    parts.push(<bdi key={index}>{name}</bdi>);
  });
  return <p className="coalition-members">{parts}</p>;
}

const checkName = (value: string) => (value.trim() === '' ? coalitions.nameMissing : null);

/** Take part: your name in the coalition, and the button that joins under the group's seat. */
export function TakePart({ onTakePart }: { readonly onTakePart: (name: string) => Promise<void> }) {
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    if (busy.current || typeof name !== 'string') return;
    busy.current = true;
    setFailed(false);
    onTakePart(name.trim())
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        busy.current = false;
      });
  };
  return (
    <Form className="form coalition-take-part" onSubmit={submit}>
      <Field
        name="name"
        label={coalitions.nameLabel}
        hint={coalitions.nameHint}
        autoComplete="off"
        isRequired
        validate={checkName}
      />
      {failed ? (
        <p role="alert" className="form-error">
          {coalitions.takePartFailed}
        </p>
      ) : null}
      <div>
        <Button type="submit" className="button button-secondary">
          {coalitions.takePart}
        </Button>
      </div>
    </Form>
  );
}

/** Where a formed coalition's card has got to. */
type CardStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'made'; readonly link: string };

interface AnotherProps {
  readonly makeCardLink: () => Promise<string>;
  readonly copyText: CoalitionSectionProps['copyText'];
  readonly sharing: SharePort;
}

/**
 * Make a card for another group: once the relay holds it, its link with Copy
 * and Share (#424) and the warning about who can read it, as Reconcile with
 * another group shows one.
 */
function AnotherGroup({ makeCardLink, copyText, sharing }: AnotherProps) {
  const [status, setStatus] = useState<CardStatus>({ kind: 'idle' });
  const lede = useId();
  if (status.kind === 'made') {
    return (
      <div className="coalition-another">
        <CopyLink
          link={status.link}
          label={messages.card.linkLabel}
          hint={messages.card.warning}
          button={messages.card.copy}
          primary={false}
          copyText={copyText}
          sharing={sharing}
        />
      </div>
    );
  }
  const make = () => {
    if (status.kind === 'making') return;
    setStatus({ kind: 'making' });
    makeCardLink().then(
      (link) => {
        setStatus({ kind: 'made', link });
      },
      () => {
        setStatus({ kind: 'failed' });
      },
    );
  };
  return (
    <div className="stack coalition-another">
      <p id={lede} className="caption">
        {messages.card.anotherLede}
      </p>
      <div className="field-status">
        <Button className="button button-secondary" onPress={make} aria-describedby={lede}>
          {messages.card.another}
        </Button>
        <p role="status" className="status">
          {status.kind === 'making' ? messages.card.making : null}
          {status.kind === 'failed' ? messages.card.failedAnother : null}
        </p>
      </div>
    </div>
  );
}

interface RowProps {
  readonly row: CoalitionRow;
  readonly props: CoalitionSectionProps;
}

/** How this person stands in the coalition: in it under a name, joining, or Take part. */
function Me({ row, props }: RowProps) {
  const { me } = row;
  switch (me.kind) {
    case 'in':
      return (
        <p className="caption">
          {coalitions.youTakePart} <bdi>{me.name}</bdi>
        </p>
      );
    case 'joining':
      return <p className="caption">{coalitions.joining}</p>;
    case 'may-take-part':
      return <TakePart onTakePart={(name) => props.onTakePart(row.entryId, name)} />;
    case 'none':
      return null;
  }
}

/** "Open the coalition →", to its home (#120), once it has formed. */
function OpenCoalition({ row }: { readonly row: Pick<CoalitionRow, 'status' | 'coalitionId'> }) {
  if (row.status !== 'formed' || row.coalitionId === null) return null;
  return (
    <p>
      <Link
        className="forward-link"
        href={routeHref({ name: 'coalition', coalitionId: row.coalitionId })}
      >
        {coalitions.open}
        <span aria-hidden="true">{messages.app.forward}</span>
      </Link>
    </p>
  );
}

/** A chain of names, as in "Riverside Tenants · in Eastside Housing · in Metro Renters" (#122). */
function Chain({ names }: { readonly names: readonly string[] }) {
  const parts: ReactNode[] = [];
  names.forEach((name, index) => {
    if (index > 0) parts.push(` ${coalitions.tagSeparator} ${coalitions.chainIn} `);
    parts.push(<bdi key={index}>{name}</bdi>);
  });
  return <p className="coalition-chain">{parts}</p>;
}

/**
 * The coalitions above this one (#122): each with where it stands for the
 * seat below it, the chain from the group up to it, and its home once formed.
 */
function Above({ rows }: { readonly rows: readonly AboveRow[] }) {
  const heading = useId();
  if (rows.length === 0) return null;
  return (
    <div className="coalition-above">
      <p id={heading} className="eyebrow">
        {coalitions.above}
      </p>
      <ul className="coalition-above-list" aria-labelledby={heading}>
        {rows.map((row) => (
          <li key={row.key} className="coalition-above-item">
            <p className="caption">{STATUS[row.status]}</p>
            <Chain names={row.chain} />
            {row.lines.map((line, index) => (
              <Line key={index} line={line} />
            ))}
            <OpenCoalition row={row} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Reconcile with another coalition →" (#122), for whoever may make the coalition's card. */
function ReconcileCoalition({ row }: { readonly row: CoalitionRow }) {
  if (!row.reconciles || row.coalitionId === null) return null;
  return (
    <p>
      <Link
        className="forward-link"
        href={routeHref({ name: 'coalitionReconcile', coalitionId: row.coalitionId })}
      >
        {coalitions.reconcileCoalition}
        <span aria-hidden="true">{messages.app.forward}</span>
      </Link>
    </p>
  );
}

/**
 * One coalition: whether it's forming, formed or didn't form, its name, its
 * member groups and a link to its home once formed (#120), whom it waits
 * for or who didn't pass it, any
 * result that doesn't match the group's own vote, and how this person takes
 * part; then the way to reconcile it with another coalition, and the
 * coalitions above it (#122).
 */
function Row({ row, props }: RowProps) {
  return (
    <li className="card coalition">
      <p className="eyebrow">{STATUS[row.status]}</p>
      <h3 className="heading-3">
        <bdi>{row.name}</bdi>
      </h3>
      {row.members.length > 0 ? <Members names={row.members} /> : null}
      <OpenCoalition row={row} />
      {row.lines.length > 0 ? (
        <div className="coalition-lines">
          {row.lines.map((line, index) => (
            <Line key={index} line={line} />
          ))}
        </div>
      ) : null}
      <ResultMismatch count={row.mismatches} />
      <Me row={row} props={props} />
      {row.makesCards ? (
        <AnotherGroup
          makeCardLink={() => props.makeCardLink(row.entryId)}
          copyText={props.copyText}
          sharing={props.sharing}
        />
      ) : null}
      <ReconcileCoalition row={row} />
      <Above rows={row.above} />
    </li>
  );
}

/**
 * Group home's Coalitions (#114): Reconcile with another group, for whoever
 * may start one, then each coalition the group proposed or joined. Nothing
 * when there's neither.
 */
export function CoalitionSection(props: CoalitionSectionProps) {
  const { groupId, rows, starts } = props;
  const heading = useId();
  if (rows.length === 0 && !starts) return null;
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow section-heading">
        <SectionGlyph kind="coalitions" />
        {coalitions.heading}
      </h2>
      <div className="stack">
        {rows.length > 0 ? (
          <ul className="card-list">
            {rows.map((row) => (
              <Row key={row.proposal} row={row} props={props} />
            ))}
          </ul>
        ) : null}
        {starts ? (
          <p>
            <Link className="forward-link" href={routeHref({ name: 'reconcile', groupId })}>
              {coalitions.start}
              <span aria-hidden="true">{messages.app.forward}</span>
            </Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}
