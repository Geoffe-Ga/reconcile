/**
 * One entry on the public shelf, on its own page (`#/discover/{address}/{id}`;
 * #431, listed-doors.md §5.2): the link an entry's Share and Copy pass along.
 *
 * Whoever opens it, a device in no group included once past the pilot
 * notice, reads the entry as Discover shows it, from the same whole read of
 * the shelf every device makes, so opening a link tells the relay nothing
 * about which entry was opened. Then the link, with Copy and Share. While the
 * shelf doesn't show the entry (it came down, its 30 days ended, or the relay
 * has no shelf) one line says so instead. Nothing records which entry was
 * opened.
 *
 * Under the entry, Ask to join opens the listing's front door (#432), and
 * Propose reconciling opens it too on a device with a group that may propose
 * reconciling with it (#426's rule), where the door's own button starts the
 * card. A door the shelf says is newly listed or held takes no personal
 * Documents there (§5.3).
 *
 * Under the link, a quiet Report this entry (#490, §6.3) sends the steward
 * a clause and an optional note about it, only where the app pins a steward
 * to send it to. It hides nothing here or on any other device.
 */
import { Link } from 'react-aria-components';

import { CopyLink } from '../app/CopyLink';
import { ReportDialog, type SendOutcome } from '../app/StewardDialogs';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import type { SharePort } from '../app/share';
import { ShelfCard } from '../app/ShelfCard';
import { PageHeader } from '../app/ui';
import type { ShelfEntry as Entry } from '../shelf/fold';
import type { Clause } from '../shelf/record';

/** Props for {@link ShelfEntry}. */
export interface ShelfEntryProps {
  /** The entry as the shelf shows it, or null when it doesn't. */
  readonly entry: Entry | null;
  /** The entry's link: the app's origin, then its route. */
  readonly link: string;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /** Where Share sends the link; without one, Copy stands alone. */
  readonly sharing?: SharePort | undefined;
  /** Whether this device has a group that may propose reconciling with the listing's group (#426). */
  readonly mayReconcile: boolean;
  /** Sends a report of this entry to the steward (#490); without one, there's no steward to send to. */
  readonly onReport?: ((clause: Clause, note: string) => Promise<SendOutcome>) | undefined;
}

/** Ask to join, and Propose reconciling where `mayReconcile`: each opens the door at `address`. */
function DoorActions({ address, mayReconcile }: { address: string; mayReconcile: boolean }) {
  const words = messages.shelfEntry;
  const href = routeHref({ name: 'door', payload: address });
  return (
    <div className="row">
      <Link className="button button-secondary" href={href}>
        {words.askToJoin}
      </Link>
      {mayReconcile ? (
        <Link className="button button-secondary" href={href}>
          {words.proposeReconciling}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * The entry, with Ask to join and maybe Propose reconciling, its link with
 * Copy and Share, and Report this entry where there's a steward; or the line
 * that it isn't on the shelf.
 */
export function ShelfEntry(props: ShelfEntryProps) {
  const { entry, link, copyText, sharing, mayReconcile, onReport } = props;
  const words = messages.shelfEntry;
  return (
    <main className="shell" data-scene="treetops">
      <PageHeader eyebrow={messages.app.name} title={words.pageTitle} pageTitle={words.pageTitle} />
      {entry === null ? (
        <p className="lede">{words.gone}</p>
      ) : (
        <>
          <ShelfCard entry={entry} level={2}>
            <DoorActions address={entry.address} mayReconcile={mayReconcile} />
          </ShelfCard>
          <CopyLink
            link={link}
            label={words.linkLabel}
            hint={words.linkHint}
            button={words.copy}
            primary
            copyText={copyText}
            {...(sharing === undefined ? {} : { sharing })}
          />
          {onReport === undefined ? null : <ReportDialog onReport={onReport} />}
        </>
      )}
      <p>
        <Link href={routeHref({ name: 'discover' })}>{words.toDiscover}</Link>
      </p>
    </main>
  );
}
