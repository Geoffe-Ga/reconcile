import { describe, expect, it } from 'vitest';

import type { ProposalBody } from './event';
import {
  DAY_MINUTES,
  DEFAULT_RULES,
  defaultWindowMinutes,
  foundingRules,
  RULE_CLASS,
  targetClass,
} from './rules';

/** A copy of DEFAULT_RULES as a genesis carries it: plain JSON, read back. */
function asJson(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_RULES)) as Record<string, unknown>;
}

/** Every leaf of DEFAULT_RULES, as its path of keys and its value. */
function leaves(value: unknown, path: readonly string[] = []): [readonly string[], unknown][] {
  if (typeof value !== 'object' || value === null) return [[path, value]];
  return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
}

/** A JSON copy of DEFAULT_RULES with the leaf at `path` replaced by `value`. */
function withLeaf(path: readonly string[], value: unknown): Record<string, unknown> {
  const rules = asJson();
  let node: Record<string, unknown> = rules;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path[path.length - 1] ?? ''] = value;
  return rules;
}

const EDIT: ProposalBody = { atom: 'g.0', title: 'T', why: 'W', text: 'New\n' };

describe('DEFAULT_RULES: the founding rules (ADR-0067 Fellowship, ADR-0074, ADR-0015)', () => {
  it('holds the bars, windows, quorum, vouches, wait, ballot expiry, stewards and suspension', () => {
    expect(DEFAULT_RULES).toEqual({
      bars: {
        ordinary: { avgAtLeast: 2, zerosUnderPercent: 10 },
        entrenched: { avgAtLeast: 3, zerosUnderPercent: 5 },
      },
      windows: {
        ordinary: { min: 3, max: 14, default: 7 },
        entrenched: { min: 14, max: 28, default: 14 },
      },
      quorum: { min: 3, percent: 30 },
      vouches: 2,
      waitDays: 14,
      ballotExpiryDays: 30,
      stewards: { firstElectionAt: 3, secondSeatAt: 6, termDays: 182 },
      suspensionDays: 7,
    });
  });

  it('holds only whole numbers, so the engine never counts in fractions', () => {
    for (const [path, value] of leaves(DEFAULT_RULES)) {
      expect(Number.isSafeInteger(value), path.join('.')).toBe(true);
    }
  });

  it('keeps every class’s default window within its own bounds', () => {
    for (const window of Object.values(DEFAULT_RULES.windows)) {
      expect(window.min).toBeLessThanOrEqual(window.default);
      expect(window.default).toBeLessThanOrEqual(window.max);
    }
  });
});

describe('RULE_CLASS: each founding rule’s class (ADR-0051)', () => {
  it('entrenches the pass rules, quorum, stewards and suspension, and keeps windows, vouches, the wait and expiry ordinary', () => {
    expect(RULE_CLASS).toEqual({
      bars: 'entrenched',
      windows: 'ordinary',
      quorum: 'entrenched',
      vouches: 'ordinary',
      waitDays: 'ordinary',
      ballotExpiryDays: 'ordinary',
      stewards: 'entrenched',
      suspensionDays: 'entrenched',
    });
  });

  it('names a class for every rule and for nothing else', () => {
    expect(Object.keys(RULE_CLASS).sort()).toEqual(Object.keys(DEFAULT_RULES).sort());
  });
});

describe('foundingRules: the rules a genesis founds its group with', () => {
  it('takes every default when genesis carries no rules, as a genesis from before #94 does', () => {
    expect(foundingRules(undefined)).toEqual(DEFAULT_RULES);
    expect(foundingRules({})).toEqual(DEFAULT_RULES);
  });

  it('accepts the defaults written out in full, as Create group writes them', () => {
    expect(foundingRules(asJson())).toEqual(DEFAULT_RULES);
  });

  it('gives a missing field its default at any depth', () => {
    expect(foundingRules({ bars: {} })).toEqual(DEFAULT_RULES);
    expect(foundingRules({ bars: { entrenched: { avgAtLeast: 3 } }, vouches: 2 })).toEqual(
      DEFAULT_RULES,
    );
    expect(foundingRules({ windows: { ordinary: { default: 7 } } })).toEqual(DEFAULT_RULES);
  });

  it('refuses a genesis whose entrenched bar is lowered to an average of 1', () => {
    expect(foundingRules({ bars: { entrenched: { avgAtLeast: 1, zerosUnderPercent: 5 } } })).toBe(
      null,
    );
  });

  it.each(leaves(DEFAULT_RULES).map(([path, value]) => [path.join('.'), path, value] as const))(
    'refuses any other value for %s: one less, one more, as text, or null',
    (_name, path, value) => {
      const number = Number(value);
      expect(foundingRules(withLeaf(path, value))).toEqual(DEFAULT_RULES);
      expect(foundingRules(withLeaf(path, number - 1))).toBeNull();
      expect(foundingRules(withLeaf(path, number + 1))).toBeNull();
      expect(foundingRules(withLeaf(path, String(value)))).toBeNull();
      expect(foundingRules(withLeaf(path, null))).toBeNull();
    },
  );

  it.each([
    ['a number for the bars', { bars: 3 }],
    ['a list for the windows', { windows: [] }],
    ['null for the quorum', { quorum: null }],
    ['an object for the vouches', { vouches: { count: 2 } }],
    ['a list for one bar', { bars: { ordinary: [2, 10] } }],
  ])('refuses %s', (_name, rules) => {
    expect(foundingRules(rules)).toBeNull();
  });

  it('refuses rules that are not an object at all', () => {
    expect(foundingRules(null)).toBeNull();
    expect(foundingRules([])).toBeNull();
    expect(foundingRules('defaults')).toBeNull();
  });

  it('leaves out fields it doesn’t know, so a later rule a newer device writes founds the group here', () => {
    const rules = { ...asJson(), optIns: { bot: false }, extra: 'x' };
    expect(foundingRules(rules)).toEqual(DEFAULT_RULES);
    expect(foundingRules({ bars: { removal: { avgAtLeast: 3 } } })).toEqual(DEFAULT_RULES);
  });

  it('reads only a field’s own value, never one an object inherits', () => {
    const inherited = Object.create({ vouches: 1 }) as Record<string, unknown>;
    expect(foundingRules(inherited)).toEqual(DEFAULT_RULES);
  });
});

describe('targetClass: how hard a change is', () => {
  it('makes every target ordinary until a later issue registers an entrenched one', () => {
    expect(targetClass({ rules: DEFAULT_RULES }, EDIT)).toBe('ordinary');
  });

  it('never reads a class, bar or deadline the proposer wrote', () => {
    const forged = { ...EDIT, class: 'entrenched', bar: DEFAULT_RULES.bars.entrenched };
    expect(targetClass({ rules: DEFAULT_RULES }, forged)).toBe('ordinary');
  });
});

describe('windows in relay minutes', () => {
  it('counts a day as 1,440 relay minutes', () => {
    expect(DAY_MINUTES).toBe(1_440);
  });

  it('gives each class’s default window: 7 days ordinary, 14 entrenched', () => {
    expect(defaultWindowMinutes(DEFAULT_RULES, 'ordinary')).toBe(10_080);
    expect(defaultWindowMinutes(DEFAULT_RULES, 'entrenched')).toBe(20_160);
  });
});
