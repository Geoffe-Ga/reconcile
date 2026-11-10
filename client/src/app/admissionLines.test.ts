import { describe, expect, it } from 'vitest';

import { admissionOf } from '../engine/admission';
import type { GroupState } from '../engine/fold';
import { DAY_MINUTES, DEFAULT_RULES } from '../engine/rules';
import { authorOf } from '../test/keys';
import { groupLog, START_MINUTE } from '../test/votes';
import { progressLine, waitingLine } from './admissionLines';
import { formatDay } from './format';
import { formatMinute } from './time';

const KIM = authorOf('kim');

/** When Kim's wait ends: she joins at START_MINUTE. */
const WAIT_END = START_MINUTE + DEFAULT_RULES.waitDays * DAY_MINUTES;

/** Ana, Ben and Cal hold rights; Kim joins at START_MINUTE, and `vouchers` vouch for her. */
function kimWith(vouchers: readonly string[]) {
  const log = groupLog({ members: ['Ben', 'Cal'], newcomers: ['Kim'] });
  for (const voucher of vouchers) log.vouch(voucher, 'Kim');
  return log;
}

/** Kim's progress line in `state`. */
function progress(state: GroupState): string {
  const admission = admissionOf(state, KIM);
  if (admission === null) throw new Error('Expected Kim to be a newcomer.');
  return progressLine(admission, state.at);
}

describe('progressLine', () => {
  it('counts the vouches so far and says when the wait ends, while it runs', () => {
    expect(progress(kimWith([]).state())).toBe(
      `New · 0 of 2 vouches · wait ends ${formatDay(WAIT_END)}`,
    );
    expect(progress(kimWith(['Ana']).state())).toBe(
      `New · 1 of 2 vouches · wait ends ${formatDay(WAIT_END)}`,
    );
    expect(progress(kimWith(['Ana']).state(WAIT_END - 1))).toContain('wait ends');
  });

  it('says when they can vote once they have every vouch they need', () => {
    expect(progress(kimWith(['Ana', 'Ben']).state())).toBe(
      `New · 2 of 2 vouches · can vote from ${formatDay(WAIT_END)}`,
    );
  });

  it('drops the wait once it has ended without the vouches', () => {
    expect(progress(kimWith(['Ana']).state(WAIT_END))).toBe('New · 1 of 2 vouches');
  });
});

describe('waitingLine', () => {
  it('tells a newcomer when they can vote, and that they need two vouches', () => {
    expect(waitingLine(kimWith([]).state(), KIM)).toBe(
      `You can vote on Proposals that open after ${formatMinute(WAIT_END)}, once 2 people vouch for you.`,
    );
    expect(waitingLine(kimWith(['Ana']).state(), KIM)).toBe(
      `You can vote on Proposals that open after ${formatMinute(WAIT_END)}, once 2 people vouch for you.`,
    );
  });

  it('gives the date alone once they’re vouched for', () => {
    expect(waitingLine(kimWith(['Ana', 'Ben']).state(), KIM)).toBe(
      `You can vote on Proposals that open after ${formatMinute(WAIT_END)}.`,
    );
  });

  it('asks only for the vouches once the wait has ended', () => {
    expect(waitingLine(kimWith(['Ana']).state(WAIT_END), KIM)).toBe(
      'You can vote on Proposals that open once 2 people vouch for you.',
    );
  });

  it('says nothing to someone who holds rights, or once a newcomer’s rights arrive', () => {
    expect(waitingLine(kimWith([]).state(), authorOf('ana'))).toBeNull();
    expect(waitingLine(kimWith(['Ana', 'Ben']).state(WAIT_END), KIM)).toBeNull();
  });
});
