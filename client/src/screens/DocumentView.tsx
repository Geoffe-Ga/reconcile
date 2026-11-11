import { Fragment, useEffect, useRef, useState } from 'react';
import { Button, Label, Link, Text, TextArea, TextField } from 'react-aria-components';

import type { CoalitionStanding } from '../app/coalitionHome';
import { TakePart } from '../app/CoalitionSection';
import { documentNamed } from '../app/documentLines';
import { groupHistory, type HistorySource } from '../app/historySource';
import { ChangeInvolvement } from '../app/LevelPicker';
import { messages } from '../app/messages';
import { WaitingNote } from '../app/Newcomer';
import { type Route, routeHref } from '../app/router';
import { SuspendedNote } from '../app/stewards';
import { AtomText } from '../app/text/AtomText';
import { BackLink, PageHeader } from '../app/ui';
import { holdsRemoval } from '../app/versionViews';
import { can, holdsRights, isSuspended } from '../engine/capabilities';
import { composeOption, openProposalOn } from '../engine/composeOption';
import { documentToMarkdown } from '../engine/documentMarkdown';
import { atomsOf, type GroupDocument } from '../engine/documents';
import type { Atom, GroupState } from '../engine/fold';
import type { KeptTallies } from '../engine/history';
import { HistorySheet } from './SectionHistory';

/** Props for {@link DocumentView}. */
export interface DocumentViewProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** The Document to show, from the route (#92); the group's first when absent. */
  readonly documentId?: string;
  /** Opens the composer for one section. */
  readonly onPropose: (atomId: string) => void;
  /** Opens the composer for a new section in `document` after Atom `after`, or first there for null (#75, #92). */
  readonly onAdd: (place: AddPlace) => void;
  /** Opens the composer that proposes removing one section (#75). */
  readonly onRemove: (atomId: string) => void;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Whether this device's leave waits for the relay (#77): then nobody proposes from here. */
  readonly leaving?: boolean;
  /** Once a dissolved group's ballots are cleared (#108): the tallies its archive kept, which history's totals read. */
  readonly kept?: KeptTallies;
}

/** Where Add a section here puts a new section (#75): in the Document on screen (#92), after `after`. */
export interface AddPlace {
  readonly document: string;
  readonly after: string | null;
}

/**
 * Why a member who may not propose sees no Propose buttons, and where they
 * change that: following (no vote), or voting without proposing. Nothing for
 * someone whose join the relay hasn't returned yet.
 */
function LevelNote({ state, me }: { readonly state: GroupState; readonly me: string }) {
  if (!can(state, me, 'read')) return null;
  // A suspended member reads until when instead: no level change gives posting back (#102).
  if (isSuspended(state, me)) return <SuspendedNote state={state} me={me} />;
  // A newcomer reads when their vote arrives: no level proposes or votes before it (#101).
  if (!holdsRights(state, me)) return <WaitingNote state={state} me={me} />;
  const note = can(state, me, 'vote') ? messages.levels.notProposing : messages.levels.following;
  return (
    <div className="level-note">
      <p>{note}</p>
      <ChangeInvolvement groupId={state.group ?? ''} />
    </div>
  );
}

/** Props for {@link HistoryButton}. */
interface HistoryButtonProps {
  readonly source: HistorySource;
  readonly atom: Atom;
  /** The section's number in its Document. */
  readonly section: number;
}

/** A quiet History, which opens the section's history in a side sheet (#104), for anyone who reads. */
export function HistoryButton({ source, atom, section }: HistoryButtonProps) {
  const { history } = messages;
  return (
    <HistorySheet source={source} atomId={atom.id} section={section}>
      <Button className="button button-quiet" aria-label={history.openLabel(section)}>
        {history.open}
      </Button>
    </HistorySheet>
  );
}

interface SectionActionProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  readonly onPropose: DocumentViewProps['onPropose'];
  readonly onRemove: DocumentViewProps['onRemove'];
  readonly source: HistorySource;
}

/**
 * Propose a change, or Add your version while the section's Proposal is open
 * (`composeOption`), and Propose removing this section until its ballot holds
 * a removal, or why its ballot takes no more. Each opens a composer. History
 * follows them (#104).
 */
function SectionAction(props: SectionActionProps) {
  const { state, atom, section, onPropose, onRemove } = props;
  const history = <HistoryButton source={props.source} atom={atom} section={section} />;
  const option = composeOption(state, atom.id);
  if (option === 'ballot-full') {
    return (
      <>
        <p className="caption atom-note">{messages.document.ballotFull}</p>
        <div className="row atom-actions">{history}</div>
      </>
    );
  }
  const { document } = messages;
  const adding = option === 'add-version';
  const open = openProposalOn(state, atom.id);
  return (
    <div className="row atom-actions">
      <Button
        className="button button-quiet"
        aria-label={adding ? document.addVersionLabel(section) : document.proposeLabel(section)}
        onPress={() => {
          onPropose(atom.id);
        }}
      >
        {adding ? document.addVersion : document.propose}
      </Button>
      {open !== undefined && holdsRemoval(open) ? null : (
        <Button
          className="button button-quiet"
          aria-label={document.removeLabel(section)}
          onPress={() => {
            onRemove(atom.id);
          }}
        >
          {document.remove}
        </Button>
      )}
      {history}
    </div>
  );
}

interface AddHereProps {
  /** Where the new section would go: the Document on screen, after an Atom or at its start. */
  readonly place: AddPlace;
  /** The section number of the Atom it would follow, for its label. */
  readonly section: number;
  readonly onAdd: DocumentViewProps['onAdd'];
}

/** A quiet "Add a section here" in a gap between sections, or at the start or end. */
function AddHere({ place, section, onAdd }: AddHereProps) {
  const { document } = messages;
  return (
    <div className="atom-gap">
      <Button
        className="button button-quiet button-gap"
        aria-label={
          place.after === null ? document.addAtStartLabel : document.addAfterLabel(section)
        }
        onPress={() => {
          onAdd(place);
        }}
      >
        {document.addHere}
      </Button>
    </div>
  );
}

type CopyStatus = 'idle' | 'copied' | 'blocked';

interface CopyMarkdownProps {
  readonly atoms: readonly Atom[];
  readonly copyText: DocumentViewProps['copyText'];
}

/**
 * Copy as Markdown (#75; ADR-0010): the whole Document on the clipboard, for
 * a fresh group's Create group. "Copied" is announced politely. Where the
 * browser blocks the clipboard, the text shows selected in a read-only text
 * area, so the person can copy it themselves. Nothing leaves the device.
 */
export function CopyMarkdown({ atoms, copyText }: CopyMarkdownProps) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const field = useRef<HTMLTextAreaElement>(null);
  const markdown = documentToMarkdown(atoms);
  useEffect(() => {
    if (status !== 'blocked') return;
    field.current?.focus();
    field.current?.select();
  }, [status]);
  const copy = () => {
    // Back to idle first, so pressing again announces "Copied" again.
    setStatus('idle');
    copyText(markdown).then(
      () => {
        setStatus('copied');
      },
      () => {
        setStatus('blocked');
      },
    );
  };
  const { document } = messages;
  return (
    <div className="stack copy-markdown">
      <p className="caption">{document.copyHint}</p>
      <Button className="button button-secondary" onPress={copy}>
        {document.copy}
      </Button>
      <p role="status" aria-live="polite" className="status">
        {status === 'copied' ? document.copied : ''}
      </p>
      {status === 'blocked' ? (
        <TextField className="field" value={markdown} isReadOnly>
          <Label className="field-label">{document.markdownLabel}</Label>
          <Text slot="description" className="field-hint">
            {document.copyFailed}
          </Text>
          <TextArea ref={field} className="input input-document input-markdown" />
        </TextField>
      ) : null}
    </div>
  );
}

interface SectionsProps {
  readonly state: GroupState;
  /** The Document on screen (#92). */
  readonly document: GroupDocument;
  /** Its sections, in order. */
  readonly atoms: readonly Atom[];
  readonly proposes: boolean;
  readonly handlers: Pick<DocumentViewProps, 'onPropose' | 'onAdd' | 'onRemove'>;
  readonly source: HistorySource;
}

/**
 * The Document's sections in order, each with its actions, and an "Add a
 * section here" before the first, between each two and after the last, for
 * someone who may propose. An empty Document offers only the first. Every
 * section offers History, to everyone who reads it (#104).
 */
function Sections({ state, document, atoms, proposes, handlers, source }: SectionsProps) {
  const { onPropose, onAdd, onRemove } = handlers;
  const at = (after: string | null) => ({ document: document.id, after });
  const first = proposes ? <AddHere place={at(null)} section={0} onAdd={onAdd} /> : null;
  if (atoms.length === 0) {
    return (
      <>
        <p className="lede">{messages.document.empty}</p>
        {first}
      </>
    );
  }
  return (
    <article className={proposes ? 'document document-editable' : 'document'}>
      {first}
      {atoms.map((atom, index) => (
        <Fragment key={atom.id}>
          <div className="atom">
            <AtomText text={atom.text} />
            {proposes ? (
              <SectionAction
                state={state}
                atom={atom}
                section={index + 1}
                onPropose={onPropose}
                onRemove={onRemove}
                source={source}
              />
            ) : (
              <div className="row atom-actions">
                <HistoryButton source={source} atom={atom} section={index + 1} />
              </div>
            )}
          </div>
          {proposes ? <AddHere place={at(atom.id)} section={index + 1} onAdd={onAdd} /> : null}
        </Fragment>
      ))}
    </article>
  );
}

/** "Change log →", under a Document's title, to every change that passed in it (#104). */
export function ChangeLogLink({ to }: { readonly to: Route }) {
  return (
    <Link className="forward-link" href={routeHref(to)}>
      {messages.changeLog.link}
      <span aria-hidden="true">{messages.app.forward}</span>
    </Link>
  );
}

/** Shown in place of a Document the group doesn't have (#92): where to find its Documents. */
export function MissingDocument({ state }: { readonly state: GroupState }) {
  const { documents } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader title={documents.missingTitle} pageTitle={messages.document.pageTitle} />
      <p className="lede">{documents.missing}</p>
    </main>
  );
}

/**
 * Document view (`#/g/{groupId}/doc/{documentId}`, or `…/doc` for the
 * group's first Document, #92): one canonical Document, each section (Atom)
 * formatted through `<AtomText>` in the document style, with Propose a change
 * (or Add your version while the section's Proposal is open), Propose
 * removing this section, and Add a section here in each gap (#75). Nothing
 * here is ever read as HTML. Those show only when `can()` allows proposing;
 * anyone else reads why, and where to change their level (ADR-0021). While
 * this member is leaving, or once the group has dissolved (#108), the
 * Document only reads. Copy as Markdown copies the Document on screen, for
 * everyone who can read it, an archive's readers included.
 */
export function DocumentView(props: DocumentViewProps) {
  const { state, me, copyText, leaving = false } = props;
  const document = documentNamed(state, props.documentId);
  if (document === undefined) return <MissingDocument state={state} />;
  const atoms = atomsOf(state, document.id);
  const readOnly = leaving || state.dissolved !== null;
  const proposes = !readOnly && can(state, me, 'propose');
  const groupId = state.group ?? '';
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId }} label={state.name} />
      <PageHeader
        eyebrow={messages.document.eyebrow}
        title={document.title}
        pageTitle={messages.document.pageTitle}
      >
        <ChangeLogLink to={{ name: 'documentLog', groupId, documentId: document.id }} />
      </PageHeader>
      {proposes || readOnly ? null : <LevelNote state={state} me={me} />}
      <Sections
        state={state}
        document={document}
        atoms={atoms}
        proposes={proposes}
        handlers={props}
        source={groupHistory(state, props.kept)}
      />
      {atoms.length === 0 ? null : <CopyMarkdown atoms={atoms} copyText={copyText} />}
    </main>
  );
}

/** Props for {@link CoalitionDocumentView}. */
export interface CoalitionDocumentViewProps {
  /** The coalition's genesis id, whose home Back returns to. */
  readonly coalitionId: string;
  /** The coalition's name. */
  readonly name: string;
  /** The Document's id, whose change log it links to (#104). */
  readonly documentId: string;
  /** The Document's title. */
  readonly title: string;
  /** The Document's sections, in order. */
  readonly atoms: readonly Atom[];
  /** Where this person stands in the coalition (`standingIn`). */
  readonly standing: CoalitionStanding;
  /** The sections with a motion open on them, which take no new one until it's final. */
  readonly open: ReadonlySet<string>;
  /** Opens the coalition's composer for one section. */
  readonly onPropose: (atomId: string) => void;
  /** Takes part under the seat of the group `standing` names; rejects when it couldn't be saved. */
  readonly onTakePart: (name: string) => Promise<void>;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Each section's history, from the coalition's own log (#104). */
  readonly history: HistorySource;
}

/** Why there's no Propose here, and Take part where it comes first; nothing for whoever proposes. */
function CoalitionStandingNote({
  standing,
  onTakePart,
}: Pick<CoalitionDocumentViewProps, 'standing' | 'onTakePart'>) {
  const { coalitions } = messages;
  switch (standing.kind) {
    case 'proposes':
      return null;
    case 'take-part':
      return (
        <div className="level-note coalition-join">
          <p>{coalitions.takePartFirst}</p>
          <TakePart onTakePart={onTakePart} />
        </div>
      );
    case 'joining':
      return <p className="level-note">{coalitions.joining}</p>;
    case 'reads':
      return <p className="level-note">{coalitions.cantPropose}</p>;
  }
}

/**
 * One coalition section's actions: Propose a change for whoever proposes, or
 * that a motion is open on it, then History, for everyone (#104).
 */
function CoalitionSectionAction(props: {
  readonly atom: Atom;
  readonly section: number;
  readonly open: boolean;
  readonly proposes: boolean;
  readonly onPropose: (atomId: string) => void;
  readonly history: HistorySource;
}) {
  const { document, coalitions } = messages;
  const { atom, section } = props;
  const history = <HistoryButton source={props.history} atom={atom} section={section} />;
  if (props.open) {
    return (
      <>
        <p className="caption atom-note">{coalitions.sectionOpen}</p>
        <div className="row atom-actions">{history}</div>
      </>
    );
  }
  return (
    <div className="row atom-actions">
      {props.proposes ? (
        <Button
          className="button button-quiet"
          aria-label={document.proposeLabel(section)}
          onPress={() => {
            props.onPropose(atom.id);
          }}
        >
          {document.propose}
        </Button>
      ) : null}
      {history}
    </div>
  );
}

/**
 * A coalition's Document (`#/c/{coalitionId}/doc/{documentId}`; #120): its
 * sections as the coalition's last final pass left them, with Propose a
 * change on each for someone bound to a member group's seat who can propose
 * in that group, and, while a motion is open on a section, a line saying so.
 * A coalition motion only rewords a section (#100): there's no Add your
 * version, Add a section or removal here. Anyone else reads why there's no
 * Propose, or is offered Take part first. Copy as Markdown, each section's
 * History and the change log are for everyone (#104).
 */
export function CoalitionDocumentView(props: CoalitionDocumentViewProps) {
  const { atoms, standing, open } = props;
  const proposes = standing.kind === 'proposes';
  return (
    <main className="shell">
      <BackLink to={{ name: 'coalition', coalitionId: props.coalitionId }} label={props.name} />
      <PageHeader
        eyebrow={messages.coalitions.documentEyebrow}
        title={props.title}
        pageTitle={messages.document.pageTitle}
      >
        <ChangeLogLink
          to={{
            name: 'coalitionLog',
            coalitionId: props.coalitionId,
            documentId: props.documentId,
          }}
        />
      </PageHeader>
      <CoalitionStandingNote standing={standing} onTakePart={props.onTakePart} />
      {atoms.length === 0 ? (
        <p className="lede">{messages.document.empty}</p>
      ) : (
        <article className="document">
          {atoms.map((atom, index) => (
            <div key={atom.id} className="atom">
              <AtomText text={atom.text} />
              <CoalitionSectionAction
                atom={atom}
                section={index + 1}
                open={open.has(atom.id)}
                proposes={proposes}
                onPropose={props.onPropose}
                history={props.history}
              />
            </div>
          ))}
        </article>
      )}
      {atoms.length === 0 ? null : <CopyMarkdown atoms={atoms} copyText={props.copyText} />}
    </main>
  );
}
