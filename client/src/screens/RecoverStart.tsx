/**
 * Recover with your contacts (`#/recover`; #118), on the new device.
 *
 * Start offers it once first run is through, so nothing makes a key before
 * the pilot notice. Opening it keeps a request (a seed and a key) or takes
 * up the one already kept, and shows its code as selectable text, with Share
 * the code, which goes through the share sheet or the clipboard
 * (`shareOrCopy`), and beside it two six-digit numbers to read out on the
 * call: the check, from the code, and the second number, which only this
 * device shows (#398). It then reads the request mailbox every 2 seconds
 * while the screen is open, says how many shares have come, and how many
 * came with a different second number and were left out.
 *
 * Once a backup opens, nothing is restored until the person answers "Are
 * these your groups?" (#398), with each group's name in `<bdi>`: the
 * question takes the code's place, so Yes is the one primary action. Yes
 * restores them and hands over to the app, which asks the person to choose
 * their contacts again. No restores nothing, keeps the request, says what
 * to do next, and keeps waiting. Stop recovering forgets the code.
 */
import { useEffect, useId, useState } from 'react';
import { Button } from 'react-aria-components';

import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import type { ShareOutcome } from '../app/share';
import { BackLink, Field, PageHeader } from '../app/ui';
import { usePolling } from '../app/useLink';
import type { RecoverStep, ShownRequest } from '../recovery/request';

/** Props for {@link RecoverStart}. */
export interface RecoverStartProps {
  /** Keeps a request, or takes up the one kept: its code and check. */
  readonly start: () => Promise<ShownRequest>;
  /** Reads the request mailbox once, and finds a backup once t shares open one. */
  readonly poll: () => Promise<RecoverStep>;
  /** Yes, these are my groups (#398): restores the backup found. */
  readonly confirm: () => Promise<RecoverStep>;
  /** No, they aren't (#398): forgets the backup found, and keeps the request. */
  readonly decline: () => void;
  /** Shares the code through the share sheet, or copies it. */
  readonly onShare: (code: string) => Promise<ShareOutcome>;
  /** Runs once the groups are back. */
  readonly onRestored: () => void;
  /** Stop recovering: forgets the code. */
  readonly onStop: () => Promise<void>;
}

/**
 * Whether to look again: while the shares are still on their way, and while
 * a backup waits for an answer, which a look answers without the relay, so
 * a stop from another tab still shows.
 */
const lookAgain = (step: RecoverStep): boolean => step.kind === 'waiting' || step.kind === 'found';

/** What each way a share went says. */
const SHARED: Readonly<Record<ShareOutcome, string>> = {
  shared: messages.recover.shared,
  copied: messages.recover.copied,
  blocked: messages.recover.blocked,
};

/** The code, selectable, with Share the code and a line saying how sharing went. */
function ShareCode({
  code,
  onShare,
}: { readonly code: string } & Pick<RecoverStartProps, 'onShare'>) {
  const [shared, setShared] = useState('');
  const share = () => {
    onShare(code).then(
      (outcome) => {
        setShared(SHARED[outcome]);
      },
      () => {
        setShared(messages.recover.blocked);
      },
    );
  };
  return (
    <div className="stack">
      <Field
        label={messages.recover.codeLabel}
        hint={messages.recover.codeHint}
        value={code}
        isReadOnly
        inputClassName="input-link"
        onFocus={(event) => {
          event.currentTarget.select();
        }}
      />
      <div className="field-status">
        <Button className="button button-primary" onPress={share}>
          {messages.recover.share}
        </Button>
        <p role="status" className="status">
          {shared}
        </p>
      </div>
    </div>
  );
}

/** How the wait stands: waiting, or how many of a split's shares have come. */
function waitLine(step: RecoverStep | null): string {
  if (step?.kind !== 'waiting' || step.needed === null) return messages.recover.waiting;
  return messages.recover.arrived(step.shares, step.needed);
}

/**
 * The two numbers to read out (#398), in the linking number's card: what to
 * do, then the check and the second number, each named, then why the second
 * one matters.
 */
function Numbers({ shown }: { readonly shown: ShownRequest }) {
  const words = messages.recover;
  return (
    <div role="status" className="link-number-card">
      <p className="heading-3">{words.check}</p>
      <dl className="recover-numbers">
        <div>
          <dt className="eyebrow">{words.firstNumber}</dt>
          <dd className="link-number">{messages.link.number(shown.check)}</dd>
        </div>
        <div>
          <dt className="eyebrow">{words.secondNumber}</dt>
          <dd className="link-number">{messages.link.number(shown.number)}</dd>
        </div>
      </dl>
      <p className="caption">{words.numbersNote}</p>
    </div>
  );
}

/** The wait, how many shares have come, and any left out for another second number. */
function Wait({
  step,
  unreachable,
}: {
  readonly step: RecoverStep | null;
  readonly unreachable: boolean;
}) {
  const mismatched = step?.kind === 'waiting' ? step.mismatched : 0;
  return (
    <div className="stack">
      <p className="caption recover-wait">{messages.recover.wait}</p>
      <div role="status" className="stack recover-status">
        <p className="lede">{waitLine(step)}</p>
        {mismatched === 0 ? null : (
          <p className="caption recover-wait">{messages.recover.mismatched(mismatched)}</p>
        )}
      </div>
      {unreachable ? <p className="caption">{messages.recover.unreachable}</p> : null}
    </div>
  );
}

/**
 * "Are these your groups?" (#398): the names of the groups a backup holds,
 * each in `<bdi>`, then Yes (primary) and No (secondary). Yes goes once
 * while it restores, and says so if it couldn't.
 */
function Question({
  groups,
  confirm,
  onAnswered,
  onNo,
}: {
  readonly groups: readonly string[];
  readonly confirm: RecoverStartProps['confirm'];
  /** After Yes, with what restoring answered. */
  readonly onAnswered: (step: RecoverStep) => void;
  readonly onNo: () => void;
}) {
  const words = messages.recover;
  const heading = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const yes = () => {
    setBusy(true);
    setFailed(false);
    confirm().then(onAnswered, () => {
      setBusy(false);
      setFailed(true);
    });
  };
  return (
    <section className="stack recover-question" aria-labelledby={heading}>
      <h2 id={heading} className="heading-2">
        {words.foundHeading}
      </h2>
      <p className="lede">{words.foundLede}</p>
      {groups.length === 0 ? (
        <p className="recover-found-none">{words.foundNone}</p>
      ) : (
        <ul className="recover-found">
          {groups.map((name, at) => (
            // Two groups can share a name, so each line is keyed by its place in the backup.
            <li key={at}>
              <bdi>{name}</bdi>
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <p role="alert" className="form-error">
          {words.restoreFailed}
        </p>
      ) : null}
      <div className="field-status">
        <div className="row form-actions" onPointerDownCapture={holdPresses(busy)}>
          <Button className="button button-primary" isDisabled={busy} onPress={yes}>
            {words.yes}
          </Button>
          <Button className="button button-secondary" isDisabled={busy} onPress={onNo}>
            {words.no}
          </Button>
        </div>
        <p role="status" className="status">
          {busy ? words.restoring : ''}
        </p>
      </div>
    </section>
  );
}

/**
 * The code, the numbers and the wait, polled until a backup opens; then the
 * question in their place until the person answers it.
 */
function Recovering({
  shown,
  poll,
  confirm,
  decline,
  onShare,
  onRestored,
}: { readonly shown: ShownRequest } & Pick<
  RecoverStartProps,
  'poll' | 'confirm' | 'decline' | 'onShare' | 'onRestored'
>) {
  const { step, unreachable } = usePolling(poll, lookAgain);
  // The found step the person answered: a later look's answer is a new one.
  const [answered, setAnswered] = useState<RecoverStep | null>(null);
  const [declined, setDeclined] = useState(false);
  const [restored, setRestored] = useState(false);
  const back = restored || step?.kind === 'restored';
  useEffect(() => {
    if (back) onRestored();
  }, [back, onRestored]);
  if (step?.kind === 'found' && step !== answered) {
    return (
      <Question
        groups={step.groups}
        confirm={confirm}
        onAnswered={(next) => {
          if (next.kind === 'restored') setRestored(true);
          else setAnswered(step);
        }}
        onNo={() => {
          decline();
          setAnswered(step);
          setDeclined(true);
        }}
      />
    );
  }
  return (
    <>
      {declined ? (
        <p role="status" className="notice recover-declined">
          {messages.recover.declined}
        </p>
      ) : null}
      <ShareCode code={shown.code} onShare={onShare} />
      <Numbers shown={shown} />
      <Wait step={step} unreachable={unreachable} />
    </>
  );
}

/** The request this screen shows, once `start` has kept or found it. */
function useShown(start: RecoverStartProps['start']): ShownRequest | null {
  const [shown, setShown] = useState<ShownRequest | null>(null);
  useEffect(() => {
    let live = true;
    void start().then((kept) => {
      if (live) setShown(kept);
    });
    return () => {
      live = false;
    };
  }, [start]);
  return shown;
}

/** Recover with your contacts: the code, the numbers, the wait, and the question. */
export function RecoverStart({
  start,
  poll,
  confirm,
  decline,
  onShare,
  onRestored,
  onStop,
}: RecoverStartProps) {
  const shown = useShown(start);
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.recover.title} pageTitle={messages.recover.pageTitle} />
      <p className="lede">{messages.recover.lede}</p>
      {shown === null ? null : (
        <>
          <Recovering
            shown={shown}
            poll={poll}
            confirm={confirm}
            decline={decline}
            onShare={onShare}
            onRestored={onRestored}
          />
          <div className="stack">
            <div>
              <Button
                className="button button-secondary"
                onPress={() => {
                  void onStop();
                }}
              >
                {messages.recover.stop}
              </Button>
            </div>
            <p className="caption">{messages.recover.stopNote}</p>
          </div>
        </>
      )}
    </main>
  );
}
