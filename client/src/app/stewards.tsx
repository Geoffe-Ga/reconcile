/**
 * Stewards and suspensions on screen (#102; ADR-0016, ADR-0049): a sentence
 * with a person's name in it, what a steward ballot decides, and the
 * suspended person's own line. Every name sits in `<bdi>`, and a
 * suspension's reason is plain text, never Markdown or HTML. The words come
 * from src/app/stewardLines.ts and the messages module.
 */
import type { GroupState } from '../engine/fold';
import { messages } from './messages';
import { type Motion, suspendedLine } from './stewardLines';

/** The words around a name in one sentence: before it, and after it when any follow. */
export interface NameParts {
  readonly before: string;
  readonly after?: string;
}

/** Words that sit right after a name, with no space: closing punctuation. */
const TIGHT = /^[?.,:;]/;

/** A sentence with a person's name in it, the name in `<bdi>` so its direction can't reorder the rest. */
export function Named({ parts, name }: { readonly parts: NameParts; readonly name: string }) {
  const { before, after } = parts;
  return (
    <>
      {before} <bdi>{name}</bdi>
      {after === undefined ? null : (
        <>
          {TIGHT.test(after) ? null : ' '}
          {after}
        </>
      )}
    </>
  );
}

/** "Make <name> steward (seat N)", or "Recall <name> as steward". */
export function MotionTitle({ motion }: { readonly motion: Motion }) {
  const { stewards } = messages;
  const parts =
    motion.kind === 'elect' ? stewards.makeSteward(motion.seat) : stewards.recallSteward;
  return <Named parts={parts} name={motion.name} />;
}

/** The suspended person's own line, while their suspension runs; nothing for anyone else. */
export function SuspendedNote({ state, me }: { readonly state: GroupState; readonly me: string }) {
  const line = suspendedLine(state, me);
  return line === null ? null : <p className="suspended-note">{line}</p>;
}
