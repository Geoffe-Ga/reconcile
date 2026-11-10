/**
 * An invite's preview card (spec §8.4; ADR-0052): who sent the invite, the
 * Document's title and its first section.
 *
 * Every field arrives inside the sealed envelope, written by the inviter's
 * device, so it renders as plain text inside `<bdi>`, never as Markdown or
 * HTML: nothing in a preview can run script, load anything or reorder the
 * text around it. Join and the install guide (#76) both show it.
 */
import type { InvitePreview as Preview } from '../invite/envelope';
import { messages } from '../app/messages';

/** Props for {@link InvitePreview}. */
export interface InvitePreviewProps {
  /** The preview from the invite's header. */
  readonly preview: Preview;
}

/** "From Ana’s invite", then the Document's title and its first section. */
export function InvitePreview({ preview }: InvitePreviewProps) {
  return (
    <div className="card invite-preview">
      <p className="invite-from">
        {messages.join.fromBefore} <bdi>{preview.inviterName}</bdi>
        {messages.join.fromAfter}
      </p>
      <div className="invite-document">
        <p className="eyebrow">{messages.join.documentLabel}</p>
        <p className="heading-2">
          <bdi>{preview.documentTitle}</bdi>
        </p>
        {preview.excerpt === '' ? null : (
          <p className="invite-excerpt">
            <bdi>{preview.excerpt}</bdi>
          </p>
        )}
      </div>
    </div>
  );
}
