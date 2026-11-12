import { describe, expect, it } from 'vitest';

import { COUNTED, DOOR, ROTATED } from '../test/door';
import type { ProposalBody, RemovalProposalBody, RulesProposalBody } from './event';
import { OFF } from './optIns';
import {
  chosenWindow,
  DAY_MINUTES,
  DEFAULT_RULES,
  defaultWindowMinutes,
  foundingRules,
  RULE_CLASS,
  targetClass,
  validWindow,
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

/** The numeric leaves: every rule but the opt-ins, whose leaves are off values (#117). */
function numericLeaves(): [readonly string[], unknown][] {
  return leaves(DEFAULT_RULES).filter(([path]) => path[0] !== 'optIns');
}

const EDIT: ProposalBody = { atom: 'g.0', title: 'T', why: 'W', text: 'New\n' };

const W1 = 'https://discord.com/api/webhooks/1/abc';
const W2 = 'https://discord.com/api/webhooks/2/def';

/** A rules Proposal setting `optIn` to `value`. */
function rules(optIn: string, value: unknown): RulesProposalBody {
  return { target: { kind: 'rules', optIn, value }, title: 'T', why: 'W' };
}

/** A group whose standing opt-ins are `optIns`. */
function standing(optIns: Partial<typeof OFF>) {
  return { rules: { ...DEFAULT_RULES, optIns: { ...OFF, ...optIns } } };
}

describe('DEFAULT_RULES: the founding rules (ADR-0067 Fellowship, ADR-0074, ADR-0015)', () => {
  it('holds the bars, windows, quorum, vouches, wait, ballot expiry, stewards, suspension and opt-ins', () => {
    expect(DEFAULT_RULES).toEqual({
      bars: {
        ordinary: { avgAtLeast: 2, zerosUnderPercent: 10 },
        entrenched: { avgAtLeast: 3, zerosUnderPercent: 5 },
        removal: { avgAtLeast: 3, zerosUnderPercent: 5, zerosAllowed: 1 },
      },
      windows: {
        ordinary: { min: 3, max: 14, default: 7 },
        entrenched: { min: 14, max: 28, default: 14 },
        removal: { min: 14, max: 14, default: 14 },
      },
      quorum: { min: 3, percent: 30 },
      vouches: 2,
      waitDays: 14,
      ballotExpiryDays: 30,
      stewards: { firstElectionAt: 3, secondSeatAt: 6, termDays: 182 },
      suspensionDays: 7,
      optIns: { chatBot: null, frontDoor: false },
    });
  });

  it('founds every group with each opt-in off (ADR-0038, ADR-0039)', () => {
    expect(DEFAULT_RULES.optIns).toEqual(OFF);
  });

  it('holds only whole numbers apart from the opt-ins, so the engine never counts in fractions', () => {
    for (const [path, value] of numericLeaves()) {
      expect(Number.isSafeInteger(value), path.join('.')).toBe(true);
    }
  });

  it('runs a removal for the entrenched default and no other length (ADR-0075 §3, #115)', () => {
    const { removal, entrenched } = DEFAULT_RULES.windows;
    expect(removal).toEqual({
      min: entrenched.default,
      max: entrenched.default,
      default: entrenched.default,
    });
  });

  it('gives removal the entrenched average and share of zeros, and forgives one 0 (ADR-0075 §3)', () => {
    const { removal, entrenched } = DEFAULT_RULES.bars;
    expect(removal).toEqual({ ...entrenched, zerosAllowed: 1 });
    expect(entrenched).not.toHaveProperty('zerosAllowed');
  });

  it('keeps every class’s default window within its own bounds', () => {
    for (const window of Object.values(DEFAULT_RULES.windows)) {
      expect(window.min).toBeLessThanOrEqual(window.default);
      expect(window.default).toBeLessThanOrEqual(window.max);
    }
  });
});

describe('RULE_CLASS: each founding rule’s class (ADR-0051)', () => {
  it('entrenches the pass rules, quorum, stewards and suspension, keeps windows, vouches, the wait and expiry ordinary, and gives the opt-ins their own class', () => {
    expect(RULE_CLASS).toEqual({
      bars: 'entrenched',
      windows: 'ordinary',
      quorum: 'entrenched',
      vouches: 'ordinary',
      waitDays: 'ordinary',
      ballotExpiryDays: 'ordinary',
      stewards: 'entrenched',
      suspensionDays: 'entrenched',
      optIns: 'opt-in',
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

  it.each(numericLeaves().map(([path, value]) => [path.join('.'), path, value] as const))(
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

  it('refuses a genesis that opens an opt-in: only a passed Proposal opens one (ADR-0040)', () => {
    expect(foundingRules({ optIns: { frontDoor: DOOR } })).toBeNull();
    expect(foundingRules({ optIns: { chatBot: { webhook: W1 } } })).toBeNull();
    expect(foundingRules({ optIns: { chatBot: false } })).toBeNull();
    expect(foundingRules({ optIns: { chatBot: null, frontDoor: false } })).toEqual(DEFAULT_RULES);
  });

  it('leaves out fields it doesn’t know, so a later rule a newer device writes founds the group here', () => {
    const rules = { ...asJson(), optIns: { ...OFF, bot: false }, extra: 'x' };
    expect(foundingRules(rules)).toEqual(DEFAULT_RULES);
    expect(foundingRules({ bars: { later: { avgAtLeast: 3 } } })).toEqual(DEFAULT_RULES);
  });

  it('takes removal’s bar and window from a genesis that has none, as one from before #115 has', () => {
    const before = asJson();
    const bars = before.bars as Record<string, unknown>;
    const windows = before.windows as Record<string, unknown>;
    delete bars.removal;
    delete windows.removal;
    expect(foundingRules(before)).toEqual(DEFAULT_RULES);
    expect(foundingRules({ bars: { removal: { avgAtLeast: 3 } } })).toEqual(DEFAULT_RULES);
  });

  it('refuses a genesis that takes away removal’s forgiven 0, or forgives two', () => {
    expect(foundingRules({ bars: { removal: { zerosAllowed: 0 } } })).toBeNull();
    expect(foundingRules({ bars: { removal: { zerosAllowed: 2 } } })).toBeNull();
  });

  it('reads only a field’s own value, never one an object inherits', () => {
    const inherited = Object.create({ vouches: 1 }) as Record<string, unknown>;
    expect(foundingRules(inherited)).toEqual(DEFAULT_RULES);
  });
});

describe('targetClass: how hard a change is', () => {
  it('makes an edit ordinary, and a steward election too', () => {
    expect(targetClass({ rules: DEFAULT_RULES }, EDIT)).toBe('ordinary');
    const steward = {
      target: { kind: 'steward', seat: 1, member: null } as const,
      title: 't',
      why: 'w',
    };
    expect(targetClass({ rules: DEFAULT_RULES }, steward)).toBe('ordinary');
  });

  it('makes dissolving the group entrenched, wipe or not (ADR-0051, #108)', () => {
    for (const wipe of [false, true]) {
      const dissolve = { target: { kind: 'dissolve', wipe } as const, title: 't', why: 'w' };
      expect(targetClass({ rules: DEFAULT_RULES }, dissolve)).toBe('entrenched');
    }
  });

  it('makes a Dispatch put to a vote ordinary, whatever its ceiling, and a promotion record too (#126)', () => {
    const dispatch = { title: 'Rally', text: 'Saturday at ten.' };
    for (const ceiling of [1, 2, 'coalitions'] as const) {
      const body = {
        target: { kind: 'dispatch', ceiling } as const,
        title: 't',
        why: 'w',
        dispatch,
      };
      expect(targetClass({ rules: DEFAULT_RULES }, body)).toBe('ordinary');
    }
    const target = {
      kind: 'promote',
      dispatch: { id: 'd', ...dispatch },
      ceiling: 'coalitions',
      level: 1,
      from: 'k',
    } as const;
    expect(targetClass({ rules: DEFAULT_RULES }, { target, title: 'Rally', why: '' })).toBe(
      'ordinary',
    );
  });

  it('makes turning an opt-in on entrenched (ADR-0040)', () => {
    expect(targetClass(standing({}), rules('chatBot', { webhook: W1 }))).toBe('entrenched');
    expect(targetClass(standing({}), rules('frontDoor', DOOR))).toBe('entrenched');
  });

  it('makes turning an opt-in off, or replacing one webhook with another, ordinary (ADR-0075 §5)', () => {
    const on = standing({ chatBot: { webhook: W1 }, frontDoor: DOOR });
    expect(targetClass(on, rules('chatBot', null))).toBe('ordinary');
    expect(targetClass(on, rules('frontDoor', false))).toBe('ordinary');
    expect(targetClass(on, rules('chatBot', { webhook: W2 }))).toBe('ordinary');
  });

  it('reads the standing value when the Proposal opens, never one the proposer wrote', () => {
    const forged = { ...rules('frontDoor', DOOR), from: DOOR, class: 'ordinary' };
    expect(targetClass(standing({}), forged)).toBe('entrenched');
    expect(targetClass(standing({ frontDoor: DOOR }), rules('frontDoor', ROTATED))).toBe(
      'ordinary',
    );
    expect(targetClass(standing({ frontDoor: DOOR }), rules('frontDoor', COUNTED))).toBe(
      'entrenched',
    );
    expect(targetClass(standing({ frontDoor: COUNTED }), rules('frontDoor', DOOR))).toBe(
      'ordinary',
    );
  });

  it('makes a rules target for an opt-in it doesn’t know ordinary, which the fold ignores anyway', () => {
    expect(targetClass(standing({}), rules('signalBot', true))).toBe('ordinary');
  });

  it('makes removing a member removal, whatever class or window the proposer wrote (#115)', () => {
    const removal: RemovalProposalBody = {
      target: { kind: 'remove', member: 'kim' },
      title: 't',
      why: 'w',
    };
    expect(targetClass({ rules: DEFAULT_RULES }, removal)).toBe('removal');
    const forged = { ...removal, class: 'ordinary', window: 3 };
    expect(targetClass({ rules: DEFAULT_RULES }, forged)).toBe('removal');
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

  it('gives each class’s default window: 7 days ordinary, 14 entrenched, and 14 for a removal', () => {
    expect(defaultWindowMinutes(DEFAULT_RULES, 'ordinary')).toBe(10_080);
    expect(defaultWindowMinutes(DEFAULT_RULES, 'entrenched')).toBe(20_160);
    expect(defaultWindowMinutes(DEFAULT_RULES, 'removal')).toBe(20_160);
  });
});

describe('validWindow: a window the proposer may choose (#106, ADR-0074)', () => {
  it.each([3, 4, 7, 13, 14])('accepts %s days for an ordinary change', (days) => {
    expect(validWindow(DEFAULT_RULES, 'ordinary', days)).toBe(true);
  });

  it.each([2, 15, 0, -7, 7.5, 3.000001, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s days for an ordinary change',
    (days) => {
      expect(validWindow(DEFAULT_RULES, 'ordinary', days)).toBe(false);
    },
  );

  it('accepts 14 and 28 days for the entrenched class, and refuses 13 and 29', () => {
    expect(validWindow(DEFAULT_RULES, 'entrenched', 14)).toBe(true);
    expect(validWindow(DEFAULT_RULES, 'entrenched', 28)).toBe(true);
    expect(validWindow(DEFAULT_RULES, 'entrenched', 13)).toBe(false);
    expect(validWindow(DEFAULT_RULES, 'entrenched', 29)).toBe(false);
  });

  it('reads the bounds from the rules it is given, not from the defaults', () => {
    const rules = {
      ...DEFAULT_RULES,
      windows: { ...DEFAULT_RULES.windows, ordinary: { min: 5, max: 6, default: 5 } },
    };
    expect(validWindow(rules, 'ordinary', 4)).toBe(false);
    expect(validWindow(rules, 'ordinary', 5)).toBe(true);
    expect(validWindow(rules, 'ordinary', 6)).toBe(true);
    expect(validWindow(rules, 'ordinary', 7)).toBe(false);
  });
});

describe('chosenWindow: how many days a Proposal runs (#106)', () => {
  it('is the class default when the proposer names no window', () => {
    expect(chosenWindow(DEFAULT_RULES, 'ordinary', undefined)).toBe(7);
    expect(chosenWindow(DEFAULT_RULES, 'entrenched', undefined)).toBe(14);
  });

  it('is the window the proposer chose when it is valid for the class', () => {
    expect(chosenWindow(DEFAULT_RULES, 'ordinary', 10)).toBe(10);
    expect(chosenWindow(DEFAULT_RULES, 'entrenched', 28)).toBe(28);
  });

  it('is null for a window outside the class’s bounds or not a whole number', () => {
    expect(chosenWindow(DEFAULT_RULES, 'ordinary', 15)).toBeNull();
    expect(chosenWindow(DEFAULT_RULES, 'entrenched', 10)).toBeNull();
    expect(chosenWindow(DEFAULT_RULES, 'ordinary', 7.5)).toBeNull();
  });
});
