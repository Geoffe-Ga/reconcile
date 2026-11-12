import { describe, expect, it } from 'vitest';

import { movedLine } from './historyLines';

describe('movedLine (#103)', () => {
  it('names the section a move follows by its first words, or says it went to the top or the end', () => {
    expect(movedLine({ kind: 'after', quote: 'Quiet hours start at ten tonight.' })).toBe(
      'Moved after ‘Quiet hours start at ten…’',
    );
    expect(movedLine({ kind: 'after', quote: '# Values\n' })).toBe('Moved after ‘Values’');
    expect(movedLine({ kind: 'top' })).toBe('Moved to the top');
    expect(movedLine({ kind: 'end' })).toBe('Moved to the end');
  });
});
