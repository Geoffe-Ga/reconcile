/**
 * A section's history, in a side sheet (#104; DESIGN.md, Atom block; ADR-0010,
 * ADR-0017, ADR-0036, ADR-0069).
 *
 * Built on React Aria's `DialogTrigger`, `ModalOverlay`, `Modal` and `Dialog`,
 * so focus moves into the sheet, stays there, and returns to the button that
 * opened it when Close, Escape or a tap outside closes it. It slides in from
 * the inline end on a wide screen and fills the screen below about 40rem.
 *
 * Top to bottom: each pass that shaped the section, newest first, ending
 * where it began. A pass shows its Proposal's title, the text it left
 * through `<AtomText>` (or that it removed the section), "Proposed by
 * <name>" and "Decided <date>", its why, the winning version's one totals
 * line, and See the full result, the Proposal's page, where `<ResultView>`
 * shows its ballots. A coalition motion shows each group's pass or fail in
 * place of totals, as only those cross group lines (ADR-0036). Then
 * "Proposals that didn't pass (N)" in a disclosure. Nothing here names a
 * voter or shows a note, so it reads the same once #111 clears the ballots.
 */
import type { ReactElement } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Disclosure,
  DisclosurePanel,
  Heading,
  Link,
  Modal,
  ModalOverlay,
} from 'react-aria-components';

import { formatAverage, formatDay } from '../app/format';
import type { HistorySource } from '../app/historySource';
import { messages } from '../app/messages';
import { AtomText } from '../app/text/AtomText';
import { minuteIso } from '../app/time';
import type { GroupStanding } from '../engine/coalitionProgress';
import type { NotPassed, PassedChange } from '../engine/history';
import { displayName } from '../engine/names';

/** Props for {@link HistorySheet}. */
export interface HistorySheetProps {
  readonly source: HistorySource;
  /** The section whose history the sheet shows. */
  readonly atomId: string;
  /** The section's number in its Document, or null once a pass has removed it. */
  readonly section: number | null;
  /** The button that opens the sheet, which takes focus back when it closes. */
  readonly children: ReactElement;
}

const { history } = messages;

/** A relay minute as a day, in a `<time>` element that never breaks across lines. */
export function Day({ minute }: { readonly minute: number }) {
  return <time dateTime={minuteIso(minute)}>{formatDay(minute)}</time>;
}

/** Each group's pass or fail on a coalition motion, in seat order (ADR-0036). */
function GroupResults({ groups }: { readonly groups: readonly GroupStanding[] }) {
  return (
    <ul className="history-groups" aria-label={messages.coalitions.eachGroup}>
      {groups.map((group, index) => (
        <li key={index} className="history-group">
          <bdi>{group.name}</bdi>
          <span className="caption">
            {group.result === null ? history.noResult : messages.coalitions.standing[group.result]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What decided a pass: each group's result on a coalition motion, else the winning version's totals. */
function Decision({ entry }: { readonly entry: PassedChange }) {
  const { totals, groups } = entry;
  if (groups !== null) return <GroupResults groups={groups} />;
  if (totals === null) return null;
  const line = messages.result.totalsLine(totals.scorers, formatAverage(totals), totals.zeros);
  return <p className="caption">{line}</p>;
}

/** "Proposed by <name> · Decided <date>", or for the founding text "Written by <name> · Founded <date>". */
function Byline({
  entry,
  source,
}: {
  readonly entry: PassedChange;
  readonly source: HistorySource;
}) {
  const founded = entry.change.kind === 'founded';
  const name = entry.author === null ? null : displayName(source.names, entry.author);
  return (
    <p className="caption history-meta">
      {name === null ? null : (
        <span>
          {founded ? history.writtenBy : history.proposedBy} <bdi>{name}</bdi>
        </span>
      )}
      <span>
        {founded ? history.founded : history.decided} <Day minute={entry.decidedAt} />
      </span>
    </p>
  );
}

/** One decision that shaped the section: a pass, or the founding text. */
function Entry({
  entry,
  source,
}: {
  readonly entry: PassedChange;
  readonly source: HistorySource;
}) {
  const href = entry.proposalId === null ? null : source.resultHref(entry.proposalId);
  return (
    <li className="history-entry">
      <h3 className="heading-3">
        {entry.title === null ? history.founding : <bdi>{entry.title}</bdi>}
      </h3>
      {entry.change.kind === 'removed' ? (
        <p className="history-removed">{history.removed}</p>
      ) : (
        <AtomText text={entry.text} />
      )}
      <Byline entry={entry} source={source} />
      {entry.why === null || entry.why === '' ? null : (
        <p className="history-why" dir="auto">
          {entry.why}
        </p>
      )}
      <Decision entry={entry} />
      {href === null ? null : (
        <Link className="forward-link" href={href}>
          {history.seeResult}
          <span aria-hidden="true">{messages.app.forward}</span>
        </Link>
      )}
    </li>
  );
}

/** "Proposals that didn't pass (N)", a disclosure of each with its outcome and date; nothing for none. */
function NotPassedList(props: {
  readonly notPassed: readonly NotPassed[];
  readonly source: HistorySource;
}) {
  const { notPassed, source } = props;
  if (notPassed.length === 0) return null;
  const label = history.notPassed(notPassed.length);
  return (
    <Disclosure className="reads-as history-not-passed">
      <Heading level={3} className="reads-as-heading">
        <Button slot="trigger" className="reads-as-toggle">
          {label}
        </Button>
      </Heading>
      <DisclosurePanel>
        <ul className="history-failed" aria-label={label}>
          {notPassed.map((proposal) => {
            const href = source.resultHref(proposal.proposalId);
            const title = <bdi>{proposal.title}</bdi>;
            return (
              <li key={proposal.proposalId} className="history-failed-row">
                {href === null ? title : <Link href={href}>{title}</Link>}
                <span className="meta countdown">
                  <span>{messages.decided.outcomes[proposal.outcome]}</span>
                  <Day minute={proposal.decidedAt} />
                </span>
              </li>
            );
          })}
        </ul>
      </DisclosurePanel>
    </Disclosure>
  );
}

/** The sheet's heading, its Close, then the section's passes and those that didn't pass. */
function SheetBody(props: Omit<HistorySheetProps, 'children'> & { readonly close: () => void }) {
  const { source, atomId, section, close } = props;
  const { passed, notPassed } = source.historyOf(atomId);
  return (
    <>
      <div className="sheet-head">
        <Heading slot="title" className="dialog-title">
          {section === null ? history.removedTitle : history.title(section)}
        </Heading>
        <Button className="button button-quiet sheet-close" onPress={close}>
          {history.close}
        </Button>
      </div>
      {passed.length === 1 ? <p className="lede">{history.unchanged}</p> : null}
      <ol className="history-list">
        {passed.map((entry) => (
          <Entry key={entry.proposalId ?? 'founding'} entry={entry} source={source} />
        ))}
      </ol>
      <NotPassedList notPassed={notPassed} source={source} />
    </>
  );
}

/**
 * `children`, a button, and the side sheet of section `atomId`'s history it
 * opens (#104). The history is worked out only once the sheet opens.
 */
export function HistorySheet({ children, ...props }: HistorySheetProps) {
  return (
    <DialogTrigger>
      {children}
      <ModalOverlay className="modal-overlay sheet-overlay" isDismissable>
        <Modal className="sheet">
          <Dialog className="sheet-dialog">
            {({ close }) => <SheetBody {...props} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
