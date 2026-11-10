import { describe, expect, it } from 'vitest';

import { LEVELS } from '../engine/capabilities';
import { messages } from './messages';

/** Every string in the catalog, with functions called on sample arguments, one per parameter. */
function allStrings(node: unknown, path = 'messages'): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (typeof node === 'function') {
    const samples = Array.from({ length: (node as () => unknown).length }, () => 'Sample');
    const result: unknown = (node as (...args: string[]) => unknown)(...samples);
    return allStrings(result, `${path}()`);
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    allStrings(value, `${path}.${key}`),
  );
}

const strings = allStrings(messages);

describe('messages', () => {
  it('holds every screen this issue builds', () => {
    expect(Object.keys(messages)).toEqual(
      expect.arrayContaining(['app', 'start', 'create', 'join', 'home', 'document']),
    );
    expect(strings.length).toBeGreaterThan(40);
  });

  it('has no empty or padded strings', () => {
    for (const [path, text] of strings) {
      expect(text.trim(), path).toBe(text);
      expect(text, path).not.toBe('');
    }
  });

  it('keeps DESIGN.md’s voice: no exclamation marks, no "Oops", no fear words', () => {
    for (const [path, text] of strings) {
      expect(text, path).not.toMatch(/!|\boops\b|\bwarning\b|\bdanger\b/i);
    }
  });

  it('uses the domain vocabulary, never retired or misleading words', () => {
    for (const [path, text] of strings) {
      expect(text, path).not.toMatch(/\b(pitch|push|fork|split|organization|community)\b/i);
    }
  });

  it('names and describes each level once, in LEVELS order', () => {
    expect(messages.levels.names).toHaveLength(LEVELS.length);
    expect(messages.levels.descriptions).toHaveLength(LEVELS.length);
    expect(messages.levels.names).toEqual(['Member', 'Collaborator', 'Co-Creator']);
  });

  it('fills in names and counts', () => {
    expect(messages.document.proposeLabel(2)).toBe('Propose a change to section 2');
    expect(messages.app.pageTitle('Create a group')).toBe('Create a group · Reconcile');
  });
});
