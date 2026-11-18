/**
 * The steward's console (`#/steward`; #488; docs/spec/listed-doors.md §6.4).
 *
 * It exists only on a device that holds the steward's key, and in this slice
 * lists one thing: the listings waiting for release, each with the one thing
 * a reader will see of it (its name, and whether it accepted this app's
 * covenant) and, when a live listing holds a name like it, that listing
 * beside it, since a release would put it behind that one, unseen (rule 4).
 * Release signs a `release` notice and PUTs it. Reports, flagged entries,
 * standing holds and the other four notices come with #489.
 */
import { useState } from 'react';
import { Button } from 'react-aria-components';

import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import { formatDate } from '../app/time';
import { BackLink, PageHeader, Section } from '../app/ui';
import { COVENANT_HASH } from '../shelf/covenant';
import type { WaitingListing } from '../shelf/fold';

/** What the console shows: the waiting listings, or why there are none to show. */
export type StewardQueue = readonly WaitingListing[] | 'unavailable' | 'failed';

/** Props for {@link Steward}. */
export interface StewardProps {
  /** The listings waiting for release, or that the shelf is off or couldn't be read. */
  readonly queue: StewardQueue;
  /** Signs and PUTs a release of `address`; true once the relay has it. */
  readonly onRelease: (address: string) => Promise<boolean>;
}

/** Where one listing's release stands. */
type Releasing = 'idle' | 'busy' | 'released' | 'failed';

/** One waiting listing: what readers will see, any look-alike, and Release. */
function WaitingCard(props: {
  readonly waiting: WaitingListing;
  readonly onRelease: StewardProps['onRelease'];
}) {
  const words = messages.shelfSteward;
  const { listing, holder } = props.waiting;
  const [state, setState] = useState<Releasing>('idle');
  const busy = state === 'busy';
  const release = () => {
    setState('busy');
    void props
      .onRelease(listing.address)
      .catch(() => false)
      .then((done) => {
        setState(done ? 'released' : 'failed');
      });
  };
  return (
    <li className="card stack steward-waiting">
      <h3 className="heading-3">
        <bdi>{listing.name}</bdi>
      </h3>
      <p className="meta">
        {listing.covenant === COVENANT_HASH ? words.covenantCurrent : words.covenantOther}
      </p>
      <p className="meta">{words.waitingSince(formatDate(listing.received))}</p>
      {holder === null ? null : (
        <div className="notice">
          <p>
            {words.lookalike} <bdi>{holder.name}</bdi>
          </p>
          <p>{words.lookalikeHint}</p>
        </div>
      )}
      <p className="caption">{words.willSee(listing.name)}</p>
      {state === 'released' ? null : (
        <div onPointerDownCapture={holdPresses(busy)}>
          <Button className="button button-primary" isDisabled={busy} onPress={release}>
            {busy ? words.releasing : words.release}
          </Button>
        </div>
      )}
      <p className="status" role="status">
        {state === 'released' ? words.released : null}
        {state === 'failed' ? words.releaseFailed : null}
      </p>
    </li>
  );
}

/** The queue: its listings, or one line saying why it has none. */
function Queue({ queue, onRelease }: StewardProps) {
  const words = messages.shelfSteward;
  if (queue === 'unavailable') return <p className="lede">{words.unavailable}</p>;
  if (queue === 'failed') return <p className="lede">{words.readFailed}</p>;
  if (queue.length === 0) return <p className="lede">{words.none}</p>;
  return (
    <ul className="stack steward-queue">
      {queue.map((waiting) => (
        <WaitingCard key={waiting.listing.address} waiting={waiting} onRelease={onRelease} />
      ))}
    </ul>
  );
}

/** The steward's console: the listings waiting for release. */
export function Steward(props: StewardProps) {
  const words = messages.shelfSteward;
  return (
    <main className="shell">
      <BackLink to={{ name: 'settings' }} label={messages.settings.title} />
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.consoleLede}</p>
      <div className="sections">
        <Section title={words.waitingHeading}>
          <Queue {...props} />
        </Section>
      </div>
    </main>
  );
}
