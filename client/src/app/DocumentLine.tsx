/**
 * The line that leads a Proposal's card, ballot and result (#92): the title of
 * the Document it changes, or "New Document: <title>" for a new Document's
 * Proposal. A group's own words, so the title sits in `<bdi>`.
 */
import { Link } from 'react-aria-components';

import type { DocumentLead } from './documentLines';
import { messages } from './messages';
import { routeHref } from './router';

/** Props for {@link DocumentLine}. */
export interface DocumentLineProps {
  /** What the Proposal changes or creates, from `documentLead`, or null to show nothing. */
  readonly lead: DocumentLead | null;
  /**
   * The group, when the title links to its Document, as on the Proposal's own
   * page; a card, a link itself, leaves it out. A new Document links once it
   * exists.
   */
  readonly groupId?: string;
}

/** The title, linked to its Document when there's a group to link in and the Document exists. */
function Title({ lead, groupId }: { readonly lead: DocumentLead; readonly groupId?: string }) {
  const title = <bdi>{lead.title}</bdi>;
  const exists = lead.kind === 'document' || lead.exists;
  if (groupId === undefined || !exists) return title;
  const href = routeHref({ name: 'document', groupId, documentId: lead.id });
  return <Link href={href}>{title}</Link>;
}

/**
 * The Document a Proposal changes, or the new one it proposes, in one quiet
 * line: a paragraph on the Proposal's page, where its title links to the
 * Document, and a span inside a card. Nothing for none.
 */
export function DocumentLine({ lead, groupId }: DocumentLineProps) {
  if (lead === null) return null;
  const content = (
    <>
      {lead.kind === 'new' ? <>{messages.documents.newPrefix} </> : null}
      <Title lead={lead} {...(groupId === undefined ? {} : { groupId })} />
    </>
  );
  return groupId === undefined ? (
    <span className="document-of">{content}</span>
  ) : (
    <p className="document-of">{content}</p>
  );
}
