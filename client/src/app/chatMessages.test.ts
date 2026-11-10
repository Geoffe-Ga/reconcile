import { describe, expect, it } from 'vitest';

import { DAY_MINUTES } from '../engine/rules';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { botNotice, chatDetails, chatMessage, openMoment, shareableTitle } from './chatMessages';
import { MINUTE_MS } from './time';

/** A relay minute on Friday 14 November 2025 at 12:00 UTC. */
const FRI_14 = Date.UTC(2025, 10, 14, 12) / MINUTE_MS;

describe('chatMessage', () => {
  it('says a new Proposal is open, and when voting ends', () => {
    expect(chatMessage('open', { deadline: FRI_14 }, 'UTC')).toBe(
      'A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.',
    );
  });

  it('keeps the line for someone who added a version', () => {
    expect(chatMessage('version', { deadline: FRI_14 }, 'UTC')).toBe(
      'I added a version in Reconcile. Voting ends Fri 14 Nov.',
    );
  });

  it('says a vote closes within a day, with no date', () => {
    expect(chatMessage('closing', { deadline: FRI_14 }, 'UTC')).toBe(
      'A vote closes within a day in Reconcile.',
    );
  });

  it('says a vote has finished, with no date', () => {
    expect(chatMessage('result', { deadline: FRI_14 }, 'UTC')).toBe(
      'A vote has finished in Reconcile.',
    );
  });

  it('ends each first sentence with the quoted title once someone includes it', () => {
    const titled = { deadline: FRI_14, title: 'Quiet hours' };
    expect(chatMessage('open', titled, 'UTC')).toBe(
      'A new Proposal is open in Reconcile: "Quiet hours". Voting ends Fri 14 Nov.',
    );
    expect(chatMessage('version', titled, 'UTC')).toBe(
      'I added a version in Reconcile: "Quiet hours". Voting ends Fri 14 Nov.',
    );
    expect(chatMessage('closing', titled, 'UTC')).toBe(
      'A vote closes within a day in Reconcile: "Quiet hours".',
    );
    expect(chatMessage('result', titled, 'UTC')).toBe(
      'A vote has finished in Reconcile: "Quiet hours".',
    );
  });

  it('takes bidi controls out of the title and turns its line breaks into spaces', () => {
    expect(chatMessage('result', { deadline: FRI_14, title: '\u202EQuiet\nhours' }, 'UTC')).toBe(
      'A vote has finished in Reconcile: "Quiet hours".',
    );
    const controls = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
    expect(chatMessage('closing', { deadline: FRI_14, title: `Bins${controls} day` }, 'UTC')).toBe(
      'A vote closes within a day in Reconcile: "Bins day".',
    );
    expect(
      chatMessage('closing', { deadline: FRI_14, title: 'a\r\nb\rc\u2028d\u2029e\u0085f' }, 'UTC'),
    ).toBe('A vote closes within a day in Reconcile: "a b c d e f".');
  });

  it('keeps the text around the bidi range, and its ordinary marks', () => {
    const edges = 'x\u2029\u202Fy\u2065z\u206A\u200F';
    expect(chatMessage('result', { deadline: FRI_14, title: edges }, 'UTC')).toBe(
      'A vote has finished in Reconcile: "x \u202Fy\u2065z\u206A\u200F".',
    );
  });

  it('leaves the title out when nothing readable is left of it', () => {
    expect(chatMessage('result', { deadline: FRI_14, title: '\u202E\n \u2069' }, 'UTC')).toBe(
      'A vote has finished in Reconcile.',
    );
  });

  it('dates the deadline in the device’s own time zone', () => {
    expect(chatMessage('open', { deadline: FRI_14 }, 'Pacific/Kiritimati')).toBe(
      'A new Proposal is open in Reconcile. Voting ends Sat 15 Nov.',
    );
  });
});

describe('openMoment', () => {
  /** Ana proposes with a `window`-day vote, and Ben adds a version. */
  function proposal(window: number) {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const id = log.propose('ana', { window });
    log.version('ben', id, 'Quiet after midnight.');
    const [folded] = log.state().proposals;
    if (folded === undefined) throw new Error('Expected the Proposal.');
    return folded;
  }

  it.each([3, 14])(
    'offers the closing line from a day before the deadline (%i-day window)',
    (window) => {
      const folded = proposal(window);
      const lastDay = folded.deadline - DAY_MINUTES;
      for (const me of ['ana', 'ben', 'cal']) {
        expect(openMoment(folded, authorOf(me), lastDay - 1)).not.toBe('closing');
        expect(openMoment(folded, authorOf(me), lastDay)).toBe('closing');
        expect(openMoment(folded, authorOf(me), folded.deadline - 1)).toBe('closing');
      }
    },
  );

  it('offers the version line to whoever added one, and the open line to everyone else', () => {
    const folded = proposal(7);
    const early = folded.received;
    expect(openMoment(folded, authorOf('ana'), early)).toBe('open');
    expect(openMoment(folded, authorOf('ben'), early)).toBe('version');
    expect(openMoment(folded, authorOf('cal'), early)).toBe('open');
  });

  it('offers the proposer the open line even when they added a version too', () => {
    const log = groupLog();
    const id = log.propose('ana');
    log.version('ana', id, 'Quiet after midnight.');
    const [folded] = log.state().proposals;
    if (folded === undefined) throw new Error('Expected the Proposal.');
    expect(openMoment(folded, authorOf('ana'), folded.received)).toBe('open');
  });
});

describe('shareableTitle and chatDetails', () => {
  it('offers a Proposal’s title, and adds it only when someone includes it', () => {
    const log = groupLog();
    log.propose('ana', { title: 'Later quiet hours' });
    const [folded] = log.state().proposals;
    if (folded === undefined) throw new Error('Expected the Proposal.');

    expect(shareableTitle(folded)).toBe('Later quiet hours');
    expect(chatDetails(folded, false)).toEqual({ deadline: folded.deadline });
    expect(chatDetails(folded, true)).toEqual({
      deadline: folded.deadline,
      title: 'Later quiet hours',
    });
  });

  it('never offers a steward Proposal’s title, which names a member', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    log.steward('ana', 1, 'Ben', { title: 'Make Ben steward (seat 1)' });
    const [folded] = log.state().proposals;
    if (folded === undefined) throw new Error('Expected the steward Proposal.');

    expect(shareableTitle(folded)).toBeNull();
    expect(chatDetails(folded, true)).toEqual({ deadline: folded.deadline });
    expect(chatMessage('open', chatDetails(folded, true))).not.toContain('Ben');
  });
});

describe('botNotice: what the chat bot posts (#119)', () => {
  const notice = botNotice('https://app.example', 'UTC');

  it('is the moment’s line with no title, then the app’s address on a line of its own', () => {
    expect(notice('open', FRI_14)).toBe(
      'A new Proposal is open in Reconcile. Voting ends Fri 14 Nov.\nhttps://app.example/',
    );
    expect(notice('closing', FRI_14)).toBe(
      'A vote closes within a day in Reconcile.\nhttps://app.example/',
    );
    expect(notice('result', FRI_14)).toBe(
      'A vote has finished in Reconcile.\nhttps://app.example/',
    );
  });

  it('is made from the moment and the deadline alone, so nothing else of a Proposal can reach it', () => {
    expect(notice).toHaveLength(2);
  });
});
