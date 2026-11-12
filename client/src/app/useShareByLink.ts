/**
 * `useShareByLink`: one personal Document's share, as its editor holds it
 * (#105): read once when the editor opens, then turned on, sent on and
 * stopped from there, one press at a time. A paused share (#328, #339) is
 * kept or stopped from there too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PersonalSharing, SharingKeep, ShareView } from './personalSharing';
import type { ShareOutcome } from './share';

/** Where the share has got to, as its live region says it. */
export type ShareStatus =
  | 'idle'
  | 'starting'
  | 'too-large'
  | 'start-failed'
  | ShareOutcome
  | 'stopping'
  | 'stop-failed'
  | 'stopped'
  | 'locked'
  | 'keeping'
  | 'kept'
  | 'kept-pending'
  | 'keep-stopped'
  | 'paused-stop-failed';

/** What the live region says once Keep sharing has run (#328). */
const KEPT: Readonly<Record<SharingKeep, ShareStatus>> = {
  posted: 'kept',
  pending: 'kept-pending',
  stopped: 'keep-stopped',
  locked: 'locked',
};

/** One Document's share, as its editor holds it. */
export interface ShareByLinkState {
  /** The share, or null while it's off; undefined until the device has said. */
  readonly view: ShareView | null | undefined;
  readonly status: ShareStatus;
  /** Whether a press is running, so no other starts. */
  readonly busy: boolean;
  /** Share link: saves what waits, posts the first copy, then hands the link on. */
  readonly start: () => Promise<void>;
  /** Hands the link on again, posting nothing. */
  readonly send: () => Promise<void>;
  /** Stop sharing. */
  readonly stop: () => Promise<void>;
  /** Keep sharing, once the share is paused (#328, #339): posts the latest copy. */
  readonly keep: () => Promise<void>;
  /**
   * Stops sharing before a delete.
   *
   * @throws {Error} when it couldn't, so nothing is deleted.
   */
  readonly stopFirst: () => Promise<void>;
}

/** Document `id`'s share on `sharing`; `save` keeps what was typed before a first copy goes out. */
export function useShareByLink(
  id: string,
  sharing: PersonalSharing,
  save: () => Promise<void>,
): ShareByLinkState {
  const [view, setView] = useState<ShareView | null | undefined>(undefined);
  const [status, setStatus] = useState<ShareStatus>('idle');
  const busy = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    sharing.read(id).then(
      (read) => {
        if (live.current) setView(read);
      },
      () => {
        if (live.current) setView(null);
      },
    );
    return () => {
      live.current = false;
    };
  }, [id, sharing]);

  /** Runs `task` unless one is running, showing `first` meanwhile. */
  const once = useCallback(async (first: ShareStatus, task: () => Promise<ShareStatus>) => {
    if (busy.current) return;
    busy.current = true;
    setStatus(first);
    const outcome = await task();
    busy.current = false;
    if (live.current) setStatus(outcome);
  }, []);

  const start = () =>
    once('starting', async () => {
      await save();
      const started = await sharing.start(id);
      if (started.kind === 'too-large') return 'too-large';
      if (started.kind === 'locked') return 'locked';
      if (started.kind === 'failed') return 'start-failed';
      if (live.current) setView({ link: started.link, pending: false, paused: null });
      return sharing.send(started.link);
    });

  const send = () => once('idle', async () => (view?.link ? sharing.send(view.link) : 'idle'));

  const stop = () =>
    once('stopping', async () => {
      const stopped = await sharing.stop(id);
      if (stopped === 'locked') return 'locked';
      if (stopped === 'failed') {
        return (view?.paused ?? null) === null ? 'stop-failed' : 'paused-stop-failed';
      }
      if (live.current) setView(null);
      return 'stopped';
    });

  const keep = () =>
    once('keeping', async () => {
      const link = view?.link;
      if (!link) return 'idle';
      const kept = await sharing.keep(id);
      // Locked (#255), nothing changed: the share still waits, paused.
      if (live.current && kept !== 'locked') {
        setView(kept === 'stopped' ? null : { link, pending: kept === 'pending', paused: null });
      }
      return KEPT[kept];
    });

  const stopFirst = async () => {
    if (view === null || view === undefined) return;
    if ((await sharing.stop(id)) !== 'stopped') throw new Error('Sharing couldn’t be stopped.');
    setView(null);
  };

  return {
    view,
    status,
    busy: status === 'starting' || status === 'stopping' || status === 'keeping',
    start,
    send,
    stop,
    keep,
    stopFirst,
  };
}
