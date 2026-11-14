import { useId, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from './messages';
import { type LinkShareOutcome, type SharePort, shareLink } from './share';
import { Field } from './ui';

/** Props for {@link CopyLink}. */
export interface CopyLinkProps {
  /** The link to show and copy. */
  readonly link: string;
  /** The field's label. */
  readonly label: string;
  /** What to do with the link, under the label. */
  readonly hint: string;
  /** The Copy button's words. */
  readonly button: string;
  /** Whether Copy is the screen's one primary action. */
  readonly primary: boolean;
  /** Puts text on the clipboard; rejects when the browser blocks it. */
  readonly copyText: (text: string) => Promise<void>;
  /**
   * Where Share sends the link (#424): given, Share sits beside Copy and hands
   * the share sheet the link alone, or copies it where there's no sheet.
   * Without it, Copy stands alone, as for the app's address.
   */
  readonly sharing?: SharePort;
}

type CopyStatus = 'idle' | 'copied' | 'blocked' | 'shared';

const COPY_STATUS: Readonly<Record<CopyStatus, string>> = {
  idle: '',
  copied: messages.install.copied,
  blocked: messages.home.copyFailed,
  shared: messages.linkShare.shared,
};

/** The status line after Share: as Copy's when it copied, and nothing when the sheet was closed. */
const AFTER_SHARE: Readonly<Record<LinkShareOutcome, CopyStatus>> = {
  shared: 'shared',
  copied: 'copied',
  blocked: 'blocked',
  cancelled: 'idle',
};

/**
 * A link as selectable text, in a read-only field that selects all of it on
 * focus, with a Copy button and a status line that says how copying went.
 * Given a share port, Share (secondary) sits beside Copy, with one line by it
 * on who else can read a link sent through a chat app (#424). Share opens one
 * sheet at a time; a press while one is open does nothing.
 */
export function CopyLink(props: CopyLinkProps) {
  const { link, label, hint, button, primary, copyText, sharing } = props;
  const [status, setStatus] = useState<CopyStatus>('idle');
  const note = useId();
  const sheetOpen = useRef(false);
  const copy = () => {
    copyText(link).then(
      () => {
        setStatus('copied');
      },
      () => {
        setStatus('blocked');
      },
    );
  };
  const share = ({ share: via }: SharePort) => {
    if (sheetOpen.current) return;
    sheetOpen.current = true;
    void shareLink(link, { share: via, copyText }).then((went) => {
      sheetOpen.current = false;
      setStatus(AFTER_SHARE[went]);
    });
  };
  const copyButton = (
    <Button
      className={primary ? 'button button-primary' : 'button button-secondary'}
      onPress={copy}
    >
      {button}
    </Button>
  );
  return (
    <div className="stack">
      <Field
        label={label}
        hint={hint}
        value={link}
        isReadOnly
        inputClassName="input-link"
        onFocus={(event) => {
          event.currentTarget.select();
        }}
      />
      {sharing === undefined ? null : <p id={note}>{messages.linkShare.chatNote}</p>}
      <div className="field-status">
        {sharing === undefined ? (
          copyButton
        ) : (
          <div className="row">
            {copyButton}
            <Button
              className="button button-secondary"
              onPress={() => {
                share(sharing);
              }}
              aria-describedby={note}
            >
              {messages.linkShare.button}
            </Button>
          </div>
        )}
        <p role="status" className="status">
          {COPY_STATUS[status]}
        </p>
      </div>
    </div>
  );
}
