/**
 * Link a new device (`#/link-new`; #96), on the existing device (A).
 *
 * Opening it first checks that this session holds the unlocked keys
 * (`Store.requireUnlocked`, #95), as Save a backup does: on a device whose
 * keys are locked with a passkey it makes no code and says to unlock first.
 * Then it makes a fresh code, shown as a QR code with the same text and
 * Copy the code beside it, for a laptop with no camera. It looks at the relay
 * every 2 seconds for the new device's key; once that arrives, it shows the
 * six-digit number and asks "Does your new device show the same number?",
 * with Match and Don't match. Only Match sends anything under the link's
 * key, and closing the screen, Don't match, the 10 minutes running out or a
 * failed send each drop every secret. Make a new code starts again.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Link } from 'react-aria-components';

import { LinkNumber } from '../app/LinkNumber';
import { messages } from '../app/messages';
import { QrCode } from '../app/QrCode';
import { routeHref } from '../app/router';
import { BackLink, PageHeader } from '../app/ui';
import { useHeld, usePolling } from '../app/useLink';
import type { LinkOffer, OfferStep } from '../link/session';

/** Props for {@link LinkNewDevice}. */
export interface LinkNewDeviceProps {
  /**
   * Resolves once this session may hand the device's keys on, and rejects
   * while they're locked with a passkey (`Store.requireUnlocked`, #95).
   */
  readonly ready: () => Promise<void>;
  /** Starts a link: a fresh seed, key and code, with nothing sent yet. */
  readonly start: () => LinkOffer;
  /** Puts the code's text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
}

/** How a round ended, once it has. */
type Ended = 'sending' | 'sent' | 'not-sent' | 'expired' | 'failed';

/** Whether the poll should look again: while it waits for the new device, or for the person. */
const lookAgain = (step: OfferStep): boolean => step.kind === 'waiting' || step.kind === 'compare';

/** The code, with Copy the code and a line that says how copying went. */
function ShowCode({
  offer,
  copyText,
}: { readonly offer: LinkOffer } & Pick<LinkNewDeviceProps, 'copyText'>) {
  const [copied, setCopied] = useState<string>('');
  const copy = () => {
    copyText(offer.code).then(
      () => {
        setCopied(messages.link.copied);
      },
      () => {
        setCopied(messages.link.copyFailed);
      },
    );
  };
  return (
    <div className="stack">
      <p className="lede">{messages.link.newLede}</p>
      <QrCode text={offer.code} />
      <div className="field-status">
        <Button className="button button-secondary" onPress={copy}>
          {messages.link.copy}
        </Button>
        <p role="status" className="status">
          {copied}
        </p>
      </div>
      <p className="caption">{messages.link.lasts}</p>
      <p role="status" className="status">
        {messages.link.waitingNew}
      </p>
    </div>
  );
}

/** The number, the question, and Match and Don't match. */
function Compare({
  number,
  onMatch,
  onNoMatch,
}: {
  readonly number: string;
  readonly onMatch: () => void;
  readonly onNoMatch: () => void;
}) {
  return (
    <div className="stack">
      <LinkNumber number={number} prompt={messages.link.compare} />
      <div className="link-actions">
        <Button className="button button-primary" onPress={onMatch}>
          {messages.link.match}
        </Button>
        <Button className="button button-secondary" onPress={onNoMatch}>
          {messages.link.noMatch}
        </Button>
      </div>
    </div>
  );
}

/** What each ending says. */
const ENDED: Readonly<Record<Exclude<Ended, 'sending'>, string>> = {
  sent: messages.link.sent,
  'not-sent': messages.link.notSent,
  expired: messages.link.expired,
  failed: messages.link.sendFailed,
};

/** A round that ended: what happened, and Make a new code, or a way back once sent. */
function EndedView({
  ended,
  onAgain,
}: {
  readonly ended: Exclude<Ended, 'sending'>;
  readonly onAgain: () => void;
}) {
  return (
    <div className="stack">
      <p role="status" className="lede">
        {ENDED[ended]}
      </p>
      <div>
        {ended === 'sent' ? (
          <Link className="button button-primary" href={routeHref({ name: 'start' })}>
            {messages.app.yourGroups}
          </Link>
        ) : (
          <Button className="button button-primary" onPress={onAgain}>
            {messages.link.again}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Whether this session may hand the keys on: unknown until `ready` answers. */
type Readiness = 'checking' | 'open' | 'locked';

/** What `ready` answered, once it has; it asks once for each `ready`. */
function useReadiness(ready: () => Promise<void>): Readiness {
  const [readiness, setReadiness] = useState<Readiness>('checking');
  useEffect(() => {
    let live = true;
    ready().then(
      () => {
        if (live) setReadiness('open');
      },
      () => {
        if (live) setReadiness('locked');
      },
    );
    return () => {
      live = false;
    };
  }, [ready]);
  return readiness;
}

/** One code's round, from showing it to how it ended. Remounted for each new code. */
function Round({
  start,
  copyText,
  onAgain,
}: Omit<LinkNewDeviceProps, 'ready'> & { readonly onAgain: () => void }) {
  const offer = useHeld(start);
  const [ended, setEnded] = useState<Ended | null>(null);
  const { step } = usePolling(ended === null && offer !== null ? offer.poll : null, lookAgain);
  if (offer === null) return null;

  const match = () => {
    setEnded('sending');
    offer.confirm().then(
      (sent) => {
        setEnded(sent === 'sent' ? 'sent' : 'expired');
      },
      () => {
        setEnded('failed');
      },
    );
  };
  const noMatch = () => {
    offer.drop();
    setEnded('not-sent');
  };

  if (ended === 'sending') {
    return (
      <p role="status" className="lede">
        {messages.link.sending}
      </p>
    );
  }
  if (ended !== null) return <EndedView ended={ended} onAgain={onAgain} />;
  if (step?.kind === 'expired') return <EndedView ended="expired" onAgain={onAgain} />;
  if (step?.kind === 'compare') {
    return <Compare number={step.number} onMatch={match} onNoMatch={noMatch} />;
  }
  return <ShowCode offer={offer} copyText={copyText} />;
}

/**
 * Link a new device: once the keys are unlocked, the code, then the number
 * to check, then Match.
 */
export function LinkNewDevice({ ready, start, copyText }: LinkNewDeviceProps) {
  const [round, setRound] = useState(0);
  const readiness = useReadiness(ready);
  const again = useCallback(() => {
    setRound((now) => now + 1);
  }, []);
  return (
    <main className="shell">
      <BackLink to={{ name: 'settings' }} label={messages.link.backToSettings} />
      <PageHeader title={messages.link.newTitle} pageTitle={messages.link.newPageTitle} />
      {readiness === 'open' ? (
        <Round key={round} start={start} copyText={copyText} onAgain={again} />
      ) : null}
      {readiness === 'locked' ? (
        <p role="alert" className="lede">
          {messages.link.locked}
        </p>
      ) : null}
    </main>
  );
}
