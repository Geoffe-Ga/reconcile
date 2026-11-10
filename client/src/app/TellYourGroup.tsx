/**
 * Tell your group (#77; ADR-0073: no push): once someone's Proposal or
 * version is on an open ballot, one tap tells the group's chat that a vote is
 * open, without saying what it's about (./share.ts).
 */
import { useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from './messages';
import type { ShareOutcome } from './share';

/** Props for {@link TellYourGroup}. */
export interface TellYourGroupProps {
  /** Shares the fixed line and the app's address, or copies them; says how it went. */
  readonly onTell: () => Promise<ShareOutcome>;
}

const STATUS: Readonly<Record<ShareOutcome | 'idle', string>> = {
  idle: '',
  shared: messages.tell.shared,
  copied: messages.tell.copied,
  blocked: messages.tell.blocked,
};

/**
 * "Tell your group", what it shares in words, and a polite live region,
 * there from the start, that says whether it was shared or copied.
 */
export function TellYourGroup({ onTell }: TellYourGroupProps) {
  const [status, setStatus] = useState<ShareOutcome | 'idle'>('idle');
  const [busy, setBusy] = useState(false);
  const tell = () => {
    setBusy(true);
    setStatus('idle');
    void onTell()
      .catch((): ShareOutcome => 'blocked')
      .then((outcome) => {
        setBusy(false);
        setStatus(outcome);
      });
  };
  return (
    <div className="tell">
      <Button className="button button-secondary" onPress={tell} isDisabled={busy}>
        {messages.tell.action}
      </Button>
      <p className="caption">{messages.tell.hint}</p>
      <p role="status" className="status">
        {STATUS[status]}
      </p>
    </div>
  );
}
