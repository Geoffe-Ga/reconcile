/**
 * What the screens say about a section's history and a Document's change log
 * (#104), apart from any component: what a pass that left its section's text
 * as it was did to it, a move (#103) or a class change (#116), which its
 * history entry and its change log row both say.
 */
import type { Change, MovedTo } from '../engine/history';
import { messages } from './messages';
import { firstWords } from './text/firstWords';

/** Where a passed move put its section (#103): after the first words of the section it follows, to the top, or to the end. */
export function movedLine(to: MovedTo): string {
  const { history } = messages;
  switch (to.kind) {
    case 'top':
      return history.movedToTop;
    case 'after':
      return history.movedAfter(firstWords(to.quote));
    case 'end':
      return history.movedToEnd;
  }
}

/**
 * The line a pass that kept its section's text shows over it: where a move
 * put the section (#103), or the class a class change gave it (#116), as
 * "Made eternal". Null for any other change, which its text or quote says.
 */
export function keptTextLine(change: Change): string | null {
  if (change.kind === 'moved') return movedLine(change.to);
  return change.kind === 'class-changed' ? messages.history.classChanged[change.to] : null;
}
