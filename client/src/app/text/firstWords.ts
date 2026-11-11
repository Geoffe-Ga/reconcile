/**
 * The first few words of an Atom as it reads (#75), for lines that point at a
 * section by its words, such as "Adds a section after ‘Quiet hours start…’".
 * The Markdown marks are left out, so `# Our *aims*` reads "Our aims".
 */
import type { Token } from 'markdown-it';

import { messages } from '../messages';
import { parseAtom } from './markdown';

/** How many words {@link firstWords} gives unless asked for another number. */
export const FIRST_WORDS = 5;

/** The text an inline token's child reads as: its words, a space for a break, else nothing. */
function childText(token: Token): string {
  if (token.type === 'text' || token.type === 'code_inline') return token.content;
  return token.type === 'softbreak' || token.type === 'hardbreak' ? ' ' : '';
}

/** The text one block token reads as: its inline words, or a code block as written. */
function blockText(token: Token): string {
  if (token.type === 'inline') return (token.children ?? []).map(childText).join('');
  return token.type === 'fence' || token.type === 'code_block' ? token.content : '';
}

/**
 * The first `count` words of `text` as it reads, with an ellipsis when there
 * are more. A text with no words to read, such as a rule, gives its source.
 */
export function firstWords(text: string, count: number = FIRST_WORDS): string {
  const read = parseAtom(text).map(blockText).join(' ');
  const words = (read.trim() === '' ? text : read).split(/\s+/).filter((word) => word !== '');
  const first = words.slice(0, count).join(' ');
  return words.length > count ? `${first}${messages.app.ellipsis}` : first;
}
