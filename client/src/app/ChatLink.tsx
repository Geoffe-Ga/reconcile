import { Link, VisuallyHidden } from 'react-aria-components';

import { httpLink } from './links';
import { messages } from './messages';

/** Props for {@link ChatLink}. */
export interface ChatLinkProps {
  /** The group's chat link from its log: untrusted text, or null when it has none. */
  readonly href: string | null;
}

/**
 * "Join discussion": the group's own chat, opened in a new tab (ADR-0011).
 *
 * Renders only an absolute `http:` or `https:` link, as parsed, and nothing
 * otherwise, so a `javascript:` link from the log never becomes an `href`.
 */
export function ChatLink({ href }: ChatLinkProps) {
  const link = href === null ? null : httpLink(href);
  if (link === null) return null;
  return (
    <Link className="button button-secondary" href={link} target="_blank" rel="noopener noreferrer">
      {messages.home.joinDiscussion} <span aria-hidden="true">{messages.app.outward}</span>{' '}
      <VisuallyHidden>{messages.app.newTab}</VisuallyHidden>
    </Link>
  );
}
