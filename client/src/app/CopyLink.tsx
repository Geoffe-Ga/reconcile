import { useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from './messages';
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
}

type CopyStatus = 'idle' | 'copied' | 'blocked';

const COPY_STATUS: Readonly<Record<CopyStatus, string>> = {
  idle: '',
  copied: messages.install.copied,
  blocked: messages.home.copyFailed,
};

/**
 * A link as selectable text, in a read-only field that selects all of it on
 * focus, with a Copy button and a status line that says how copying went.
 */
export function CopyLink({ link, label, hint, button, primary, copyText }: CopyLinkProps) {
  const [status, setStatus] = useState<CopyStatus>('idle');
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
      <div className="field-status">
        <Button
          className={primary ? 'button button-primary' : 'button button-secondary'}
          onPress={copy}
        >
          {button}
        </Button>
        <p role="status" className="status">
          {COPY_STATUS[status]}
        </p>
      </div>
    </div>
  );
}
