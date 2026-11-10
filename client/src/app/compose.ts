/**
 * What the composers share apart from any screen (spec §8): how sending went,
 * sending once at a time, and the check on a section's new text.
 */
import { useRef, useState } from 'react';

import { normalizeAtomText } from '../engine/atomText';
import { messages } from './messages';
import type { DraftState } from './useDraft';

/** How sending went: `proposed` and `added` move on to the Proposal; the others stay on the form. */
export type ComposeOutcome = 'proposed' | 'added' | 'too-large' | 'failed';

/** Refuses blank text, and text that normalizes to the section's own (spec §4). */
export function textCheck(current: string, missing: string = messages.composer.textMissing) {
  const now = normalizeAtomText(current);
  return (value: string): string | null => {
    const text = normalizeAtomText(value);
    if (text === '') return missing;
    return text === now ? messages.composer.textUnchanged : null;
  };
}

/**
 * Runs `send` once at a time, keeping the button disabled until it is done.
 * The draft holds still while the Proposal or version is queued, since
 * queuing clears it, and saves again if it couldn't be queued. A removal
 * version keeps no draft, so it passes none.
 */
export function useSend<V>(send: (values: V) => Promise<ComposeOutcome>, draft: DraftState | null) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const run = async (values: V) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    // Each submit starts with no refusals, so `refused` only holds the latest answer.
    setRefused({});
    draft?.hold();
    const outcome = await send(values).catch(() => 'failed' as const);
    // What was queued leaves this screen, so the button stays disabled.
    if (outcome === 'proposed' || outcome === 'added') return;
    draft?.resume();
    busy.current = false;
    setRunning(false);
    setRefused(outcome === 'too-large' ? { text: messages.composer.tooLarge } : {});
    setFailed(outcome === 'failed');
  };
  return { run, running, failed, refused };
}
