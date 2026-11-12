import { Link } from 'react-aria-components';

import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { BackLink, PageHeader } from '../app/ui';
import { pauseOf, type SharePause } from '../share/shareLink';
import type { PersonalEntry } from '../store/personal';

/** Props for {@link Personal}. */
export interface PersonalProps {
  /** This device's personal Documents, oldest first. */
  readonly documents: readonly PersonalEntry[];
  /** The id a new Document opens at; nothing is stored under it until its first save. */
  readonly newId: string;
  /** The device clock in ms: a share it hasn't posted to for 30 days is paused (#339). */
  readonly now: number;
  /**
   * Whether the device keeps a relay backup key (#97), whose sealed copy
   * carries every personal Document, or null until the store has said: then
   * no line on where they go shows, since a wrong one is worse than none
   * (#248).
   */
  readonly relayBackup: boolean | null;
}

/** Personal's line on where its Documents go, as the relay backup has them or not (#248). */
function privacyLine(relayBackup: boolean): string {
  const { privacy, privacyRelayBackup } = messages.personal;
  return relayBackup ? privacyRelayBackup : privacy;
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

/** The line under a paused share's Document on Personal, as the share came to wait. */
const PAUSED_LINE: Readonly<Record<SharePause, string>> = {
  restored: messages.personal.pausedLine,
  idle: messages.personal.idleLine,
};

/**
 * The line under a Document's title on Personal at `now`: shared by link
 * (#105), or paused after a restore (#328) or 30 days with no post (#339).
 */
function shareLine({ share }: PersonalEntry, now: number): { readonly line?: string } {
  if (share === undefined) return {};
  const pause = pauseOf(share, now);
  return { line: pause === null ? messages.personal.sharedLine : PAUSED_LINE[pause] };
}

/** Every Document by title, a shared one marked as such (#105), then New document. */
function DocumentList({
  documents,
  newId,
  now,
}: Pick<PersonalProps, 'documents' | 'newId' | 'now'>) {
  return (
    <div className="stack">
      <ul className="card-list">
        {documents.map((document) => (
          <li key={document.id}>
            <DocumentCard id={document.id} title={document.title} {...shareLine(document, now)} />
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
 * is stored until its first save. A Document shared by link says so under
 * its title (#105), and one whose share is paused says why: a restore (#328),
 * or 30 days with no post from this device (#339). One line says what stays
 * on this device, and, once the device keeps a relay backup key, that its
 * sealed relay backup has them too
 * (#248).
 */
export function Personal({ documents, newId, now, relayBackup }: PersonalProps) {
  const { personal } = messages;
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={personal.title} pageTitle={personal.pageTitle} />
      <p className="lede">{personal.lede}</p>
      {documents.length === 0 ? (
        <DocumentCard id={newId} title={personal.missionTitle} line={personal.missionPrompt} />
      ) : (
        <DocumentList documents={documents} newId={newId} now={now} />
      )}
      {relayBackup === null ? null : <p className="caption">{privacyLine(relayBackup)}</p>}
    </main>
  );
}
