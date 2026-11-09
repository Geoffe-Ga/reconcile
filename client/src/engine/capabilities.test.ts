import { describe, expect, it } from 'vitest';

import { type Capability, can, LEVEL_CAPABILITIES, MVP_LEVEL } from './capabilities';

const ALL: readonly Capability[] = ['read', 'propose', 'vote', 'invite', 'see-roster'];

/** Every TypeScript source file under src/, as text, keyed by its path from this file. */
const SOURCES = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The level names that only capabilities.ts may spell out (ADR-0003, ADR-0021). */
const LEVEL_LITERAL = /(['"`])(co-creator|collaborator|member)\1/;

/** The files allowed to spell out level names, as `SOURCES` keys them. */
const ALLOWED = new Set(['./capabilities.ts', './capabilities.test.ts']);

/** Paths of the files, other than capabilities.ts and this test, that contain a level-name literal. */
function filesNamingLevels(sources: Readonly<Record<string, string>>): string[] {
  return Object.entries(sources)
    .filter(([path]) => !ALLOWED.has(path))
    .filter(([, text]) => LEVEL_LITERAL.test(text))
    .map(([path]) => path);
}

describe('LEVEL_CAPABILITIES', () => {
  it('gives the one MVP level all five capabilities', () => {
    expect(Object.keys(LEVEL_CAPABILITIES)).toEqual([MVP_LEVEL]);
    expect(LEVEL_CAPABILITIES[MVP_LEVEL]).toEqual(ALL);
  });

  it('names the one level co-creator', () => {
    expect(MVP_LEVEL).toBe('co-creator');
  });
});

describe('can', () => {
  const state = { members: [{ author: 'ana', level: MVP_LEVEL }] };

  it.each(ALL)('lets a member %s', (capability) => {
    expect(can(state, 'ana', capability)).toBe(true);
  });

  it.each(ALL)('refuses a non-member %s', (capability) => {
    expect(can(state, 'ben', capability)).toBe(false);
  });

  it('refuses everyone before anyone is a member', () => {
    expect(can({ members: [] }, 'ana', 'read')).toBe(false);
  });
});

describe('level names stay inside capabilities.ts', () => {
  it('finds no level-name literal anywhere else in src/', () => {
    expect(Object.keys(SOURCES)).toContain('./capabilities.ts');
    expect(Object.keys(SOURCES)).toContain('../app/App.tsx');
    expect(filesNamingLevels(SOURCES)).toEqual([]);
  });

  it.each([`'co-creator'`, `"collaborator"`, '`member`'])(
    'catches %s in another file',
    (literal) => {
      const sources = {
        '../app/Screen.tsx': `if (level === ${literal}) {}`,
        './capabilities.ts': `const level = ${literal};`,
      };
      expect(filesNamingLevels(sources)).toEqual(['../app/Screen.tsx']);
    },
  );

  it('ignores the words inside longer strings and comments', () => {
    const sources = { '../app/Screen.tsx': `// a member\nconst s = 'member list';` };
    expect(filesNamingLevels(sources)).toEqual([]);
  });
});
