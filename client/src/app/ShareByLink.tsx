/**
 * Share by link (#105; ADR-0074's personal page at level 2): one personal
 * Document's share, off until the person turns it on, in its editor.
 *
 * Off, it says what the link shows and to whom, and what the relay keeps and
 * sees, before anything is sent. 'Share link' posts the first copy, then
 * hands the link on with fixed words; on, the link shows as selectable text
 * beside its warning, with 'Stop sharing', which says plainly what it can't
 * call back. A share a restore brought back is paused (#328), as is one this
 * device hasn't posted to for 30 days (#339): it asks first, saying which,
 * with 'Keep sharing' and 'Stop sharing', and shows no link until the person
 * keeps it. Every outcome is read out in a polite live region.
 */
import { useId } from 'react';
import { Button } from 'react-aria-components';

import { holdPresses } from './holdPresses';
import { messages } from './messages';
import type { SharePause } from '../share/shareLink';
import type { ShareView } from './personalSharing';
import { Field } from './ui';
import type { ShareByLinkState, ShareStatus } from './useShareByLink';

/** The live region's words for each status. */
const STATUS_LINE: Readonly<Record<ShareStatus, string>> = {
  idle: '',
  starting: messages.personal.share.starting,
  'too-large': messages.personal.share.tooLarge,
  'start-failed': messages.personal.share.startFailed,
  shared: messages.personal.share.shared,
  copied: messages.personal.share.copied,
  blocked: messages.personal.share.blocked,
  stopping: messages.personal.share.stopping,
  'stop-failed': messages.personal.share.stopFailed,
  stopped: messages.personal.share.stopped,
  keeping: messages.personal.share.keeping,
  kept: messages.personal.share.kept,
  'kept-pending': messages.personal.share.keptPending,
  'keep-stopped': messages.personal.share.keepStopped,
  'paused-stop-failed': messages.personal.share.pausedStopFailed,
};

/** The paused section's question, as the share came to wait for the person. */
const PAUSED_QUESTION: Readonly<Record<SharePause, string>> = {
  restored: messages.personal.share.paused,
  idle: messages.personal.share.pausedIdle,
};

/** Props for {@link ShareByLink}. */
export interface ShareByLinkProps {
  readonly share: ShareByLinkState;
  /** Whether the Document as typed still fits a share's 64,000-byte record. */
  readonly fits: boolean;
}

/** Off: what the link and the relay show, then Share link. */
function ShareOff({ share }: Pick<ShareByLinkProps, 'share'>) {
  const about = useId();
  const relay = useId();
  const line = useId();
  const { personal } = messages;
  const described = [about, relay, ...(share.status === 'too-large' ? [line] : [])].join(' ');
  return (
    <div className="stack">
      <p id={about} className="lede">
        {personal.share.about}
      </p>
      <p id={relay} className="caption">
        {personal.share.relay}
      </p>
      <div>
        <Button
          className="button button-secondary"
          onPress={() => {
            void share.start();
          }}
          isDisabled={share.busy}
          aria-describedby={described}
        >
          {personal.share.start}
        </Button>
      </div>
      <p id={line} role="status" className="status">
        {STATUS_LINE[share.status]}
      </p>
    </div>
  );
}

/** On: the link beside its warning, how edits reach it, then Share link again and Stop sharing. */
function ShareOn({ share, view, fits }: ShareByLinkProps & { readonly view: ShareView }) {
  const { personal } = messages;
  return (
    <div className="stack">
      <Field
        label={personal.share.field}
        hint={personal.share.warning}
        value={view.link}
        isReadOnly
        inputClassName="input-link"
        onFocus={(event) => {
          event.currentTarget.select();
        }}
      />
      <div className="share-notes">
        <p className="caption">{personal.share.edits}</p>
        {view.pending ? <p className="caption">{personal.share.pending}</p> : null}
        {fits ? null : <p className="form-error">{personal.share.tooLargeShared}</p>}
      </div>
      <div className="row">
        <Button
          className="button button-secondary"
          onPress={() => {
            void share.send();
          }}
          isDisabled={share.busy}
        >
          {personal.share.shareAgain}
        </Button>
        <Button
          className="button button-secondary"
          onPress={() => {
            void share.stop();
          }}
          isDisabled={share.busy}
        >
          {personal.share.stop}
        </Button>
      </div>
      <p role="status" className="status">
        {STATUS_LINE[share.status]}
      </p>
    </div>
  );
}

/**
 * Paused after a restore (#328), or after 30 days with no post from this
 * device (#339): the question for `pause` and what waits on it, then Keep
 * sharing and Stop sharing, both quiet, so neither is pressed on the person.
 * No link shows, so none is copied before they choose.
 */
function SharePaused({
  share,
  pause,
}: Pick<ShareByLinkProps, 'share'> & { readonly pause: SharePause }) {
  const question = useId();
  const note = useId();
  const { personal } = messages;
  return (
    <div className="stack">
      <p id={question} className="lede">
        {PAUSED_QUESTION[pause]}
      </p>
      <p id={note} className="caption">
        {personal.share.pausedNote}
      </p>
      <div className="row">
        <Button
          className="button button-secondary"
          onPress={() => {
            void share.keep();
          }}
          isDisabled={share.busy}
          aria-describedby={`${question} ${note}`}
        >
          {personal.share.keep}
        </Button>
        <Button
          className="button button-secondary"
          onPress={() => {
            void share.stop();
          }}
          isDisabled={share.busy}
          aria-describedby={question}
        >
          {personal.share.stop}
        </Button>
      </div>
      <p role="status" className="status">
        {STATUS_LINE[share.status]}
      </p>
    </div>
  );
}

/** The section's body for `view`: off, paused (#328, #339), or on. */
function ShareBody({ share, view, fits }: ShareByLinkProps & { readonly view: ShareView | null }) {
  if (view === null) return <ShareOff share={share} />;
  if (view.paused !== null) return <SharePaused share={share} pause={view.paused} />;
  return <ShareOn share={share} view={view} fits={fits} />;
}

/**
 * The Share by link section of a personal Document's editor (#105): off
 * until 'Share link', then the link and 'Stop sharing', or, while the share
 * is paused, its question (#328, #339). Nothing shows until the device has said
 * whether the Document is shared.
 */
export function ShareByLink({ share, fits }: ShareByLinkProps) {
  const heading = useId();
  const { view } = share;
  if (view === undefined) return null;
  return (
    <section
      className="section"
      aria-labelledby={heading}
      onPointerDownCapture={holdPresses(share.busy)}
    >
      <h2 id={heading} className="eyebrow">
        {messages.personal.share.heading}
      </h2>
      <ShareBody share={share} view={view} fits={fits} />
    </section>
  );
}
