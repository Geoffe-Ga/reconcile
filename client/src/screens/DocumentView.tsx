import { Button } from 'react-aria-components';

import { ChangeInvolvement } from '../app/LevelPicker';
import { messages } from '../app/messages';
import { SuspendedNote } from '../app/stewards';
import { AtomText } from '../app/text/AtomText';
import { BackLink, PageHeader } from '../app/ui';
import { can, isSuspended } from '../engine/capabilities';
import { composeOption } from '../engine/composeOption';
import type { Atom, GroupState } from '../engine/fold';

/** Props for {@link DocumentView}. */
export interface DocumentViewProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** This device's author id in the group. */
  readonly me: string;
  /** Opens the composer for one section. */
  readonly onPropose: (atomId: string) => void;
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
}

/**
 * Propose a change, or Add your version while the section's Proposal is open
 * (`composeOption`), or why its ballot takes no more. Both open the composer.
 */
function SectionAction({ state, atom, section, onPropose }: SectionActionProps) {
  const option = composeOption(state, atom.id);
  if (option === 'ballot-full') {
    return <p className="caption atom-note">{messages.document.ballotFull}</p>;
  }
  const { document } = messages;
  const adding = option === 'add-version';
  return (
    <Button
      className="button button-quiet"
      aria-label={adding ? document.addVersionLabel(section) : document.proposeLabel(section)}
      onPress={() => {
        onPropose(atom.id);
      }}
    >
      {adding ? document.addVersion : document.propose}
    </Button>
  );
}

/**
 * Document view (`#/g/{groupId}/doc`): the canonical Document, each section
 * (Atom) formatted through `<AtomText>` in the document style, with Propose a
 * change, or Add your version while the section's Proposal is open. Nothing
 * here is ever read as HTML. Those show only when `can()` allows proposing;
 * anyone else reads why, and where to change their level (ADR-0021).
 */
export function DocumentView({ state, me, onPropose }: DocumentViewProps) {
  const proposes = can(state, me, 'propose');
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        eyebrow={messages.document.eyebrow}
        title={state.title}
        pageTitle={messages.document.pageTitle}
      />
      {proposes ? null : <LevelNote state={state} me={me} />}
      {state.atoms.length === 0 ? (
        <p className="lede">{messages.document.empty}</p>
      ) : (
        <article className="document">
          {state.atoms.map((atom, index) => (
            <div key={atom.id} className="atom">
              <AtomText text={atom.text} />
              {proposes ? (
                <SectionAction
                  state={state}
                  atom={atom}
                  section={index + 1}
                  onPropose={onPropose}
                />
              ) : null}
            </div>
          ))}
        </article>
      )}
    </main>
  );
}
