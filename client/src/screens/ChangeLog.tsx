/**
 * A Document's change log (`#/g/{groupId}/doc/{documentId}/log`, or a
 * coalition's `#/c/{coalitionId}/doc/{documentId}/log`; #104).
 *
 * Under the Document's title, every change that passed in it, newest first:
 * each row its Proposal's title, what it did ("Changed ‘Quiet hours
 * start…’", "Added a section", "Removed ‘Bins go out…’") and the day it was
 * decided, ending with the Document's beginning, its founding text or the
 * Proposal that started it. Each change opens its section's history in the
 * side sheet, a removed section's included. It's read from the log on this
 * device, and names no voter.
 */
import { Button } from 'react-aria-components';

import { documentNamed } from '../app/documentLines';
import { groupHistory, type HistorySource } from '../app/historySource';
import { messages } from '../app/messages';
import type { Route } from '../app/router';
import { firstWords } from '../app/text/firstWords';
import { BackLink, PageHeader } from '../app/ui';
import { atomsOf } from '../engine/documents';
import type { GroupState } from '../engine/fold';
import { type Change, changeLog, type KeptTallies, type LogRow } from '../engine/history';
import { MissingDocument } from './DocumentView';
import { Day, HistorySheet } from './SectionHistory';

const { changeLog: words } = messages;

/** What a row says it did, or nothing for the founding text, which its title says. */
function changeWords(change: Change): string | null {
  switch (change.kind) {
    case 'founded':
      return null;
    case 'created':
      return words.created;
    case 'added':
      return words.added;
    case 'changed':
      return words.changed(firstWords(change.quote));
    case 'removed':
      return words.removed(firstWords(change.quote));
  }
}

/** A row's title, what it did and its day: "Decided" for a pass, "Founded" for the founding text. */
function RowText({ row }: { readonly row: LogRow }) {
  const did = changeWords(row.change);
  return (
    <>
      <span className="heading-3">
        {row.title === null ? words.founded : <bdi>{row.title}</bdi>}
      </span>
      {did === null ? null : <span className="log-change">{did}</span>}
      <span className="meta">
        <Day minute={row.decidedAt} />
      </span>
    </>
  );
}

/** Props for {@link ChangeLogView}. */
export interface ChangeLogViewProps {
  /** Where Back goes: the Document. */
  readonly back: Route;
  /** The Document's title. */
  readonly title: string;
  /** The log, newest first (`changeLog`). */
  readonly rows: readonly LogRow[];
  readonly source: HistorySource;
  /** Each section the Document still has, by id, with its number there. */
  readonly numbers: ReadonlyMap<string, number>;
}

/**
 * The change log of one Document: each change a button that opens its
 * section's history, and the Document's beginning as a plain card, since it
 * made every first section at once.
 */
export function ChangeLogView({ back, title, rows, source, numbers }: ChangeLogViewProps) {
  return (
    <main className="shell">
      <BackLink to={back} label={title} />
      <PageHeader eyebrow={words.eyebrow} title={title} pageTitle={words.pageTitle} />
      <p className="lede">{rows.length > 1 ? words.lede : words.unchanged}</p>
      <ol className="card-list change-log" aria-label={words.eyebrow}>
        {rows.map((row) => (
          <li key={row.proposalId ?? 'founding'}>
            {row.section === null ? (
              <div className="card-link card-link-static log-row">
                <RowText row={row} />
              </div>
            ) : (
              <HistorySheet
                source={source}
                atomId={row.section}
                section={numbers.get(row.section) ?? null}
              >
                <Button className="card-link log-row">
                  <RowText row={row} />
                </Button>
              </HistorySheet>
            )}
          </li>
        ))}
      </ol>
    </main>
  );
}

/** Props for {@link GroupChangeLog}. */
export interface GroupChangeLogProps {
  readonly state: GroupState;
  /** The Document, from the route. */
  readonly documentId: string;
  /** Once a dissolved group's ballots are cleared (#108): the tallies its archive kept. */
  readonly kept?: KeptTallies;
}

/** A group Document's change log, or where to find the group's Documents for one it doesn't have. */
export function GroupChangeLog({ state, documentId, kept }: GroupChangeLogProps) {
  const document = documentNamed(state, documentId);
  if (document === undefined) return <MissingDocument state={state} />;
  const groupId = state.group ?? '';
  const numbers = new Map(atomsOf(state, document.id).map((atom, i) => [atom.id, i + 1]));
  return (
    <ChangeLogView
      back={{ name: 'document', groupId, documentId: document.id }}
      title={document.title}
      rows={changeLog(state, document.id)}
      source={groupHistory(state, kept)}
      numbers={numbers}
    />
  );
}
