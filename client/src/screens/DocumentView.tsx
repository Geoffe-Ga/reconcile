import { Fragment, useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  type Key,
  Label,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Text,
  TextArea,
  TextField,
} from 'react-aria-components';

import type { CoalitionStanding } from '../app/coalitionHome';
import { TakePart } from '../app/CoalitionSection';
import { documentNamed } from '../app/documentLines';
import { ChangeInvolvement } from '../app/LevelPicker';
import { messages } from '../app/messages';
import { WaitingNote } from '../app/Newcomer';
import { SuspendedNote } from '../app/stewards';
import { AtomText } from '../app/text/AtomText';
import { BackLink, PageHeader } from '../app/ui';
import { holdsRemoval } from '../app/versionViews';
import { type HeadingLevel, isHeadingOnly } from '../engine/atomText';
import { can, holdsRights, isSuspended } from '../engine/capabilities';
import { type ComposeOption, composeOption, openProposalOn } from '../engine/composeOption';
import { documentToMarkdown } from '../engine/documentMarkdown';
import { atomsOf, type GroupDocument } from '../engine/documents';
import type { Atom, GroupState } from '../engine/fold';

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
  /** Opens the composer that proposes moving one section (#103). */
  readonly onMove: (atomId: string) => void;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Whether this device's leave waits for the relay (#77): then nobody proposes from here. */
  readonly leaving?: boolean;
}

/**
 * Where Add a section here puts a new section (#75): in the Document on
 * screen (#92), after `after`, and, for a header (#103), its level.
 */
export interface AddPlace {
  readonly document: string;
  readonly after: string | null;
  readonly heading?: HeadingLevel;
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

interface SectionActionProps {
  readonly state: GroupState;
  readonly atom: Atom;
  readonly section: number;
  /** Whether the section has anywhere to move to: its Document holds another (#103). */
  readonly movable: boolean;
  readonly onPropose: DocumentViewProps['onPropose'];
  readonly onRemove: DocumentViewProps['onRemove'];
  readonly onMove: DocumentViewProps['onMove'];
}

/**
 * Propose a change, or Add your version while the section's Proposal is open
 * (`composeOption`), and Propose removing this section until its ballot holds
 * a removal; or why its ballot takes no more, or that a move of it is open
 * (#103). Each opens a composer.
 */
function ChangeActions(props: Omit<SectionActionProps, 'movable' | 'onMove'>) {
  const { state, atom, section, onPropose, onRemove } = props;
  const option = composeOption(state, atom.id);
  const { document } = messages;
  if (option === 'ballot-full') return <p className="caption atom-note">{document.ballotFull}</p>;
  if (option === 'moving') return <p className="caption atom-note">{document.moving}</p>;
  const adding = option === 'add-version';
  const open = openProposalOn(state, atom.id);
  return (
    <>
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
    </>
  );
}

interface MoveActionProps {
  readonly atom: Atom;
  readonly section: number;
  /** What `composeOption` reports: anything but `'propose'` means the section is busy. */
  readonly option: ComposeOption;
  readonly onMove: DocumentViewProps['onMove'];
}

/**
 * Move this section (#103), which opens its composer, or, while the section
 * has an open Proposal, the same button disabled with why beside it.
 */
function MoveAction({ atom, section, option, onMove }: MoveActionProps) {
  const reason = useId();
  const { document } = messages;
  const busy = option !== 'propose';
  return (
    <>
      <Button
        className="button button-quiet"
        aria-label={document.moveLabel(section)}
        isDisabled={busy}
        {...(busy ? { 'aria-describedby': reason } : {})}
        onPress={() => {
          onMove(atom.id);
        }}
      >
        {document.move}
      </Button>
      {busy ? (
        <p id={reason} className="caption atom-note move-reason">
          {document.moveBusy}
        </p>
      ) : null}
    </>
  );
}

/** One section's actions: changing, removing or versioning it, then moving it (#103). */
function SectionAction({ movable, onMove, ...props }: SectionActionProps) {
  return (
    <div className="row atom-actions">
      <ChangeActions {...props} />
      {movable ? (
        <MoveAction
          atom={props.atom}
          section={props.section}
          option={composeOption(props.state, props.atom.id)}
          onMove={onMove}
        />
      ) : null}
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

/** Each Add a section here choice (#103): a section, or a header of the level it names. */
const ADD_CHOICES: readonly { readonly id: string; readonly heading?: HeadingLevel }[] = [
  { id: 'section' },
  { id: 'header', heading: 1 },
  { id: 'subheader', heading: 2 },
];

/**
 * A quiet "Add a section here" in a gap between sections, or at the start or
 * end, which offers a section, a section header or a subsection header
 * (#103) in a React Aria menu, each opening its composer.
 */
function AddHere({ place, section, onAdd }: AddHereProps) {
  const { document } = messages;
  const words: Readonly<Record<string, string>> = {
    section: document.addSection,
    header: document.addHeader,
    subheader: document.addSubheader,
  };
  const choose = (key: Key) => {
    const heading = ADD_CHOICES.find((choice) => choice.id === key)?.heading;
    onAdd(heading === undefined ? place : { ...place, heading });
  };
  return (
    <div className="atom-gap">
      <MenuTrigger>
        <Button
          className="button button-quiet button-gap"
          aria-label={
            place.after === null ? document.addAtStartLabel : document.addAfterLabel(section)
          }
        >
          {document.addHere}
        </Button>
        <Popover className="menu-popover" placement="bottom start">
          <Menu className="menu" onAction={choose}>
            {ADD_CHOICES.map((choice) => (
              <MenuItem key={choice.id} id={choice.id} className="menu-item">
                {words[choice.id]}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
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
  readonly handlers: Pick<DocumentViewProps, 'onPropose' | 'onAdd' | 'onRemove' | 'onMove'>;
}

/**
 * The Document's sections in order, each with its actions, and an "Add a
 * section here" before the first, between each two and after the last, for
 * someone who may propose. An empty Document offers only the first. A
 * heading-only section sets as a header (#103).
 */
function Sections({ state, document, atoms, proposes, handlers }: SectionsProps) {
  const { onPropose, onAdd, onRemove, onMove } = handlers;
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
          <div className={isHeadingOnly(atom.text) ? 'atom atom-heading' : 'atom'}>
            <AtomText text={atom.text} />
            {proposes ? (
              <SectionAction
                state={state}
                atom={atom}
                section={index + 1}
                movable={atoms.length > 1}
                onPropose={onPropose}
                onRemove={onRemove}
                onMove={onMove}
              />
            ) : null}
          </div>
          {proposes ? <AddHere place={at(atom.id)} section={index + 1} onAdd={onAdd} /> : null}
        </Fragment>
      ))}
    </article>
  );
}

/** Shown in place of a Document the group doesn't have (#92): where to find its Documents. */
function MissingDocument({ state }: { readonly state: GroupState }) {
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
 * removing this section, Move this section (#103), and Add a section here in
 * each gap (#75), which offers a section or a header (#103). Nothing
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
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        eyebrow={messages.document.eyebrow}
        title={document.title}
        pageTitle={messages.document.pageTitle}
      />
      {proposes || readOnly ? null : <LevelNote state={state} me={me} />}
      <Sections
        state={state}
        document={document}
        atoms={atoms}
        proposes={proposes}
        handlers={props}
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

/** One coalition section's action: Propose a change, or that a motion is open on it. */
function CoalitionSectionAction(props: {
  readonly atom: Atom;
  readonly section: number;
  readonly open: boolean;
  readonly proposes: boolean;
  readonly onPropose: (atomId: string) => void;
}) {
  const { document, coalitions } = messages;
  if (props.open) return <p className="caption atom-note">{coalitions.sectionOpen}</p>;
  if (!props.proposes) return null;
  return (
    <div className="row atom-actions">
      <Button
        className="button button-quiet"
        aria-label={document.proposeLabel(props.section)}
        onPress={() => {
          props.onPropose(props.atom.id);
        }}
      >
        {document.propose}
      </Button>
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
 * Propose, or is offered Take part first. Copy as Markdown is for everyone.
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
      />
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
              />
            </div>
          ))}
        </article>
      )}
      {atoms.length === 0 ? null : <CopyMarkdown atoms={atoms} copyText={props.copyText} />}
    </main>
  );
}
