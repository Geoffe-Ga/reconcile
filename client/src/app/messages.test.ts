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
      // "Push" alone was a Dispatch's working name. A phone's "push address" is Web Push's
      // own term, which #99's disclosure names on purpose; nothing else may say push.
      expect(text, path).not.toMatch(
        /\b(pitch|push(?! address)|fork|split|organization|community)\b/i,
      );
    }
    expect('Push the Dispatch').toMatch(/\bpush(?! address)\b/i);
    expect(messages.push.disclosure).toContain('push address');
  });

  it('says what an invite link opens in spec §9’s words, and the join lines in §8’s', () => {
    expect(messages.home.inviteWarning).toBe(
      'Anyone who opens this link in the next 2 days can read everything this group has written and voted on, and what comes next. Send it directly to the people you’re inviting.',
    );
    expect(messages.home.missingHistory).toBe(
      'Some history may be missing on this device. Open a new invite link from your group to catch up.',
    );
    expect(messages.join.badLink).toBe(
      'This invite link has expired or is damaged. Ask someone in your group for a new one.',
    );
    expect(messages.join.nameHint).toBe(
      'This name is only shown in this group. It doesn’t have to be your real name.',
    );
    expect(messages.join.visibility(30)).toBe(
      'People in this group will see the name you choose and how you vote, until 30 days after each decision.',
    );
    expect(`${messages.join.fromBefore} Ana${messages.join.fromAfter}`).toBe('From Ana’s invite');
  });

  it('names and describes each level once, in LEVELS order', () => {
    expect(messages.levels.names).toHaveLength(LEVELS.length);
    expect(messages.levels.descriptions).toHaveLength(LEVELS.length);
    expect(messages.levels.names).toEqual(['Member', 'Collaborator', 'Co-Creator']);
  });

  it('fills in names and counts', () => {
    expect(messages.document.proposeLabel(2)).toBe('Propose a change to section 2');
    expect(messages.app.pageTitle('Create a group')).toBe('Create a group · Reconcile');
    expect(messages.window.outside(14, 28)).toBe('Choose from 14 to 28 days.');
    expect(messages.window.runs(10)).toBe('Voting runs 10 days');
  });
});
