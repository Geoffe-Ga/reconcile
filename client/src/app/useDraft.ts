/**
 * `useDraft`: the composer's private draft (ADR-0073; spec §8), read once
 * when the composer opens and saved about half a second after typing stops.
 *
 * The draft stays on this device. It is cleared when its Proposal enters the
 * outbox (the store does that in the same change) or when the person
 * discards it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Draft, GroupDrafts } from '../store/drafts';

/** How long after the last keystroke a draft is saved. */
export const DRAFT_SAVE_DELAY_MS = 500;

/** True when two drafts carry the same Dispatch (#112), or neither carries one. */
function sameDispatch(a: Draft['dispatch'], b: Draft['dispatch']): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.title === b.title && a.text === b.text;
}

/** True when two drafts hold the same values. A blank window (NaN) equals another blank one. */
function sameDraft(a: Draft, b: Draft): boolean {
  const texts = a.title === b.title && a.why === b.why && a.text === b.text && a.link === b.link;
  return texts && Object.is(a.window, b.window) && sameDispatch(a.dispatch, b.dispatch);
}

/** The composer's draft, as `useDraft` keeps it. */
export interface DraftState {
  /** The values to show, or null until the stored draft has been read. */
  readonly values: Draft | null;
  /** Whether the values came back from a draft saved earlier on this device. */
  readonly restored: boolean;
  /** Whether the values differ from where the composer started, so there's something to discard. */
  readonly changed: boolean;
  /** Shows new values, and saves them once typing has paused. */
  update(values: Draft): void;
  /** Stops saving, as a Proposal goes to the outbox, so nothing re-saves the draft it clears. */
  hold(): void;
  /** Saves again, at once, after a Proposal that couldn't be queued. */
  resume(): void;
  /** Clears the stored draft and starts over from the starting values. */
  discard(): void;
}

interface Shown {
  readonly values: Draft;
  readonly restored: boolean;
}

/**
 * The draft for `target` in `drafts`, starting from `start` when there is
 * none. `start` is read once, when the composer opens.
 */
export function useDraft(drafts: GroupDrafts, target: string, start: Draft): DraftState {
  const [initial] = useState(start);
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<Draft | null>(null);
  const latest = useRef<Draft>(initial);
  const held = useRef(false);

  /** Keeps `draft`, or clears the stored one when it's back where it started. A failure is ignored. */
  const keep = useCallback(
    (draft: Draft) => {
      const kept = sameDraft(draft, initial) ? drafts.clear(target) : drafts.save(target, draft);
      kept.catch(() => undefined);
    },
    [drafts, target, initial],
  );

  /** Cancels the timer and saves whatever was waiting for it, unless held. */
  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const draft = waiting.current;
    waiting.current = null;
    if (draft !== null && !held.current) keep(draft);
  }, [keep]);

  useEffect(() => {
    let live = true;
    const show = (draft: Draft | undefined) => {
      if (!live) return;
      latest.current = draft ?? initial;
      setShown({ values: latest.current, restored: draft !== undefined });
    };
    drafts.load(target).then(show, () => {
      show(undefined);
    });
    return () => {
      live = false;
      flush();
    };
  }, [drafts, target, initial, flush]);

  const update = (values: Draft) => {
    setShown((now) => (now === null ? now : { ...now, values }));
    latest.current = values;
    waiting.current = values;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
  };

  const hold = () => {
    held.current = true;
    flush();
  };

  const resume = () => {
    held.current = false;
    keep(latest.current);
  };

  const discard = () => {
    hold();
    held.current = false;
    drafts.clear(target).catch(() => undefined);
    latest.current = initial;
    setShown({ values: initial, restored: false });
  };

  const values = shown?.values ?? null;
  return {
    values,
    restored: shown?.restored ?? false,
    changed: values !== null && !sameDraft(values, initial),
    update,
    hold,
    resume,
    discard,
  };
}
