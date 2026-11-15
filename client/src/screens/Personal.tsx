import { Link } from 'react-aria-components';

import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { BackLink, PageHeader } from '../app/ui';
import type { PersonalDocument } from '../store/personal';

/** Props for {@link Personal}. */
export interface PersonalProps {
  /** This device's personal Documents, oldest first. */
  readonly documents: readonly PersonalDocument[];
  /** The id a new Document opens at; nothing is stored under it until its first save. */
  readonly newId: string;
}

/** A card that opens `#/me/{id}`: a title, and an optional line under it. */
function DocumentCard({
  id,
  title,
  line,
}: {
  readonly id: string;
  readonly title: string;
  readonly line?: string;
}) {
  return (
    <Link className="card-link" href={routeHref({ name: 'personalDocument', id })}>
      <span className="card-link-title">
        <span className="heading-3">
          <bdi>{title}</bdi>
        </span>
        <span className="card-link-arrow" aria-hidden="true">
          {messages.app.forward}
        </span>
      </span>
      {line === undefined ? null : <span className="caption">{line}</span>}
    </Link>
  );
}

/** Every Document by title, then New document. */
function DocumentList({ documents, newId }: PersonalProps) {
  return (
    <div className="stack">
      <ul className="card-list">
        {documents.map((document) => (
          <li key={document.id}>
            <DocumentCard id={document.id} title={document.title} />
          </li>
        ))}
      </ul>
      <Link
        className="button button-primary"
        href={routeHref({ name: 'personalDocument', id: newId })}
      >
        {messages.personal.newDocument}
      </Link>
    </div>
  );
}

/**
 * Personal (`#/me`; #93), reached from Start: this device's personal
 * Documents, one list, each opening at `#/me/{id}`, then New document. With
 * none yet, it offers My mission statement with one prompt line, and nothing
 * is stored until its first save. One line says what stays on this device.
 */
export function Personal({ documents, newId }: PersonalProps) {
  const { personal } = messages;
  return (
    <main className="shell" data-scene="soil">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={personal.title} pageTitle={personal.pageTitle} />
      <p className="lede">{personal.lede}</p>
      {documents.length === 0 ? (
        <DocumentCard id={newId} title={personal.missionTitle} line={personal.missionPrompt} />
      ) : (
        <DocumentList documents={documents} newId={newId} />
      )}
      <p className="caption">{personal.privacy}</p>
    </main>
  );
}
