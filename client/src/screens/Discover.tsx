/**
 * Discover (`#/discover`; #423, ADR-0077 §6–§7, DESIGN.md "Discover"): one of
 * the tab bar's three places. Today it holds the empty state's one sentence
 * and "Open a card or link", the field Start shares (`OpenLink`), which reads
 * an invite, a reconcile card, a follow link or a front door link and opens
 * each exactly as Start does. Shelf entries come in a later issue (ADR-0077
 * §1). Nothing here reaches the network until a link opens its own page.
 */
import { messages } from '../app/messages';
import { OpenLink, type OpenLinkWords } from '../app/OpenLink';
import { PageHeader } from '../app/ui';

/** Discover's field: every kind of link the app opens. */
const OPEN_WORDS: OpenLinkWords = {
  heading: messages.discover.openHeading,
  label: messages.discover.openLabel,
  hint: messages.discover.openHint,
  button: messages.discover.open,
  badLink: messages.discover.badLink,
};

/** Props for {@link Discover}: what opens each kind of link, as Start's field has. */
export interface DiscoverProps {
  /** Opens a pasted invite's seed, held in memory. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** Opens a pasted reconcile card's seed (#114), held in memory. */
  readonly onOpenCard: (seed: Uint8Array) => void;
  /** Opens a pasted follow link's seed (#124), held in memory. */
  readonly onOpenFollow: (seed: Uint8Array) => void;
  /** Opens a pasted front door link's page (#121), by the address after `#door/`. */
  readonly onOpenDoor: (payload: string) => void;
}

/** The eyebrow and heading, the empty state's one sentence, and Open a card or link. */
export function Discover(props: DiscoverProps) {
  const words = messages.discover;
  return (
    <main className="shell">
      <PageHeader eyebrow={messages.app.name} title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.empty}</p>
      <OpenLink words={OPEN_WORDS} name="link" primary {...props} />
    </main>
  );
}
