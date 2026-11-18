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
 *
 * Beside it, Copy link to this vote (#472, ADR-0079 §4) copies the vote's
 * link, which only the group's devices can open.
 */
import { useId, useState } from 'react';
import { Button, CheckboxButton, CheckboxField } from 'react-aria-components';

import {
  type ChatDetails,
  type ChatMoment,
  type ChatSource,
  chatDetails,
  chatMessage,
  shareableTitle,
} from './chatMessages';
import { CopyLink } from './CopyLink';
import { holdPresses } from './holdPresses';
import { messages } from './messages';
import type { ShareOutcome } from './share';

/** Props for {@link TellYourGroup}. */
export interface TellYourGroupProps {
  /** Which message it shares. */
  readonly moment: ChatMoment;
  /** The Proposal it's about: its deadline, and the title the box may add. */
  readonly proposal: ChatSource;
  /** Shares the message and the vote's link, or copies them; says how it went. */
  readonly onTell: (moment: ChatMoment, details: ChatDetails) => Promise<ShareOutcome>;
  /** The vote's link and the clipboard, for Copy link to this vote (#472); without it, none shows. */
  readonly voteLink?: VoteLinkPort;
}

/** A vote's link (#472), and how to copy it. */
export interface VoteLinkPort {
  readonly link: string;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
}

const STATUS: Readonly<Record<ShareOutcome | 'idle', string>> = {
  idle: '',
  shared: messages.tell.shared,
  copied: messages.tell.copied,
  blocked: messages.tell.blocked,
};

/**
 * What Tell your group shares, as it will read, then "Include the title",
 * "Tell your group", a polite live region, there from the start, that says
 * whether it was shared or copied, and Copy link to this vote when there's a link.
 */
export function TellYourGroup({ moment, proposal, onTell, voteLink }: TellYourGroupProps) {
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
      {voteLink === undefined ? null : (
        <CopyLink
          link={voteLink.link}
          label={messages.vote.copyLabel}
          hint={messages.vote.copyHint}
          button={messages.vote.copy}
          primary={false}
          copyText={voteLink.copyText}
        />
      )}
    </div>
  );
}
