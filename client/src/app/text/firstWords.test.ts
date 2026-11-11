import { describe, expect, it } from 'vitest';

import { firstWords } from './firstWords';

describe('firstWords', () => {
  it.each([
    ['five words or fewer, as they are', 'Quiet hours start at ten.', 'Quiet hours start at ten.'],
    [
      'the first five of more, then an ellipsis',
      'Shared spaces are cleaned every Sunday.',
      'Shared spaces are cleaned every…',
    ],
    ['a heading without its marks', '# Our *aims*\n', 'Our aims'],
    [
      'links and emphasis as they read',
      'Be **kind**, see [our site](https://example.org).',
      'Be kind, see our site.',
    ],
    ['a line break as a space', 'Bins go out\non Tuesday.\n', 'Bins go out on Tuesday.'],
    ['each list item in turn', '- Quiet after ten\n- Bins\n', 'Quiet after ten Bins'],
    ['inline code as written', 'Use `npm ci` first.', 'Use npm ci first.'],
    ['a code block as written', '```\nmake build\n```\n', 'make build'],
    ['the source when nothing reads as text', '---\n', '---'],
    ['nothing for an empty text', '', ''],
  ])('gives %s', (_label, text, words) => {
    expect(firstWords(text)).toBe(words);
  });

  it('takes as many words as it is asked for', () => {
    expect(firstWords('One two three four.', 2)).toBe('One two…');
  });
});
