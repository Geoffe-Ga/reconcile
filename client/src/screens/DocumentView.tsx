import { Button } from 'react-aria-components';

import { messages } from '../app/messages';
import { BackLink, PageHeader } from '../app/ui';
import type { GroupState } from '../engine/fold';

/** Props for {@link DocumentView}. */
export interface DocumentViewProps {
  /** The group, folded from relay records. */
  readonly state: GroupState;
  /** Opens the composer for one section. #66 wires it; until then the buttons are disabled. */
  readonly onPropose?: (atomId: string) => void;
}

/**
 * Document view (`#/g/{groupId}/doc`): the canonical Document, each section
 * (Atom) set as plain text in the document style. Markdown arrives in #70;
 * until then nothing here is ever read as HTML.
 */
export function DocumentView({ state, onPropose }: DocumentViewProps) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId: state.group ?? '' }} label={state.name} />
      <PageHeader
        eyebrow={messages.document.eyebrow}
        title={state.title}
        pageTitle={messages.document.pageTitle}
      />
      {state.atoms.length === 0 ? (
        <p className="lede">{messages.document.empty}</p>
      ) : (
        <article className="document">
          {state.atoms.map((atom, index) => (
            <div key={atom.id} className="atom">
              <p className="atom-text" dir="auto">
                {atom.text}
              </p>
              <Button
                className="button button-quiet"
                aria-label={messages.document.proposeLabel(index + 1)}
                isDisabled={onPropose === undefined}
                onPress={() => onPropose?.(atom.id)}
              >
                {messages.document.propose}
              </Button>
            </div>
          ))}
        </article>
      )}
    </main>
  );
}
