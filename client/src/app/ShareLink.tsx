/**
 * Make a link and copy it, with what the link exposes said beside the button
 * (ADR-0053): Copy invite link on Group home (spec §9, #73) and Share a
 * follow link on a coalition's home (#124).
 *
 * Each press makes a new link: the clipboard write starts at the press and
 * waits for the link, so the browser still counts it as the tap's, and the
 * link appears, selectable, only once the relay holds its whole envelope.
 * When making it fails, nothing is copied and the status line says so.
 *
 * Given a share port (#424; ADR-0077 §6), Share (secondary) sits beside the
 * button, with one line by it on who else can read a link sent through a chat
 * app. It hands the share sheet the link alone: the one on show, at once, or
 * else a new one, made at the press and shared as soon as it's ready, from the
 * same press. With no share sheet it copies, as the button does, the write
 * started at the press. Closing the sheet says nothing.
 */
import { useId, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import { messages } from './messages';
import { type LinkShareOutcome, type SharePort, shareLink } from './share';
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
  /** Where Share sends the link (#424); without it, the button stands alone, as for an invite link. */
  readonly sharing?: SharePort;
}

/** Where making a link, and copying or sharing it, has got to. */
type LinkStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'made'; readonly link: string; readonly went: LinkShareOutcome };

/** The status line for each step: a closed share sheet says nothing. */
function statusLine(words: ShareLinkWords, status: LinkStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'making':
      return words.making;
    case 'failed':
      return words.failed;
    case 'made':
      return {
        shared: messages.linkShare.shared,
        copied: words.copied,
        blocked: words.copyFailed,
        cancelled: '',
      }[status.went];
  }
}

/** The warning, the button and Share, and once made, the link with how copying or sharing went. */
export function ShareLink(props: ShareLinkProps) {
  const { words, makeLink, copyText, primary = true, sharing } = props;
  const [status, setStatus] = useState<LinkStatus>({ kind: 'idle' });
  const warning = useId();
  const note = useId();
  const sheetOpen = useRef(false);
  const busy = () => status.kind === 'making' || sheetOpen.current;
  const copy = () => {
    if (busy()) return;
    setStatus({ kind: 'making' });
    const link = makeLink();
    const copied = copyText(link);
    link.then(
      (made) => {
        copied.then(
          () => {
            setStatus({ kind: 'made', link: made, went: 'copied' });
          },
          () => {
            setStatus({ kind: 'made', link: made, went: 'blocked' });
          },
        );
      },
      () => {
        copied.catch(() => undefined);
        setStatus({ kind: 'failed' });
      },
    );
  };
  const send = ({ share }: SharePort, link: string) => {
    sheetOpen.current = true;
    void shareLink(link, { share, copyText }).then((went) => {
      sheetOpen.current = false;
      setStatus({ kind: 'made', link, went });
    });
  };
  const share = (port: SharePort) => {
    if (busy()) return;
    if (status.kind === 'made') {
      send(port, status.link);
    } else if (port.share === undefined) {
      copy();
    } else {
      setStatus({ kind: 'making' });
      makeLink().then(
        (made) => {
          send(port, made);
        },
        () => {
          setStatus({ kind: 'failed' });
        },
      );
    }
  };
  const button = (
    <Button
      className={primary ? 'button button-primary' : 'button button-secondary'}
      onPress={copy}
      aria-describedby={warning}
    >
      {words.button}
    </Button>
  );
  return (
    <div className="stack">
      <p id={warning} className="lede">
        {words.warning}
      </p>
      {sharing === undefined ? (
        button
      ) : (
        <>
          <p id={note}>{messages.linkShare.chatNote}</p>
          <div className="row">
            {button}
            <Button
              className="button button-secondary"
              onPress={() => {
                share(sharing);
              }}
              aria-describedby={`${warning} ${note}`}
            >
              {messages.linkShare.button}
            </Button>
          </div>
        </>
      )}
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
