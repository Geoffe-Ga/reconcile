import { describe, expect, it } from 'vitest';

import { createEvent } from '../engine/event';
import { utf8 } from '../test/bytes';
import { eventIdOf } from './eventId';

describe('eventIdOf', () => {
  it('is the id createEvent gave the event', () => {
    const { bytes, id } = createEvent({
      type: 'join',
      group: 'group',
      author: 'author-ben',
      ts: 0,
      body: { name: 'Ben' },
    });

    expect(eventIdOf(bytes)).toBe(id);
  });

  it.each([
    ['bytes that are not JSON', 'not json'],
    ['JSON that is not an event', '{"event":"ana-1"}'],
  ])('is null for %s', (_name, body) => {
    expect(eventIdOf(utf8(body))).toBeNull();
  });
});
