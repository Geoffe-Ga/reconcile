import { describe, expect, it } from 'vitest';

import {
  type Capability,
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  type Level,
  LEVEL_CAPABILITIES,
  LEVELS,
  wouldVote,
} from './capabilities';

const ALL: readonly Capability[] = ['read', 'see-roster', 'vote', 'vouch', 'invite', 'propose'];

/** Every TypeScript and JSON file under src/, as text, keyed by its path from this file. */
const SOURCES = import.meta.glob<string>('../**/*.{ts,tsx,json}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The level names that only capabilities.ts may spell out (ADR-0003, ADR-0021). */
const LEVEL_LITERAL = /(['"`])(co-creator|collaborator|member)\1/;

/** The files allowed to spell out level names, as `SOURCES` keys them. */
const ALLOWED = new Set(['./capabilities.ts', './capabilities.test.ts']);

/** The golden vectors, which pin events' exact bytes, level ids included. Nothing else. */
const VECTOR = /^\.\/vectors\/[^/]+\.json$/;

/** Paths of the files, other than capabilities.ts, this test and the vectors, that name a level. */
function filesNamingLevels(sources: Readonly<Record<string, string>>): string[] {
  return Object.entries(sources)
    .filter(([path]) => !ALLOWED.has(path) && !VECTOR.test(path))
    .filter(([, text]) => LEVEL_LITERAL.test(text))
    .map(([path]) => path);
}

/** A roster of one member, ana, at `level`. */
const at = (level: Level) => ({ members: [{ author: 'ana', level }] });

describe('LEVELS', () => {
  it('lists the three levels from following to creating', () => {
    expect(LEVELS).toEqual(['member', 'collaborator', 'co-creator']);
  });

  it('starts the founder as a Co-Creator, and a join that names no level as a Collaborator', () => {
    expect(FOUNDER_LEVEL).toBe('co-creator');
    expect(DEFAULT_JOIN_LEVEL).toBe('collaborator');
  });

  it.each(['member', 'collaborator', 'co-creator'])('knows %s', (level) => {
    expect(isLevel(level)).toBe(true);
  });

  it.each(['admin', 'Member', 'co_creator', '', 'constructor', 'toString', 0, null, undefined])(
    'knows no level %j',
    (level) => {
      expect(isLevel(level)).toBe(false);
    },
  );
});

describe('LEVEL_CAPABILITIES', () => {
  it('gives each level what the one before it has, and more (ADR-0003, ADR-0021)', () => {
    expect(LEVEL_CAPABILITIES).toEqual({
      member: ['read', 'see-roster'],
      collaborator: ['read', 'see-roster', 'vote', 'vouch', 'invite'],
      'co-creator': ['read', 'see-roster', 'vote', 'vouch', 'invite', 'propose'],
    });
    expect(Object.keys(LEVEL_CAPABILITIES)).toEqual(LEVELS);
  });

  it('lets every level read the roster until the hidden roster returns (ADR-0074)', () => {
    for (const level of LEVELS) expect(LEVEL_CAPABILITIES[level]).toContain('see-roster');
  });
});

describe('can', () => {
  it.each([
    ['member', ['read', 'see-roster']],
    ['collaborator', ['read', 'see-roster', 'vote', 'vouch', 'invite']],
    ['co-creator', ALL],
  ] as const)('lets a %s do exactly %j', (level, allowed) => {
    const granted = ALL.filter((capability) => can(at(level), 'ana', capability));
    expect(granted).toEqual(allowed);
  });

  it.each(ALL)('refuses a non-member %s', (capability) => {
    expect(can(at('co-creator'), 'ben', capability)).toBe(false);
  });

  it('refuses everyone before anyone is a member', () => {
    expect(can({ members: [] }, 'ana', 'read')).toBe(false);
  });

  it('reads each member’s own level', () => {
    const state = {
      members: [
        { author: 'ana', level: 'co-creator' as const },
        { author: 'kim', level: 'member' as const },
      ],
    };
    expect(can(state, 'ana', 'propose')).toBe(true);
    expect(can(state, 'kim', 'propose')).toBe(false);
    expect(can(state, 'kim', 'read')).toBe(true);
  });
});

describe('wouldVote', () => {
  it.each([
    ['member', false],
    ['collaborator', true],
    ['co-creator', true],
  ] as const)('says a %s would vote: %s', (level, votes) => {
    expect(wouldVote(at(level), 'ana')).toBe(votes);
  });

  it('says a non-member wouldn’t vote', () => {
    expect(wouldVote(at('co-creator'), 'ben')).toBe(false);
  });
});

describe('level names stay inside capabilities.ts', () => {
  it('finds no level-name literal anywhere else in src/, except the vectors', () => {
    expect(Object.keys(SOURCES)).toContain('./capabilities.ts');
    expect(Object.keys(SOURCES)).toContain('../app/App.tsx');
    expect(Object.keys(SOURCES)).toContain('./vectors/levels-capabilities.json');
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

  it('allows level ids in the golden vectors, and in no other JSON', () => {
    const sources = {
      './vectors/levels-step-up-after-open.json': '{"level": "collaborator"}',
      './vectors/nested/levels.json': '{"level": "collaborator"}',
      '../app/strings.json': '{"label": "member"}',
    };
    expect(filesNamingLevels(sources)).toEqual([
      './vectors/nested/levels.json',
      '../app/strings.json',
    ]);
  });

  it('ignores the words inside longer strings and comments', () => {
    const sources = { '../app/Screen.tsx': `// a member\nconst s = 'member list';` };
    expect(filesNamingLevels(sources)).toEqual([]);
  });
});
