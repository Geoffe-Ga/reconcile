import { Button } from 'react-aria-components';

import { ChangeInvolvement } from '../app/LevelPicker';
import { messages } from '../app/messages';
import { AtomText } from '../app/text/AtomText';
import { BackLink, PageHeader } from '../app/ui';
import { can } from '../engine/capabilities';
import type { GroupState } from '../engine/fold';

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
  const note = can(state, me, 'vote') ? messages.levels.notProposing : messages.levels.following;
  return (
    <div className="level-note">
      <p>{note}</p>
      <ChangeInvolvement groupId={state.group ?? ''} />
    </div>
  );
}

/**
 * Document view (`#/g/{groupId}/doc`): the canonical Document, each section
 * (Atom) formatted through `<AtomText>` in the document style. Nothing here is
 * ever read as HTML. Propose a change shows only when `can()` allows it;
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
                <Button
                  className="button button-quiet"
                  aria-label={messages.document.proposeLabel(index + 1)}
                  onPress={() => {
                    onPropose(atom.id);
                  }}
                >
                  {messages.document.propose}
                </Button>
              ) : null}
            </div>
          ))}
        </article>
      )}
    </main>
  );
}
