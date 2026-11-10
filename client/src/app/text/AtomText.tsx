import { useMemo } from 'react';

import { renderAtom } from './markdown';

/** Props for {@link AtomText}. */
export interface AtomTextProps {
  /** The Atom's text from the group log: untrusted Markdown. */
  readonly text: string;
  /** Extra classes for where it sits, such as `atom-card`. */
  readonly className?: string;
}

/**
 * The only renderer of Atom text (ADR-0023): the CommonMark subset set in the
 * document style, built from an allowlist with nothing parsed as HTML, or the
 * source as plain text when anything falls outside it (see `./markdown`).
 */
export function AtomText({ text, className }: AtomTextProps) {
  const nodes = useMemo(() => renderAtom(text), [text]);
  const classes = className === undefined ? 'atom-text' : `atom-text ${className}`;
  return (
    <div className={classes} dir="auto">
      {nodes}
    </div>
  );
}
