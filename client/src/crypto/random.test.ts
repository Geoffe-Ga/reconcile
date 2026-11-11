import { describe, expect, it } from 'vitest';

import { randomBytes } from './random';

describe('randomBytes', () => {
  it('makes as many random bytes as asked, fresh each time (#126)', () => {
    const [a, b] = [randomBytes(6), randomBytes(6)];
    expect(a).toHaveLength(6);
    expect(b).toHaveLength(6);
    expect(a).not.toEqual(b);
    expect(randomBytes(0)).toHaveLength(0);
  });
});
