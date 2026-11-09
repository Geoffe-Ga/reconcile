import { Fragment, useMemo } from 'react';

import { messages } from '../messages';
import { type DiffPart, wordDiff } from './wordDiff';

/** Props for {@link WordDiff}. */
export interface WordDiffProps {
  /** The Atom's text now. */
  readonly current: string;
  /** The text a Proposal would put in its place. */
  readonly proposed: string;
}

/**
 * One run of the diff. Each change is named in hidden text first, for screen
 * readers. The label is a plain span with a class, not a component, because a
 * long rewrite can hold hundreds of them.
 */
function Run({ part }: { readonly part: DiffPart }) {
  if ('same' in part) return part.same;
  const added = 'added' in part;
  return (
    <>
      <span className="visually-hidden diff-label">
        {' '}
        {added ? messages.diff.added : messages.diff.removed}{' '}
      </span>
      {added ? <ins>{part.added}</ins> : <del>{part.removed}</del>}
    </>
  );
}

/**
 * A Proposal's change as a word diff of the Atom's Markdown source (DESIGN.md,
 * "Ballot"), set in the document face with its line breaks kept. Additions sit
 * on `primary-soft` and are underlined; deletions are struck through on a
 * `negative` tint. Each is also preceded by a hidden "added" or "removed", so
 * color is never the only signal.
 */
export function WordDiff({ current, proposed }: WordDiffProps) {
  const parts = useMemo(() => wordDiff(current, proposed), [current, proposed]);
  return (
    <p className="word-diff" dir="auto">
      {parts.map((part, index) => (
        // A diff's runs never reorder, so their positions are stable keys.
        <Fragment key={index}>
          <Run part={part} />
        </Fragment>
      ))}
    </p>
  );
}
