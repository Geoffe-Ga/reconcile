/**
 * Make a link and copy it, with what the link exposes said beside the button
 * (ADR-0053): Copy invite link on Group home (spec §9, #73) and Share a
 * follow link on a coalition's home (#124).
 *
 * Each press makes a new link: the clipboard write starts at the press and
 * waits for the link, so the browser still counts it as the tap's, and the
 * link appears, selectable, only once the relay holds its whole envelope.
 * When making it fails, nothing is copied and the status line says so.
 */
import { useId, useState } from 'react';
import { Button } from 'react-aria-components';

import { Field } from './ui';

/** What a link's button, field and status line say. */
export interface ShareLinkWords {
  /** What anyone who opens the link can read, beside the button. */
  readonly warning: string;
  readonly button: string;
  /** The read-only field's label once the link exists. */
  readonly field: string;
  readonly making: string;
  readonly failed: string;
  readonly copied: string;
  readonly copyFailed: string;
}

/** Props for {@link ShareLink}. */
export interface ShareLinkProps {
  readonly words: ShareLinkWords;
  /** Posts a fresh envelope and resolves to its link; rejects when the relay can't be reached. */
  readonly makeLink: () => Promise<string>;
  /** Puts the link on the clipboard once it resolves; rejects when the browser blocks it. */
  readonly copyText: (text: string | Promise<string>) => Promise<void>;
  /** Whether the button is the screen's one primary action (DESIGN.md). */
  readonly primary?: boolean;
}

/** Where making and copying a link has got to. */
type LinkStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'made'; readonly link: string; readonly copied: boolean };

/** The status line for each step. */
function statusLine(words: ShareLinkWords, status: LinkStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'making':
      return words.making;
    case 'failed':
      return words.failed;
    case 'made':
      return status.copied ? words.copied : words.copyFailed;
  }
}

/** The warning, the button, and once made, the link with how copying went. */
export function ShareLink({ words, makeLink, copyText, primary = true }: ShareLinkProps) {
  const [status, setStatus] = useState<LinkStatus>({ kind: 'idle' });
  const warning = useId();
  const copy = () => {
    if (status.kind === 'making') return;
    setStatus({ kind: 'making' });
    const link = makeLink();
    const copied = copyText(link);
    link.then(
      (made) => {
        copied.then(
          () => {
            setStatus({ kind: 'made', link: made, copied: true });
          },
          () => {
            setStatus({ kind: 'made', link: made, copied: false });
          },
        );
      },
      () => {
        copied.catch(() => undefined);
        setStatus({ kind: 'failed' });
      },
    );
  };
  return (
    <div className="stack">
      <p id={warning} className="lede">
        {words.warning}
      </p>
      <Button
        className={primary ? 'button button-primary' : 'button button-secondary'}
        onPress={copy}
        aria-describedby={warning}
      >
        {words.button}
      </Button>
      <div className="field-status">
        {status.kind === 'made' ? (
          <Field
            label={words.field}
            value={status.link}
            isReadOnly
            inputClassName="input-link"
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        ) : null}
        <p role="status" className="status">
          {statusLine(words, status)}
        </p>
      </div>
    </div>
  );
}
