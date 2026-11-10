import { describe, expect, it } from 'vitest';

import { DEFAULT_JOIN_LEVEL, FOUNDER_LEVEL, LEVELS } from '../engine/capabilities';
import { levelDescription, levelName } from './levels';

describe('levelName and levelDescription', () => {
  it('name each level in LEVELS order', () => {
    expect(LEVELS.map(levelName)).toEqual(['Member', 'Collaborator', 'Co-Creator']);
    expect(levelName(DEFAULT_JOIN_LEVEL)).toBe('Collaborator');
    expect(levelName(FOUNDER_LEVEL)).toBe('Co-Creator');
  });

  it('describe what each level adds, in one line', () => {
    expect(LEVELS.map(levelDescription)).toEqual([
      'Follow along and read',
      'Also vote, vouch and invite',
      'Also propose changes and add versions',
    ]);
  });
});
