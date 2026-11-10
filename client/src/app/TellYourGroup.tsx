/**
 * Tell your group (#77, #113; ADR-0073: no push; ADR-0074: a ready-made
 * message for each moment): one tap shares a fixed message into the group's
 * own chat, saying a vote is open, closes within a day, or has finished,
 * without saying what it's about (./chatMessages.ts, ./share.ts).
 *
 * The message shows as it will read. "Include the title" adds the Proposal's
 * title for one share only: it starts unticked every time, clears once the
 * share is done, and is never stored. A steward Proposal offers no title,
 * since its title names a member.
 */
import { type PointerEvent, useId, useState } from 'react';
import { Button, CheckboxButton, CheckboxField } from 'react-aria-components';

import {
  type ChatDetails,
  type ChatMoment,
  type ChatSource,
  chatDetails,
  chatMessage,
  shareableTitle,
} from './chatMessages';
import { messages } from './messages';
import type { ShareOutcome } from './share';

/** Props for {@link TellYourGroup}. */
export interface TellYourGroupProps {
  /** Which message it shares. */
  readonly moment: ChatMoment;
  /** The Proposal it's about: its deadline, and the title the box may add. */
  readonly proposal: ChatSource;
  /** Shares the message and the app's address, or copies them; says how it went. */
  readonly onTell: (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;
}

const STATUS: Readonly<Record<ShareOutcome | 'idle', string>> = {
  idle: '',
  shared: messages.tell.shared,
  copied: messages.tell.copied,
  blocked: messages.tell.blocked,
};

/**
 * Keeps a press from starting while a share runs. React Aria's usePress
 * starts one on pointerdown even on a disabled control, and clicks it itself
 * 80 ms after a pointerup with no click, so a second tap on the busy button
 * could share again, or tick the box, once it's enabled (#190, #192).
 */
function holdPresses(busy: boolean) {
  return (event: PointerEvent) => {
    if (busy) event.stopPropagation();
  };
}

/**
 * What Tell your group shares, as it will read, then "Include the title",
 * "Tell your group", and a polite live region, there from the start, that
 * says whether it was shared or copied.
 */
export function TellYourGroup({ moment, proposal, onTell }: TellYourGroupProps) {
  const [status, setStatus] = useState<ShareOutcome | 'idle'>('idle');
  const [busy, setBusy] = useState(false);
  const [includeTitle, setIncludeTitle] = useState(false);
  const message = useId();
  const details = chatDetails(proposal, includeTitle);
  const tell = () => {
    setBusy(true);
    setStatus('idle');
    void onTell(moment, details)
      .catch((): ShareOutcome => 'blocked')
      .then((outcome) => {
        setBusy(false);
        setStatus(outcome);
        setIncludeTitle(false);
      });
  };
  return (
    <div className="tell" onPointerDownCapture={holdPresses(busy)}>
      <p className="caption">{messages.tell.hint}</p>
      <p id={message} className="tell-message">
        {chatMessage(moment, details)}
      </p>
      {shareableTitle(proposal) === null ? null : (
        <CheckboxField isSelected={includeTitle} onChange={setIncludeTitle} isDisabled={busy}>
          <CheckboxButton className="checkbox">
            <span className="checkbox-box" aria-hidden="true" />
            {messages.tell.includeTitle}
          </CheckboxButton>
        </CheckboxField>
      )}
      <Button
        className="button button-secondary"
        onPress={tell}
        isDisabled={busy}
        aria-describedby={message}
      >
        {messages.tell.action}
      </Button>
      <p role="status" className="status">
        {STATUS[status]}
      </p>
    </div>
  );
}
