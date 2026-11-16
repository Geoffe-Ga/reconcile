import { describe, expect, it } from 'vitest';

import { BALLOT_SALT_BYTES, newBallotSalt } from './salt';

describe('newBallotSalt', () => {
  it('makes 16 random bytes, fresh each time (#111)', () => {
    const [a, b] = [newBallotSalt(), newBallotSalt()];
    expect(BALLOT_SALT_BYTES).toBe(16);
    expect(a).toHaveLength(16);
    expect(b).toHaveLength(16);
    expect(a).not.toEqual(b);
  });
});
