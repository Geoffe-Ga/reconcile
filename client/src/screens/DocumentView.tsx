import { Fragment, useEffect, useRef, useState } from 'react';
import { Button, Label, Text, TextArea, TextField } from 'react-aria-components';

import { ChangeInvolvement } from '../app/LevelPicker';
import { messages } from '../app/messages';
import { WaitingNote } from '../app/Newcomer';
import { SuspendedNote } from '../app/stewards';
import { AtomText } from '../app/text/AtomText';
import { BackLink, PageHeader } from '../app/ui';
import { holdsRemoval } from '../app/versionViews';
import { can, holdsRights, isSuspended } from '../engine/capabilities';
import { composeOption, openProposalOn } from '../engine/composeOption';
import { documentToMarkdown } from '../engine/documentMarkdown';
import type { Atom, GroupState } from '../engine/fold';

/** Props for {@link DocumentView}. */
export interface DocumentViewProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** Opens the composer for one section. */
  readonly onPropose: (atomId: string) => void;
  /** Opens the composer for a new section after Atom `after`, or first for null (#75). */
  readonly onAdd: (after: string | null) => void;
  /** Opens the composer that proposes removing one section (#75). */
  readonly onRemove: (atomId: string) => void;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Whether this device's leave waits for the relay (#77): then nobody proposes from here. */
  readonly leaving?: boolean;
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
  readonly onPropose: DocumentViewProps['onPropose'];
  readonly onRemove: DocumentViewProps['onRemove'];
}

/**
 * Propose a change, or Add your version while the section's Proposal is open
 * (`composeOption`), and Propose removing this section until its ballot holds
 * a removal, or why its ballot takes no more. Each opens a composer.
 */
function SectionAction({ state, atom, section, onPropose, onRemove }: SectionActionProps) {
  const option = composeOption(state, atom.id);
  if (option === 'ballot-full') {
    return <p className="caption atom-note">{messages.document.ballotFull}</p>;
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
    </div>
  );
}

interface AddHereProps {
  /** The Atom the new section would follow, or null for the start. */
  readonly after: string | null;
  /** That Atom's section number, for its label. */
  readonly section: number;
  readonly onAdd: DocumentViewProps['onAdd'];
}

/** A quiet "Add a section here" in a gap between sections, or at the start or end. */
function AddHere({ after, section, onAdd }: AddHereProps) {
  const { document } = messages;
  return (
    <div className="atom-gap">
      <Button
        className="button button-quiet button-gap"
        aria-label={after === null ? document.addAtStartLabel : document.addAfterLabel(section)}
        onPress={() => {
          onAdd(after);
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
function CopyMarkdown({ atoms, copyText }: CopyMarkdownProps) {
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
  readonly proposes: boolean;
  readonly handlers: Pick<DocumentViewProps, 'onPropose' | 'onAdd' | 'onRemove'>;
}

/**
 * The sections in order, each with its actions, and an "Add a section here"
 * before the first, between each two and after the last, for someone who may
 * propose. An empty Document offers only the first.
 */
function Sections({ state, proposes, handlers }: SectionsProps) {
  const { onPropose, onAdd, onRemove } = handlers;
  const first = proposes ? <AddHere after={null} section={0} onAdd={onAdd} /> : null;
  if (state.atoms.length === 0) {
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
      {state.atoms.map((atom, index) => (
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
              />
            ) : null}
          </div>
          {proposes ? <AddHere after={atom.id} section={index + 1} onAdd={onAdd} /> : null}
        </Fragment>
      ))}
    </article>
  );
}

/**
 * Document view (`#/g/{groupId}/doc`): the canonical Document, each section
 * (Atom) formatted through `<AtomText>` in the document style, with Propose a
 * change (or Add your version while the section's Proposal is open), Propose
 * removing this section, and Add a section here in each gap (#75). Nothing
 * here is ever read as HTML. Those show only when `can()` allows proposing;
 * anyone else reads why, and where to change their level (ADR-0021). While
 * this member is leaving, or once the group has dissolved (#108), the
 * Document only reads. Copy as Markdown is for everyone who can read it, an
 * archive's readers included.
 */
export function DocumentView(props: DocumentViewProps) {
  const { state, me, copyText, leaving = false } = props;
  const readOnly = leaving || state.dissolved !== null;
  const proposes = !readOnly && can(state, me, 'propose');
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        eyebrow={messages.document.eyebrow}
        title={state.title}
        pageTitle={messages.document.pageTitle}
      />
      {proposes || readOnly ? null : <LevelNote state={state} me={me} />}
      <Sections state={state} proposes={proposes} handlers={props} />
      {state.atoms.length === 0 ? null : <CopyMarkdown atoms={state.atoms} copyText={copyText} />}
    </main>
  );
}
