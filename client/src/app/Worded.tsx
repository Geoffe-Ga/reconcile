/**
 * A sentence with names in it (#549), from the messages module's `Words`:
 * every name in its own `<bdi>`, so a name from another device, in any
 * direction, can't reorder the words around it. Names are plain text.
 */
import type { Words } from './messages';

/** Props for {@link Worded}. */
export interface WordedProps {
  readonly words: Words;
}

/** The words of one sentence, each name in `<bdi>`. */
export function Worded({ words }: WordedProps) {
  return (
    <>
      {words.map((word, index) =>
        typeof word === 'string' ? word : <bdi key={index}>{word.name}</bdi>,
      )}
    </>
  );
}
