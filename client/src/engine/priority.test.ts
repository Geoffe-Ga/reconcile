import { describe, expect, it } from 'vitest';

import {
  isPriority,
  OPTION_MAX,
  optionId,
  optionProblems,
  OPTIONS_MAX,
  OPTIONS_MIN,
  optionsAreValid,
  openPriority,
} from './priority';

describe('priority options (#107)', () => {
  it('asks about 2 to 7 options of up to 120 code points', () => {
    expect([OPTIONS_MIN, OPTIONS_MAX, OPTION_MAX]).toEqual([2, 7, 120]);
  });

  it('gives option i the id `${proposalId}.${i}`', () => {
    expect(optionId('abc', 0)).toBe('abc.0');
    expect(optionId('abc', 6)).toBe('abc.6');
  });

  it('names each option’s problem in order: blank, too long, or the same as an earlier one', () => {
    const options = ['Fix the website', ' ', 'x'.repeat(121), 'Fix the website', '', 'Picnic'];
    expect(optionProblems(options)).toEqual([null, 'blank', 'too-long', 'repeated', 'blank', null]);
  });

  it('counts code points, not UTF-16 units, so 120 astral characters fit and 121 don’t', () => {
    expect(optionProblems(['🌱'.repeat(120), '🌱'.repeat(121)])).toEqual([null, 'too-long']);
    expect(optionProblems(['x'.repeat(OPTION_MAX)])).toEqual([null]);
  });

  it('compares options exactly as given: the author normalizes and trims them first', () => {
    expect(optionProblems(['Café', 'Cafe\u0301', 'Picnic', ' Picnic'])).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('accepts 2 to 7 fine options, and nothing else', () => {
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(optionsAreValid(seven.slice(0, 1))).toBe(false);
    expect(optionsAreValid(seven.slice(0, 2))).toBe(true);
    expect(optionsAreValid(seven)).toBe(true);
    expect(optionsAreValid([...seven, 'h'])).toBe(false);
    expect(optionsAreValid(['a', 'a'])).toBe(false);
    expect(optionsAreValid(['a', ''])).toBe(false);
  });
});

describe('openPriority', () => {
  const priority = (final: boolean) => ({ target: { kind: 'priority' }, final, id: final });
  const edit = { target: { kind: 'edit' }, final: false, id: 'edit' };

  it('tells a priority vote from an edit', () => {
    expect(isPriority(priority(false))).toBe(true);
    expect(isPriority(edit)).toBe(false);
  });

  it('finds the priority vote that hasn’t closed, and nothing once it has', () => {
    expect(openPriority({ proposals: [edit, priority(true), priority(false)] })?.final).toBe(false);
    expect(openPriority({ proposals: [edit, priority(true)] })).toBeUndefined();
  });
});
