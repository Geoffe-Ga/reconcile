/**
 * Recover with your contacts (`#/recover`; #118), on the new device.
 *
 * Start offers it once first run is through, so nothing makes a key before
 * the pilot notice. Opening it keeps a request (a seed and a key) or takes
 * up the one already kept, and shows its code as selectable text, with Share
 * the code, which goes through the share sheet or the clipboard
 * (`shareOrCopy`), and beside it the six-digit check with the issue's words:
 * "Send this code to your recovery contacts, then call them and read them
 * this number." It then reads the request mailbox every 2 seconds while the
 * screen is open, says how many shares have come, and once a backup opens
 * hands over to the app, which asks the person to choose their contacts
 * again. Stop recovering forgets the code.
 */
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';

import { LinkNumber } from '../app/LinkNumber';
import { messages } from '../app/messages';
import type { ShareOutcome } from '../app/share';
import { BackLink, Field, PageHeader } from '../app/ui';
import { usePolling } from '../app/useLink';
import type { RecoverStep, ShownRequest } from '../recovery/request';

/** Props for {@link RecoverStart}. */
export interface RecoverStartProps {
  /** Keeps a request, or takes up the one kept: its code and check. */
  readonly start: () => Promise<ShownRequest>;
  /** Reads the request mailbox once, and restores the groups once t shares open a backup. */
  readonly poll: () => Promise<RecoverStep>;
  /** Shares the code through the share sheet, or copies it. */
  readonly onShare: (code: string) => Promise<ShareOutcome>;
  /** Runs once the groups are back. */
  readonly onRestored: () => void;
  /** Stop recovering: forgets the code. */
  readonly onStop: () => Promise<void>;
}

/** Whether to read the mailbox again: while the shares are still on their way. */
const lookAgain = (step: RecoverStep): boolean => step.kind === 'waiting';

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

/** The check, what to do with it, and the wait, polled until the groups are back. */
function Waiting({
  shown,
  poll,
  onRestored,
}: { readonly shown: ShownRequest } & Pick<RecoverStartProps, 'poll' | 'onRestored'>) {
  const { step, unreachable } = usePolling(poll, lookAgain);
  const restored = step?.kind === 'restored';
  useEffect(() => {
    if (restored) onRestored();
  }, [restored, onRestored]);
  return (
    <div className="stack">
      <LinkNumber number={shown.check} prompt={messages.recover.check} />
      <p className="caption recover-wait">{messages.recover.wait}</p>
      <p role="status" className="lede">
        {waitLine(step)}
      </p>
      {unreachable ? <p className="caption">{messages.recover.unreachable}</p> : null}
    </div>
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

/** Recover with your contacts: the code, the number, and the wait. */
export function RecoverStart({ start, poll, onShare, onRestored, onStop }: RecoverStartProps) {
  const shown = useShown(start);
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.recover.title} pageTitle={messages.recover.pageTitle} />
      <p className="lede">{messages.recover.lede}</p>
      {shown === null ? null : (
        <>
          <ShareCode code={shown.code} onShare={onShare} />
          <Waiting shown={shown} poll={poll} onRestored={onRestored} />
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
