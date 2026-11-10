import { describe, expect, it } from 'vitest';

import { deriveMailboxId } from '../crypto/groupKeys';
import { DAY_MINUTES } from '../engine/rules';
import { mailboxAt, mailboxesFrom, type MailboxAt, REGISTER_DAYS } from './mailbox';

const group = { secret: new Uint8Array(32).fill(9) };
const NOW = 29_000_000;

describe('mailboxAt: the one seam for a group’s mailbox at a relay minute (#99, #110)', () => {
  it('is the group’s one mailbox today, whatever the minute', () => {
    const today = deriveMailboxId(group.secret);

    expect(mailboxAt(group, NOW)).toBe(today);
    expect(mailboxAt(group, NOW + 400 * DAY_MINUTES)).toBe(today);
  });
});

describe('mailboxesFrom: every mailbox a push registration needs', () => {
  it('is the one mailbox today', () => {
    expect(mailboxesFrom(group, NOW)).toEqual([deriveMailboxId(group.secret)]);
  });

  it('gives each mailbox `mailboxAt` names from now to 30 days on, once each, in order', () => {
    const asked: number[] = [];
    // Weekly mailboxes, as #110 will make them: a new one every 7 days.
    const weekly: MailboxAt = (_group, minute) => {
      asked.push(minute);
      return `week-${String(Math.floor(minute / (7 * DAY_MINUTES)))}`;
    };
    const first = Math.floor(NOW / (7 * DAY_MINUTES));
    const last = Math.floor((NOW + 30 * DAY_MINUTES) / (7 * DAY_MINUTES));
    const weeks = Array.from({ length: last - first + 1 }, (_, n) => `week-${String(first + n)}`);

    const names = mailboxesFrom(group, NOW, weekly);

    expect(REGISTER_DAYS).toBe(30);
    expect(asked[0]).toBe(NOW);
    expect(asked.at(-1)).toBe(NOW + 30 * DAY_MINUTES);
    expect(names).toEqual(weeks);
    expect(names).toHaveLength(6);
    expect(asked).toHaveLength(31);
  });
});
