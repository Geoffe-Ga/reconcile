import { describe, expect, it } from 'vitest';

import type { EventDraft } from '../engine/event';
import { fold, type LogRecord } from '../engine/fold';
import { signedAs } from '../test/keys';
import { latestLink } from './latestLink';

const MINUTE = 29_000_000;

/**
 * Folds a group whose genesis carries `chat`, then one Proposal per entry of
 * `links`, each on a section of its own, since a section takes one open
 * Proposal at a time.
 */
function groupWith(chat: string | undefined, links: readonly (string | undefined)[]) {
  const records: LogRecord[] = [];
  const add = (draft: EventDraft): string => {
    const { record, id } = signedAs('ana', draft);
    records.push({ seq: records.length + 1, received: MINUTE, bytes: record });
    return id;
  };
  const body = {
    name: 'Riverside Tenants',
    founder: 'Ana',
    documents: [
      {
        title: 'House rules',
        atoms: [
          'Quiet hours start at ten.',
          ...links.map((_, index) => `Section ${String(index + 2)}.`),
        ],
      },
    ],
    ...(chat === undefined ? {} : { chat }),
  };
  const group = add({ type: 'genesis', group: '', ts: 0, body });
  links.forEach((link, index) => {
    const proposal = {
      atom: `${group}.${String(index)}`,
      title: `Proposal ${String(index + 1)}`,
      why: 'Why not.',
      text: 'New text.',
      ...(link === undefined ? {} : { link }),
    };
    add({ type: 'proposal', group, ts: 0, body: proposal });
  });
  return fold(records, MINUTE);
}

describe('latestLink', () => {
  it('is the group’s chat link before any Proposal carries one', () => {
    expect(latestLink(groupWith('https://chat.example.org/a', []))).toBe(
      'https://chat.example.org/a',
    );
    expect(latestLink(groupWith('https://chat.example.org/a', [undefined]))).toBe(
      'https://chat.example.org/a',
    );
  });

  it('is the most recent Proposal’s link, in relay order', () => {
    const state = groupWith('https://chat.example.org/a', [
      'https://chat.example.org/b',
      undefined,
      'https://chat.example.org/c',
      undefined,
    ]);
    expect(latestLink(state)).toBe('https://chat.example.org/c');
  });

  it('skips a Proposal whose link isn’t an http(s) link', () => {
    const state = groupWith('https://chat.example.org/a', [
      'https://chat.example.org/b',
      'javascript:alert(1)',
      'not a link',
    ]);
    expect(latestLink(state)).toBe('https://chat.example.org/b');
  });

  it('is null when nothing in the group carries a usable link', () => {
    expect(latestLink(groupWith(undefined, []))).toBeNull();
    expect(latestLink(groupWith('javascript:alert(1)', ['data:text/html,hi']))).toBeNull();
  });
});
