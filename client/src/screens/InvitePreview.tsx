import type { FoundGroup } from '../app/actions';
import { messages } from '../app/messages';

/** Props for {@link InvitePreview}. */
export interface InvitePreviewProps {
  /** What the invite's mailbox showed of the group. */
  readonly group: Pick<FoundGroup, 'title'>;
}

/**
 * What an invite shows of its group before anyone joins: Join's card, which
 * the install guide shows too (#76). Group words render as plain text in
 * `<bdi>`. #73 adds the inviter and an excerpt here, for both screens.
 */
export function InvitePreview({ group }: InvitePreviewProps) {
  return (
    <div className="card">
      <p className="eyebrow">{messages.join.documentLabel}</p>
      <p className="heading-2">
        <bdi>{group.title}</bdi>
      </p>
    </div>
  );
}
