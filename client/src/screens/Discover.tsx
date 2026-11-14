/**
 * Discover (`#/discover`; #423, ADR-0077 §6–§7, DESIGN.md "Discover"): one
 * of the tab bar's three places. Today it holds the empty state's one
 * sentence and one line pointing to the link bar at the top, where an
 * invite, a reconcile card, a follow link or a front door link opens on
 * every screen (#444). Shelf entries come in a later issue (ADR-0077 §1).
 * Nothing here reaches the network.
 */
import { messages } from '../app/messages';
import { PageHeader } from '../app/ui';

/** The eyebrow and heading, the empty state's one sentence, and where a card or link opens. */
export function Discover() {
  const words = messages.discover;
  return (
    <main className="shell">
      <PageHeader eyebrow={messages.app.name} title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.empty}</p>
      <p>{words.pasteInBar}</p>
    </main>
  );
}
