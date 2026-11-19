/**
 * "A new version is ready. Close and reopen Reconcile." (#513): one quiet
 * line on Start and Settings while a new version is installed and waiting
 * (`src/app/pwa/newVersion.ts`). It offers no button: a new version takes
 * over only at a fresh launch (ADR-0057), and the line says how to get one.
 */
import { messages } from './messages';

/** The line while `ready`, a status so it's heard if it appears on screen; else nothing. */
export function NewVersionLine({ ready }: { readonly ready: boolean }) {
  return ready ? (
    <p className="caption" role="status">
      {messages.update.ready}
    </p>
  ) : null;
}
