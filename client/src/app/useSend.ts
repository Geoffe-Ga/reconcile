/**
 * `useSend`: runs a composer's send once at a time, for a screen that opens a
 * new Proposal with no draft to keep: the steward composer (#102) and the
 * dissolve composer (#108).
 */
import { useRef, useState } from 'react';

import { messages } from './messages';

/** How sending went: `proposed` moves on to the Proposal; the others stay on the form. */
export type SendOutcome = 'proposed' | 'too-large' | 'failed';

/**
 * Wraps `send` so a second run while one is in flight does nothing. What was
 * proposed leaves the screen, so `running` stays true and the button stays
 * off; otherwise `failed` says it couldn't be saved, and `refused` ties
 * "too long to send" to the why field.
 */
export function useSend<V>(send: (values: V) => Promise<SendOutcome>) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: V) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    setRefused({});
    const outcome = await send(values).catch(() => 'failed' as const);
    if (outcome === 'proposed') return;
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { why: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}
