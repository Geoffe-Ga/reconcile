/**
 * `useSaving`: runs an action that queues an event, such as a ballot or a
 * level change, once at a time, and says how its last run went. And
 * `holdPresses`, which keeps a busy button from taking a late press.
 */
import { type PointerEvent, useRef, useState } from 'react';

/** How the last run went: none yet (or one running), saved, or failed. */
export type SaveOutcome = 'none' | 'sent' | 'failed';

/**
 * Wraps `save` so a second run while one is in flight does nothing. `run`
 * resolves true once `save` resolved, and false when it rejected or was
 * skipped; `running` is true meanwhile, and `outcome` holds the last result.
 */
export function useSaving<A extends readonly unknown[]>(save: (...args: A) => Promise<void>) {
  const busy = useRef(false);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome>('none');
  const run = async (...args: A): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setRunning(true);
    setOutcome('none');
    const saved = await save(...args).then(
      () => true,
      () => false,
    );
    busy.current = false;
    setRunning(false);
    setOutcome(saved ? 'sent' : 'failed');
    return saved;
  };
  return { run, running, outcome };
}

/**
 * Keeps a press from starting on the send button while it saves. React Aria's
 * usePress starts one on pointerdown even on a disabled button, and a browser
 * gives a disabled button pointerdown and pointerup but no click, so 80 ms later
 * usePress clicks the button itself. If saving finished within those 80 ms, the
 * button was enabled again and a second ballot went out (#190). Put it on the
 * row around any button that is disabled while it saves.
 */
export function holdPresses(saving: boolean) {
  return (event: PointerEvent) => {
    if (saving) event.stopPropagation();
  };
}
