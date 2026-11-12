/**
 * What the screens say about a section's history and a Document's change log
 * (#104), apart from any component: where a passed move put its section
 * (#103), which its history entry and its change log row both say.
 */
import type { MovedTo } from '../engine/history';
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
