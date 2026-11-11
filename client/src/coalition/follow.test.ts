import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { cardChannelOf } from '../crypto/card';
import { followChannelOf, newFollowSeed } from '../crypto/follow';
import { newGroupSecret } from '../crypto/groupKeys';
import { BLOB_SIZES, MAX_PLAINTEXT_BYTES, xchachaSeal } from '../crypto/seal';
import type { LogRecord } from '../engine/fold';
import { EXCERPT_MAX, NAME_MAX } from '../invite/envelope';
import { stubSeal } from '../test/stubSeal';
import {
  type Follow,
  FOLLOW_TTL_DAYS,
  FollowTooLarge,
  followLink,
  openFollow,
  parseFollowLink,
  parseFollowPayload,
  sealFollow,
} from './follow';

/** One relay record of `size` bytes at `seq`. */
function entry(seq: number, size: number): LogRecord {
  return { seq, received: 29_000_000 + seq, bytes: new Uint8Array(size).fill(seq % 256) };
}

/** A follow link's contents for a formed coalition, under a fresh secret. */
function follow(overrides: Partial<Follow> = {}): Follow {
  return {
    secret: newGroupSecret(),
    preview: {
      name: 'Eastside Housing',
      groups: ['Riverside Tenants', 'Oak St Co-op'],
      excerpt: 'We keep rents fair and homes safe on the east side.',
    },
    entries: [entry(1, 300), entry(4, 200)],
    ...overrides,
  };
}

/** The header blob's JSON as `sealFollow` wrote it. */
function headerJson(seed: Uint8Array, made: Follow = follow()): Record<string, unknown> {
  const channel = followChannelOf(seed);
  const [blob] = sealFollow(stubSeal, channel, made);
  const opened = stubSeal.open(channel.mailbox, channel.key, blob ?? new Uint8Array());
  return JSON.parse(new TextDecoder().decode(opened ?? new Uint8Array())) as Record<
    string,
    unknown
  >;
}

/** A header with `change` applied, sealed as the first blob, then the real chunks. */
function changed(seed: Uint8Array, change: (json: Record<string, unknown>) => unknown) {
  const channel = followChannelOf(seed);
  const made = follow();
  const [, ...chunks] = sealFollow(stubSeal, channel, made);
  const text = JSON.stringify(change(headerJson(seed, made)));
  const header = stubSeal.seal(channel.mailbox, channel.key, new TextEncoder().encode(text));
  return [header, ...chunks];
}

describe('a follow link’s envelope (#124)', () => {
  it('opens to what was sealed: the secret, the preview and the coalition’s log', () => {
    const seed = newFollowSeed();
    const made = follow();
    const blobs = sealFollow(xchachaSeal, followChannelOf(seed), made);

    expect(blobs).toHaveLength(2);
    for (const blob of blobs) expect(BLOB_SIZES).toContain(blob.length);
    expect(openFollow(xchachaSeal, followChannelOf(seed), blobs)).toEqual(made);
    expect(FOLLOW_TTL_DAYS).toBe(1);
  });

  it('carries a long log in as many chunks as it needs', () => {
    const seed = newFollowSeed();
    const made = follow({ entries: [entry(1, 40_000), entry(5, 40_000), entry(9, 20)] });
    const blobs = sealFollow(xchachaSeal, followChannelOf(seed), made);

    expect(blobs).toHaveLength(3);
    expect(openFollow(xchachaSeal, followChannelOf(seed), blobs)).toEqual(made);
  });

  it('holds the secret, the preview and the chunk count, and never inner or a seat', () => {
    const json = headerJson(newFollowSeed());
    expect(Object.keys(json).sort()).toEqual(['chunkCount', 'preview', 'secret']);
    expect(Object.keys(json.preview as object)).toEqual(['name', 'groups', 'excerpt']);
  });

  it('cuts each preview field as an invite’s is', () => {
    const preview = {
      name: 'n'.repeat(NAME_MAX + 5),
      groups: ['g'.repeat(NAME_MAX + 1), 'Oak St'],
      excerpt: 'e'.repeat(EXCERPT_MAX + 10),
    };
    const seed = newFollowSeed();
    const blobs = sealFollow(stubSeal, followChannelOf(seed), follow({ preview }));
    expect(openFollow(stubSeal, followChannelOf(seed), blobs)?.preview).toEqual({
      name: `${'n'.repeat(NAME_MAX)}…`,
      groups: [`${'g'.repeat(NAME_MAX)}…`, 'Oak St'],
      excerpt: `${'e'.repeat(EXCERPT_MAX)}…`,
    });
  });

  it('round-trips any names and excerpt it can carry, markup included, as text', () => {
    const text = fc.string({ minLength: 1, maxLength: NAME_MAX, unit: 'grapheme-composite' });
    fc.assert(
      fc.property(
        text,
        fc.array(text, { minLength: 1, maxLength: 5 }),
        fc.string(),
        (name, groups, excerpt) => {
          const seed = newFollowSeed();
          const made = follow({
            preview: { name, groups, excerpt: excerpt.slice(0, EXCERPT_MAX) },
          });
          const blobs = sealFollow(stubSeal, followChannelOf(seed), made);
          expect(openFollow(stubSeal, followChannelOf(seed), blobs)).toEqual(made);
        },
      ),
    );
    const markup = follow({
      preview: { name: '<b>Bold</b>', groups: ['<i>x</i>'], excerpt: '**y**' },
    });
    const seed = newFollowSeed();
    const blobs = sealFollow(stubSeal, followChannelOf(seed), markup);
    expect(openFollow(stubSeal, followChannelOf(seed), blobs)?.preview).toEqual(markup.preview);
  });

  it('refuses a preview too large for one blob', () => {
    // Each name is 120 three-byte code points: 200 of them can't fit one blob.
    const groups = Array.from({ length: 200 }, () => '€'.repeat(NAME_MAX));
    const made = follow({ preview: { name: 'E', groups, excerpt: '' } });
    expect(() => sealFollow(stubSeal, followChannelOf(newFollowSeed()), made)).toThrow(
      FollowTooLarge,
    );
    expect(MAX_PLAINTEXT_BYTES).toBeLessThan(200 * NAME_MAX * 3);
  });

  it('reads as damaged with no blob, a blob that won’t open, or the wrong chunks', () => {
    const seed = newFollowSeed();
    const channel = followChannelOf(seed);
    const blobs = sealFollow(xchachaSeal, channel, follow());
    const [header, chunk] = blobs;

    expect(openFollow(xchachaSeal, channel, [])).toBeNull();
    expect(openFollow(xchachaSeal, channel, [header ?? new Uint8Array()])).toBeNull();
    expect(openFollow(xchachaSeal, channel, [...blobs, chunk ?? new Uint8Array()])).toBeNull();
    expect(openFollow(xchachaSeal, followChannelOf(newFollowSeed()), blobs)).toBeNull();
    expect(openFollow(xchachaSeal, cardChannelOf(seed), blobs)).toBeNull();
    const garbled = stubSeal.seal(channel.mailbox, channel.key, Uint8Array.of(0xff, 0xfe));
    expect(openFollow(stubSeal, channel, [garbled])).toBeNull();
  });

  it.each([
    ['no secret', (json: Record<string, unknown>) => ({ ...json, secret: undefined })],
    ['a short secret', (json: Record<string, unknown>) => ({ ...json, secret: 'abc' })],
    [
      'a secret that isn’t canonical',
      (json: Record<string, unknown>) => ({
        ...json,
        secret: `${String(json.secret).slice(0, 42)}B`,
      }),
    ],
    [
      'an inner beside the secret, which followers never get',
      (json: Record<string, unknown>) => ({ ...json, inner: json.secret }),
    ],
    [
      'a seat beside the secret',
      (json: Record<string, unknown>) => ({ ...json, seat: { name: 'R', key: json.secret } }),
    ],
    ['no preview', (json: Record<string, unknown>) => ({ ...json, preview: undefined })],
    [
      'an empty name',
      (json: Record<string, unknown>) => ({
        ...json,
        preview: { name: '', groups: ['R'], excerpt: '' },
      }),
    ],
    [
      'a name past its cut',
      (json: Record<string, unknown>) => ({
        ...json,
        preview: { name: 'n'.repeat(NAME_MAX + 2), groups: ['R'], excerpt: '' },
      }),
    ],
    [
      'no groups',
      (json: Record<string, unknown>) => ({
        ...json,
        preview: { name: 'E', groups: [], excerpt: '' },
      }),
    ],
    [
      'a group that isn’t text',
      (json: Record<string, unknown>) => ({
        ...json,
        preview: { name: 'E', groups: [1], excerpt: '' },
      }),
    ],
    [
      'groups that aren’t a list',
      (json: Record<string, unknown>) => ({
        ...json,
        preview: { name: 'E', groups: 'R', excerpt: '' },
      }),
    ],
    [
      'an excerpt past its cut',
      (json: Record<string, unknown>) => ({
        ...json,
        preview: { name: 'E', groups: ['R'], excerpt: 'e'.repeat(EXCERPT_MAX + 2) },
      }),
    ],
    [
      'no chunks, though the log holds a genesis',
      (json: Record<string, unknown>) => ({ ...json, chunkCount: 0 }),
    ],
    ['a chunk count as text', (json: Record<string, unknown>) => ({ ...json, chunkCount: '1' })],
    ['a list for a header', () => []],
  ])('reads as damaged with %s', (_label, change) => {
    const seed = newFollowSeed();
    expect(openFollow(stubSeal, followChannelOf(seed), changed(seed, change))).toBeNull();
  });

  it('opens a header changed in nothing', () => {
    const seed = newFollowSeed();
    expect(
      openFollow(
        stubSeal,
        followChannelOf(seed),
        changed(seed, (json) => json),
      ),
    ).not.toBeNull();
  });
});

describe('a follow link (#124)', () => {
  it('is the origin, then the seed after #follow/, and reads back from any origin', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (seed) => {
        const link = followLink('https://reconcile.test', seed);
        expect(link).toBe(`https://reconcile.test/#follow/${base64url(seed)}`);
        expect(link).toMatch(/^https?:\/\/[^#]+\/#follow\/[A-Za-z0-9_-]{43}$/);
        expect(parseFollowLink(link)).toEqual(seed);
        expect(parseFollowLink(` ${link.replace('reconcile.test', 'other.example')}\n`)).toEqual(
          seed,
        );
        expect(parseFollowPayload(base64url(seed))).toEqual(seed);
      }),
    );
  });

  it.each([
    ['an invite link', `https://reconcile.test/#join/${base64url(new Uint8Array(32).fill(1))}`],
    ['a card link', `https://reconcile.test/#reconcile/${base64url(new Uint8Array(32).fill(1))}`],
    ['a bare seed, which is an invite’s', base64url(new Uint8Array(32).fill(1))],
    ['a seed one character short', `https://r.test/#follow/${'A'.repeat(42)}`],
    ['a seed whose last character isn’t canonical', `https://r.test/#follow/${'A'.repeat(42)}B`],
    ['a seed with a slash after it', `https://r.test/#follow/${'A'.repeat(43)}/x`],
    ['a route form', `https://r.test/#/follow/${'A'.repeat(43)}`],
    ['text that isn’t a link', 'follow us'],
  ])('is null for %s', (_label, text) => {
    expect(parseFollowLink(text)).toBeNull();
  });
});
