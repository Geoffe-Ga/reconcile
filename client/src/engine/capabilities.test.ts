import { describe, expect, it } from 'vitest';

import {
  type Capability,
  can,
  DEFAULT_JOIN_LEVEL,
  FOUNDER_LEVEL,
  isLevel,
  isSuspended,
  type Level,
  LEVEL_CAPABILITIES,
  LEVELS,
  type Roster,
  SUSPENDED_CAPABILITIES,
  votingRightsCount,
  wouldVote,
} from './capabilities';

const ALL: readonly Capability[] = ['read', 'see-roster', 'vote', 'vouch', 'invite', 'propose'];

/** No seats held, no suspensions, at relay minute 0. */
const QUIET = { stewards: [], suspensions: [], at: 0 } as const;

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
const at = (level: Level): Roster => ({ ...QUIET, members: [{ author: 'ana', level }] });

/** Ana at `level` holding a steward seat, at relay minute 100, maybe suspended until `until`. */
function steward(level: Level, until?: number): Roster {
  const suspensions = until === undefined ? [] : [{ member: 'ana', until }];
  return {
    members: [{ author: 'ana', level }],
    stewards: [{ holder: 'ana' }, { holder: null }],
    suspensions,
    at: 100,
  };
}

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
    expect(can({ ...QUIET, members: [] }, 'ana', 'read')).toBe(false);
  });

  it('reads each member’s own level', () => {
    const state = {
      ...QUIET,
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

/** What a steward seat adds to a level: suspending someone (#102) and narrowing an opt-in (#117). */
const SEATED: readonly Capability[] = ['suspend', 'narrow'];

describe('can: stewards and suspensions (#102)', () => {
  it.each(LEVELS)(
    'grants suspend and narrow to a %s holding a seat, on top of their level',
    (level) => {
      const granted = [...ALL, ...SEATED].filter((c) => can(steward(level), 'ana', c));
      expect(granted).toEqual([...LEVEL_CAPABILITIES[level], 'suspend', 'narrow']);
    },
  );

  it('grants suspend and narrow to nobody who holds no seat, whatever their level', () => {
    expect(can(at('co-creator'), 'ana', 'suspend')).toBe(false);
    expect(can(at('co-creator'), 'ana', 'narrow')).toBe(false);
    const other = { ...steward('co-creator'), stewards: [{ holder: 'ben' }, { holder: null }] };
    expect(can(other, 'ana', 'suspend')).toBe(false);
    expect(can(other, 'ana', 'narrow')).toBe(false);
  });

  it('leaves only read and see-roster to a suspended member, steward or not', () => {
    expect(SUSPENDED_CAPABILITIES).toEqual(['read', 'see-roster']);
    const granted = [...ALL, ...SEATED].filter((c) => can(steward('co-creator', 101), 'ana', c));
    expect(granted).toEqual(['read', 'see-roster']);
  });

  it('gives everything back the minute the suspension ends', () => {
    expect(isSuspended(steward('co-creator', 101), 'ana')).toBe(true);
    expect(isSuspended(steward('co-creator', 100), 'ana')).toBe(false);
    expect(can(steward('co-creator', 100), 'ana', 'suspend')).toBe(true);
    expect(can(steward('co-creator', 100), 'ana', 'propose')).toBe(true);
  });

  it('reads only the member’s own suspensions', () => {
    const state = { ...at('co-creator'), suspensions: [{ member: 'ben', until: 200 }] };
    expect(isSuspended(state, 'ana')).toBe(false);
    expect(can(state, 'ana', 'vote')).toBe(true);
  });

  it('still refuses a non-member who is named in a suspension', () => {
    const state = { ...at('co-creator'), suspensions: [{ member: 'zed', until: 200 }] };
    expect(can(state, 'zed', 'read')).toBe(false);
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

  it('ignores a suspension, so a suspension never shrinks the electorate (ADR-0075 §3)', () => {
    expect(wouldVote(steward('collaborator', 200), 'ana')).toBe(true);
  });
});

describe('votingRightsCount', () => {
  it('counts the members whose level votes, ignoring Members and suspensions', () => {
    const state = {
      ...QUIET,
      at: 5,
      members: [
        { author: 'ana', level: 'co-creator' as const },
        { author: 'ben', level: 'collaborator' as const },
        { author: 'kim', level: 'member' as const },
        { author: 'cal', level: 'collaborator' as const },
      ],
      suspensions: [{ member: 'cal', until: 10 }],
    };
    expect(votingRightsCount(state)).toBe(3);
  });

  it('counts nobody before anyone is a member', () => {
    expect(votingRightsCount({ ...QUIET, members: [] })).toBe(0);
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
