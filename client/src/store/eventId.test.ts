import { describe, expect, it } from 'vitest';

import { signRecord } from '../crypto/record';
import { createEvent, fromBase64url } from '../engine/event';
import { utf8 } from '../test/bytes';
import { authorOf, signedAs, testKeys } from '../test/keys';
import { eventIdOf } from './eventId';

const JOIN = { type: 'join', group: 'group', ts: 0, body: { name: 'Ben' } } as const;

describe('eventIdOf', () => {
  it('is the id signEvent gave the event its record carries', () => {
    const { record, id } = signedAs('ben', JOIN);

    expect(eventIdOf(record)).toBe(id);
  });

  it('is null for a record whose signature fails', () => {
    const { record } = signedAs('ben', JOIN);
    const forged = Uint8Array.from(record);
    forged[40] = (forged[40] ?? 0) ^ 0x01;

    expect(eventIdOf(forged)).toBeNull();
  });

  it('is null for a record validly signed by someone other than its author', () => {
    const { bytes } = createEvent({ ...JOIN, author: authorOf('ana') });
    const ben = { publicKey: fromBase64url(authorOf('ben')), secretKey: testKeys('ben').secretKey };

    expect(eventIdOf(signRecord(ben, bytes))).toBeNull();
  });

  it.each([
    ['bytes that are not a record', 'not json'],
    ['a bare event, as the stub era kept', JSON.stringify({ v: 1, ...JOIN, author: 'x' })],
  ])('is null for %s', (_name, body) => {
    expect(eventIdOf(utf8(body))).toBeNull();
  });
});
