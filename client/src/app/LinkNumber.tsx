/**
 * The six-digit number both devices show while linking (#96), with what to
 * do about it. It is set large in two groups of three, so it can be read
 * across a table, and the whole card is a status, so a screen reader
 * announces it as it appears.
 */
import { messages } from './messages';

/** Props for {@link LinkNumber}. */
export interface LinkNumberProps {
  /** The six digits. */
  readonly number: string;
  /** What to do: compare it here, or check it and confirm on the other device. */
  readonly prompt: string;
}

/** The prompt, then the number. */
export function LinkNumber({ number, prompt }: LinkNumberProps) {
  return (
    <div role="status" className="link-number-card">
      <p className="heading-3">{prompt}</p>
      <p className="link-number">{messages.link.number(number)}</p>
    </div>
  );
}
