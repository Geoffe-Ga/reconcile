/**
 * An invite's preview card (spec §8.4; ADR-0052): who sent the invite, the
 * Document's title and its first section, or on Join the whole Document
 * (#91).
 *
 * Every field arrives inside the sealed envelope, written by the inviter's
 * device, so it renders as plain text inside `<bdi>`, never as Markdown or
 * HTML: nothing in a preview can run script, load anything or reorder the
 * text around it. Join and the install guide (#76) both show it.
 */
import { type ReactNode, useEffect, useRef } from 'react';

import type { InvitePreview as Preview } from '../invite/envelope';
import { messages } from '../app/messages';

/** Props for {@link InvitePreview}. */
export interface InvitePreviewProps {
  /** The preview from the invite's header. */
  readonly preview: Preview;
  /**
   * The whole Document, which Join shows in the excerpt's place (#91). Its
   * title then heads it as a heading, which takes focus as the card appears.
   */
  readonly children?: ReactNode;
}

/** The Document's title as the heading of the Document that follows it, focused on arrival. */
function DocumentHeading({ title }: { readonly title: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <h2 ref={heading} tabIndex={-1} className="heading-2">
      <bdi>{title}</bdi>
    </h2>
  );
}

/** "From Ana’s invite", then the Document's title and its first section, or the whole Document. */
export function InvitePreview({ preview, children }: InvitePreviewProps) {
  return (
    <div className="card invite-preview">
      <p className="invite-from">
        {messages.join.fromBefore} <bdi>{preview.inviterName}</bdi>
        {messages.join.fromAfter}
      </p>
      <div className="invite-document">
        <p className="eyebrow">{messages.join.documentLabel}</p>
        {children === undefined ? (
          <>
            <p className="heading-2">
              <bdi>{preview.documentTitle}</bdi>
            </p>
            {preview.excerpt === '' ? null : (
              <p className="invite-excerpt">
                <bdi>{preview.excerpt}</bdi>
              </p>
            )}
          </>
        ) : (
          <>
            <DocumentHeading title={preview.documentTitle} />
            {children}
          </>
        )}
      </div>
    </div>
  );
}
