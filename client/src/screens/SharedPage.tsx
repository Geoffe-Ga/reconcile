import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from '../app/messages';
import { AtomText } from '../app/text/AtomText';
import { PageHeader } from '../app/ui';
import {
  parseSharePayload,
  readShare,
  type ShareReader,
  type SharedView,
} from '../share/shareLink';

/** Props for {@link SharedPage}. */
export interface SharedPageProps {
  /** What follows `#share/` in the address bar, as written. */
  readonly payload: string;
  /** The relay and the seal: all the page reaches. */
  readonly reader: ShareReader;
}

/** Where the page has got to: reading, shown, not shared, or unable to reach the relay. */
type Phase = { readonly kind: 'loading' } | SharedView | { readonly kind: 'offline' };

/** The line above the title on every state: what this page is. */
function SharedNote() {
  return <p className="shared-note">{messages.shared.note}</p>;
}

/** The Document as its link shows it: the title as plain text, then the text formatted. */
function Shown({ title, text }: { readonly title: string; readonly text: string }) {
  const { shared } = messages;
  return (
    <main className="shell">
      <SharedNote />
      <PageHeader title={title} pageTitle={shared.pageTitle} />
      {text.trim() === '' ? (
        <p className="lede">{shared.empty}</p>
      ) : (
        <article className="document">
          <AtomText text={text} />
        </article>
      )}
    </main>
  );
}

/** A heading and one line, for every state with no Document to show. */
function Notice({
  title,
  line,
  onRetry,
}: {
  readonly title: string;
  readonly line: string;
  readonly onRetry?: () => void;
}) {
  return (
    <main className="shell">
      <SharedNote />
      <PageHeader title={title} pageTitle={messages.shared.pageTitle} />
      <div className="stack">
        <p className="lede">{line}</p>
        {onRetry === undefined ? null : (
          <div>
            <Button className="button button-primary" onPress={onRetry}>
              {messages.shared.retry}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * The page a share link opens (`#share/{seed}.{publicKey}`; #105), for
 * anyone, in any browser, outside first run: it reads the share's mailbox,
 * keeps only copies the link's key signed, and shows the latest one under
 * "Shared with Reconcile. Read-only." A tombstone, an empty mailbox, no valid
 * copy and a damaged link all read as not shared, and a damaged link makes
 * no request. It opens no database, makes no key, writes no web storage and
 * starts no sync, and it leaves the link in the address bar, so a reload
 * reads it again. The tab's title never carries the Document's words.
 */
export function SharedPage({ payload, reader }: SharedPageProps) {
  const link = useMemo(() => parseSharePayload(payload), [payload]);
  const [attempt, setAttempt] = useState(0);
  // Each read's answer, kept with the read it answers, so a new link or a retry reads as loading.
  const [answer, setAnswer] = useState<{ readonly key: string; readonly phase: Phase } | null>(
    null,
  );
  const key = `${payload} ${String(attempt)}`;
  useEffect(() => {
    if (link === null) return;
    let live = true;
    const settle = (phase: Phase) => {
      if (live) setAnswer({ key, phase });
    };
    readShare(reader, link).then(settle, () => {
      settle({ kind: 'offline' });
    });
    return () => {
      live = false;
    };
  }, [link, reader, key]);
  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
  // A damaged link reads as not shared at once, with no request.
  const phase: Phase =
    link === null ? { kind: 'gone' } : answer?.key === key ? answer.phase : { kind: 'loading' };
  const { shared } = messages;
  switch (phase.kind) {
    case 'loading':
      return (
        <main className="shell" aria-busy="true">
          <SharedNote />
          <PageHeader title={shared.loading} pageTitle={shared.pageTitle} />
        </main>
      );
    case 'shown':
      return <Shown title={phase.title} text={phase.text} />;
    case 'gone':
      return <Notice title={shared.goneTitle} line={shared.gone} />;
    case 'offline':
      return <Notice title={shared.offlineTitle} line={shared.offline} onRetry={retry} />;
  }
}
