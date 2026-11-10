/**
 * The link bundle's blobs (#96): a header, then chunks of at most 65,492
 * bytes, each sealed under K in the bundle mailbox, and how the new device
 * reads them back all or nothing.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { MAX_PLAINTEXT_BYTES, xchachaSeal } from '../crypto/seal';
import { local, text, utf8 } from '../test/bytes';
import { MAX_BUNDLE_CHUNKS, openBundle, sealBundle } from './bundle';

const channel = { mailbox: 'bundle-mailbox'.padEnd(43, '0'), key: new Uint8Array(32).fill(5) };

/** The plaintext inside each of `blobs`, opened under the test channel. */
function opened(blobs: readonly Uint8Array[]): Uint8Array[] {
  return blobs.map((blob) => {
    const plaintext = xchachaSeal.open(channel.mailbox, channel.key, blob);
    if (plaintext === null) throw new Error('Expected the blob to open.');
    return plaintext;
  });
}

/** `length` bytes that repeat 0–250, so a reordered chunk changes the whole. */
function filler(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => i % 251);
}

describe('sealBundle', () => {
  it('posts a header of the chunk count and the plaintext’s SHA-256, then the chunks', () => {
    const plaintext = utf8('{"format":1,"groups":[]}');

    const [header, ...chunks] = opened(sealBundle(xchachaSeal, channel, plaintext));

    expect(JSON.parse(text(header ?? new Uint8Array()))).toEqual({
      chunks: 1,
      sha256: base64url(sha256(plaintext)),
    });
    expect(chunks.map(text)).toEqual(['{"format":1,"groups":[]}']);
  });

  it.each([
    [1, 1],
    [MAX_PLAINTEXT_BYTES, 1],
    [MAX_PLAINTEXT_BYTES + 1, 2],
    [MAX_PLAINTEXT_BYTES * 2, 2],
    [MAX_PLAINTEXT_BYTES * 2 + 1, 3],
  ])('splits %i bytes into %i chunks of at most 65,492', (length, count) => {
    const plaintext = filler(length);

    const [, ...chunks] = opened(sealBundle(xchachaSeal, channel, plaintext));

    expect(chunks).toHaveLength(count);
    expect(chunks.every((chunk) => chunk.length <= MAX_PLAINTEXT_BYTES)).toBe(true);
    expect(local(Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))))).toEqual(plaintext);
  });

  it('seals every blob for the bundle mailbox under K, so it opens nowhere else', () => {
    const blobs = sealBundle(xchachaSeal, channel, utf8('{}'));
    for (const blob of blobs) {
      expect(xchachaSeal.open('another-mailbox'.padEnd(43, '0'), channel.key, blob)).toBeNull();
      expect(xchachaSeal.open(channel.mailbox, new Uint8Array(32), blob)).toBeNull();
    }
  });
});

describe('openBundle', () => {
  const plaintext = filler(MAX_PLAINTEXT_BYTES * 2 + 10);
  const blobs = sealBundle(xchachaSeal, channel, plaintext);

  it('reads back the plaintext once every chunk is there', () => {
    const result = openBundle(xchachaSeal, channel, blobs);
    expect(result.kind === 'ready' ? local(result.plaintext) : result).toEqual(plaintext);
  });

  it('waits while the mailbox is empty, or holds the header and only some chunks', () => {
    expect(openBundle(xchachaSeal, channel, [])).toEqual({ kind: 'waiting' });
    expect(openBundle(xchachaSeal, channel, blobs.slice(0, 1))).toEqual({ kind: 'waiting' });
    expect(openBundle(xchachaSeal, channel, blobs.slice(0, 3))).toEqual({ kind: 'waiting' });
  });

  it('skips a blob that doesn’t open, as anyone who knows the mailbox id could post one', () => {
    const junk = xchachaSeal.seal(channel.mailbox, new Uint8Array(32).fill(9), utf8('junk'));
    const result = openBundle(xchachaSeal, channel, [
      junk,
      ...blobs.slice(0, 2),
      junk,
      ...blobs.slice(2),
    ]);
    expect(result.kind === 'ready' ? local(result.plaintext) : result).toEqual(plaintext);
  });

  it('ignores anything after the chunks the header counts', () => {
    const extra = xchachaSeal.seal(channel.mailbox, channel.key, utf8('more'));
    const result = openBundle(xchachaSeal, channel, [...blobs, extra]);
    expect(result.kind).toBe('ready');
  });

  it('finds the bundle damaged when its chunks come in another order', () => {
    const [header, first, second, third] = blobs;
    if (
      header === undefined ||
      first === undefined ||
      second === undefined ||
      third === undefined
    ) {
      throw new Error('Expected a header and three chunks.');
    }
    expect(openBundle(xchachaSeal, channel, [header, second, first, third])).toEqual({
      kind: 'damaged',
    });
  });

  it.each([
    ['not JSON', 'not json'],
    ['a list', '[1, 2]'],
    ['no chunk count', `{"sha256":"${base64url(sha256(utf8('x')))}"}`],
    ['no chunks', `{"chunks":0,"sha256":"${base64url(sha256(utf8('x')))}"}`],
    ['a fraction of a chunk', `{"chunks":1.5,"sha256":"${base64url(sha256(utf8('x')))}"}`],
    [
      'more chunks than any bundle',
      `{"chunks":${String(MAX_BUNDLE_CHUNKS + 1)},"sha256":"${base64url(sha256(utf8('x')))}"}`,
    ],
    ['a short hash', '{"chunks":1,"sha256":"AAAA"}'],
    ['a hash that isn’t text', '{"chunks":1,"sha256":7}'],
  ])('finds a header with %s damaged', (_name, header) => {
    const sealed = [header, 'x'].map((part) =>
      xchachaSeal.seal(channel.mailbox, channel.key, utf8(part)),
    );
    expect(openBundle(xchachaSeal, channel, sealed)).toEqual({ kind: 'damaged' });
  });

  it('reads back whatever it seals', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 3000 }), (bytes) => {
        const result = openBundle(xchachaSeal, channel, sealBundle(xchachaSeal, channel, bytes));
        expect(result.kind === 'ready' ? local(result.plaintext) : result).toEqual(local(bytes));
      }),
      { numRuns: 25 },
    );
  });
});
