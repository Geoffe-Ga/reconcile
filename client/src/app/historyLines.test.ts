import { describe, expect, it } from 'vitest';

import { keptTextLine, movedLine } from './historyLines';

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

describe('keptTextLine (#103, #116)', () => {
  it('says where a move put its section, or the class a class change gave it, and nothing for any other change', () => {
    expect(keptTextLine({ kind: 'moved', to: { kind: 'top' } })).toBe('Moved to the top');
    expect(keptTextLine({ kind: 'class-changed', to: 'entrenched' })).toBe('Entrenched');
    expect(keptTextLine({ kind: 'class-changed', to: 'eternal' })).toBe('Made eternal');
    expect(keptTextLine({ kind: 'class-changed', to: 'ordinary' })).toBe('Protection lifted');
    expect(keptTextLine({ kind: 'changed', quote: 'Before.' })).toBeNull();
    expect(keptTextLine({ kind: 'founded' })).toBeNull();
  });
});
