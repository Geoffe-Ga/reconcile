/**
 * Link to your other device (`#/link-this`; #96), on the new device (B).
 *
 * Start offers it once first run (the install gate and the pilot notice) is
 * through, so no key exists here before then. The person scans the other
 * device's code, or pastes it; only then does this device make its one-time
 * key and post it. It shows the six-digit number with "Check that your other
 * device shows the same number, then confirm there.", and offers only
 * Cancel: there is no way to confirm here. Once the other device sends the
 * groups and they check out, it says how many groups this device now has.
 * Leaving the screen or Cancel drops every secret.
 */
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Link } from 'react-aria-components';

import { LinkNumber } from '../app/LinkNumber';
import { messages } from '../app/messages';
import { QrScanner, type QrScannerProps } from '../app/QrScanner';
import { routeHref } from '../app/router';
import { BackLink, Field, PageHeader } from '../app/ui';
import { usePolling } from '../app/useLink';
import { type LinkCode, parseLinkCode } from '../crypto/link';
import type { JoinStep, LinkJoin } from '../link/session';

/** Props for {@link LinkThisDevice}. */
export interface LinkThisDeviceProps {
  /** Posts this device's one-time key for `code`; rejects when the relay can't be reached. */
  readonly join: (code: LinkCode) => Promise<LinkJoin>;
  /** Runs once the groups are in, so they catch up with the relay. */
  readonly onLinked: () => void;
  /** The scanner's camera and frame reader, which tests hand in. */
  readonly camera?: Pick<QrScannerProps, 'openCamera' | 'readFrame'>;
}

/** Where linking has got to on this device. */
type Phase =
  | { readonly kind: 'entry'; readonly offline: boolean }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'joined'; readonly join: LinkJoin };

/** Whether the poll should look again: while it waits for the other device's key or its groups. */
const lookAgain = (step: JoinStep): boolean => step.kind === 'waiting' || step.kind === 'compare';

/** Whether scanned or pasted text is a linking code. */
const isCode = (text: string): boolean => parseLinkCode(text) !== null;

/** The paste field's check: anything but a linking code says so, without repeating it. */
const checkCode = (text: string): string | null => (isCode(text) ? null : messages.link.notACode);

/** What each step that ends the link says. */
const STOPPED: Readonly<Record<'mismatch' | 'damaged' | 'expired', string>> = {
  mismatch: messages.link.mismatch,
  damaged: messages.link.damaged,
  expired: messages.link.joinExpired,
};

interface EntryProps extends Pick<LinkThisDeviceProps, 'camera'> {
  readonly offline: boolean;
  readonly onCode: (code: LinkCode) => void;
}

/** Scan the code, or paste it. */
function Entry({ offline, onCode, camera }: EntryProps) {
  const take = (text: string) => {
    const code = parseLinkCode(text);
    if (code !== null) onCode(code);
  };
  const paste = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('code');
    if (typeof text === 'string') take(text);
  };
  return (
    <div className="stack">
      <p className="lede">{messages.link.thisLede}</p>
      <QrScanner onCode={take} isCode={isCode} {...camera} />
      <Form className="form" onSubmit={paste}>
        <Field
          name="code"
          label={messages.link.pasteLabel}
          hint={messages.link.pasteHint}
          inputClassName="input-link"
          autoComplete="off"
          isRequired
          validate={checkCode}
        />
        <div>
          <Button type="submit" className="button button-primary">
            {messages.link.pasteSubmit}
          </Button>
        </div>
      </Form>
      {offline ? (
        <p role="alert" className="form-error">
          {messages.link.offline}
        </p>
      ) : null}
    </div>
  );
}

interface JoinedProps {
  readonly join: LinkJoin;
  readonly onLinked: () => void;
  /** Cancel, or Start again: back to scanning or pasting. */
  readonly onRestart: () => void;
}

/** A step that ends the link without groups. */
interface Stopped {
  readonly kind: keyof typeof STOPPED;
}

/** Whether `step` ends the link without groups. */
function isStopped(step: JoinStep | null): step is Stopped {
  return step !== null && step.kind in STOPPED;
}

/**
 * "Linked. This device now has <n> groups.", any group (#336) or personal
 * Document (#351) left out, and the way to them.
 */
function LinkedView({ step }: { readonly step: Extract<JoinStep, { kind: 'linked' }> }) {
  return (
    <div className="stack">
      <p role="status" className="lede">
        {messages.link.linked(step.groups, step.skipped, step.skippedDocuments)}
      </p>
      <div>
        <Link className="button button-primary" href={routeHref({ name: 'start' })}>
          {messages.app.yourGroups}
        </Link>
      </div>
    </div>
  );
}

/** Why the link stopped, and Start again. */
function StoppedView({
  step,
  onRestart,
}: { readonly step: Stopped } & Pick<JoinedProps, 'onRestart'>) {
  return (
    <div className="stack">
      <p role="alert" className="lede">
        {STOPPED[step.kind]}
      </p>
      <div>
        <Button className="button button-primary" onPress={onRestart}>
          {messages.link.startAgain}
        </Button>
      </div>
    </div>
  );
}

/** Waiting for the other device, or its number to check there, with Cancel. */
function WaitingView({
  number,
  unreachable,
  onRestart,
}: { readonly number: string | null; readonly unreachable: boolean } & Pick<
  JoinedProps,
  'onRestart'
>) {
  return (
    <div className="stack">
      {number === null ? (
        <p role="status" className="lede">
          {messages.link.waitingOther}
        </p>
      ) : (
        <LinkNumber number={number} prompt={messages.link.check} />
      )}
      {unreachable ? <p className="caption">{messages.link.unreachable}</p> : null}
      <div>
        <Button className="button button-secondary" onPress={onRestart}>
          {messages.link.cancel}
        </Button>
      </div>
    </div>
  );
}

/** Waiting, then the number with Cancel, then how it ended. */
function Joined({ join, onLinked, onRestart }: JoinedProps) {
  const { step, unreachable } = usePolling(join.poll, lookAgain);
  const linked = step?.kind === 'linked';
  useEffect(() => {
    if (linked) onLinked();
  }, [linked, onLinked]);

  if (step?.kind === 'linked') return <LinkedView step={step} />;
  if (isStopped(step)) return <StoppedView step={step} onRestart={onRestart} />;
  const number = step?.kind === 'compare' ? step.number : null;
  return <WaitingView number={number} unreachable={unreachable} onRestart={onRestart} />;
}

/** Link to your other device: scan or paste its code, check the number, and wait. */
export function LinkThisDevice({ join, onLinked, camera }: LinkThisDeviceProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'entry', offline: false });
  const mounted = useRef(false);
  const held = phase.kind === 'joined' ? phase.join : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The link on the go is dropped when it's replaced, cancelled, or the screen closes.
  useEffect(() => {
    if (held === null) return;
    return () => {
      held.drop();
    };
  }, [held]);

  const open = (code: LinkCode) => {
    setPhase({ kind: 'connecting' });
    join(code).then(
      (joined) => {
        if (mounted.current) setPhase({ kind: 'joined', join: joined });
        else joined.drop();
      },
      () => {
        if (mounted.current) setPhase({ kind: 'entry', offline: true });
      },
    );
  };
  const restart = () => {
    setPhase({ kind: 'entry', offline: false });
  };

  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.link.thisTitle} pageTitle={messages.link.thisPageTitle} />
      {phase.kind === 'entry' ? (
        <Entry
          offline={phase.offline}
          onCode={open}
          {...(camera === undefined ? {} : { camera })}
        />
      ) : null}
      {phase.kind === 'connecting' ? (
        <p role="status" className="lede">
          {messages.link.connecting}
        </p>
      ) : null}
      {phase.kind === 'joined' ? (
        <Joined join={phase.join} onLinked={onLinked} onRestart={restart} />
      ) : null}
    </main>
  );
}
