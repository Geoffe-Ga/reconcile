import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newGroupSecret } from '../crypto/groupKeys';
import { inviteChannelOf, newInviteSeed } from '../crypto/invite';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { MAX_PLAINTEXT_BYTES, xchachaSeal } from '../crypto/seal';
import type { LogRecord } from '../engine/fold';
import { authorOf } from '../test/keys';
import {
  clip,
  decodeHeader,
  encodeHeader,
  ENTRY_HEADER_BYTES,
  type Envelope,
  EXCERPT_MAX,
  NAME_MAX,
  openEnvelope,
  packEntries,
  sealEnvelope,
  unpackChunk,
} from './envelope';

const TOKEN = { by: authorOf('ana'), sig: 'A'.repeat(86) };
const PREVIEW = {
  groupName: 'Riverside Tenants',
  inviterName: 'Ana',
  documentTitle: 'House rules',
  excerpt: 'Quiet hours start at ten.',
};

/** A log entry with `size` bytes of record, every byte `fill`. */
function entry(seq: number, size: number, fill = seq % 256): LogRecord {
  return { seq, received: 29_000_000 + seq, bytes: new Uint8Array(size).fill(fill) };
}

/** An envelope holding `entries`, under a fresh group secret of epoch 0. */
function envelope(entries: readonly LogRecord[]): Envelope {
  return { groupSecret: newGroupSecret(), epoch: 0, preview: PREVIEW, token: TOKEN, entries };
}

/** JSON text as the header's bytes. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A header's JSON as an object, to change one field. */
function headerJson(): Record<string, unknown> {
  const header = encodeHeader({ ...envelope([]), chunkCount: 1 });
  return JSON.parse(new TextDecoder().decode(header)) as Record<string, unknown>;
}

const entries = fc.array(
  fc.record(
    {
      seq: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      received: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      bytes: fc.uint8Array({ minLength: 1, maxLength: 3000 }),
      epoch: fc.integer({ min: 1, max: 0xffff_ffff }),
    },
    { requiredKeys: ['seq', 'received', 'bytes'] },
  ),
  { minLength: 1, maxLength: 40 },
);

describe('packEntries and unpackChunk', () => {
  it('write each entry as seq (8 bytes) ‖ received (8) ‖ epoch (4) ‖ length (4) ‖ record, big-endian (#98)', () => {
    const [chunk] = packEntries([
      { seq: 0x0102, received: 0x0304, bytes: Uint8Array.of(0xaa, 0xbb), epoch: 0x0506 },
      { seq: 9, received: 8, bytes: Uint8Array.of(0xcc) },
    ]);
    expect(Array.from(chunk ?? [])).toEqual([
      0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 3, 4, 0, 0, 5, 6, 0, 0, 0, 2, 0xaa, 0xbb, 0, 0, 0,
      0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 1, 0xcc,
    ]);
    expect(ENTRY_HEADER_BYTES).toBe(24);
  });

  it('read an entry of epoch 0 back without an epoch, as the log keeps it', () => {
    const [chunk = new Uint8Array()] = packEntries([entry(1, 3), { ...entry(2, 3), epoch: 2 }]);
    expect(unpackChunk(chunk)).toEqual([entry(1, 3), { ...entry(2, 3), epoch: 2 }]);
  });

  it('read back every entry, in order, from chunks that each fit one blob', () => {
    fc.assert(
      fc.property(entries, (log) => {
        const chunks = packEntries(log);
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
        const read = chunks.flatMap((chunk) => unpackChunk(chunk) ?? []);
        expect(read).toEqual(log.map((e) => ({ ...e, bytes: Uint8Array.from(e.bytes) })));
      }),
      { numRuns: 50 },
    );
  });

  it('fit a record of 64,000 bytes, the largest a device makes, in one chunk with its entry', () => {
    const chunks = packEntries([entry(1, 10), entry(2, MAX_RECORD_BYTES), entry(3, 10)]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      3 * ENTRY_HEADER_BYTES + 10 + MAX_RECORD_BYTES + 10,
    ]);
    expect(unpackChunk(chunks[0] ?? new Uint8Array())?.map((e) => e.bytes.length)).toEqual([
      10,
      MAX_RECORD_BYTES,
      10,
    ]);
  });

  it('start a new chunk only when the next entry would overflow the blob', () => {
    const fits = MAX_PLAINTEXT_BYTES - 2 * ENTRY_HEADER_BYTES - 1000;
    expect(packEntries([entry(1, 1000), entry(2, fits)])).toHaveLength(1);
    expect(packEntries([entry(1, 1000), entry(2, fits + 1)])).toHaveLength(2);
  });

  it('leave out a record too large for any blob, which no device makes', () => {
    const largest = MAX_PLAINTEXT_BYTES - ENTRY_HEADER_BYTES;
    const chunks = packEntries([entry(1, 10), entry(2, largest + 1), entry(3, largest)]);
    expect(chunks.flatMap((chunk) => unpackChunk(chunk) ?? []).map((e) => e.seq)).toEqual([1, 3]);
  });

  /** One entry's header: seq 1, received 1, epoch 0, then `length`, followed by `body` bytes of record. */
  const raw = (length: number, body: number): Uint8Array => {
    const bytes = new Uint8Array(ENTRY_HEADER_BYTES + body);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 1n);
    view.setBigUint64(8, 1n);
    view.setUint32(20, length);
    return bytes;
  };

  it.each([
    ['an empty chunk', new Uint8Array(0)],
    ['an entry cut inside its header', raw(1, 1).subarray(0, 23)],
    ['a length that runs past the chunk', raw(9, 1)],
    ['an empty record', raw(0, 0)],
    ['a whole entry, then a stray byte', Uint8Array.of(...raw(1, 1), 0)],
  ])('refuse %s', (_label, chunk) => {
    expect(unpackChunk(chunk)).toBeNull();
  });

  it('refuse a seq or receipt time beyond a safe integer, or a seq of 0', () => {
    const [chunk = new Uint8Array()] = packEntries([entry(1, 4)]);
    const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset);
    const huge = Uint8Array.from(chunk);
    view(huge).setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const late = Uint8Array.from(chunk);
    view(late).setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const zero = Uint8Array.from(chunk);
    view(zero).setBigUint64(0, 0n);
    for (const bad of [huge, late, zero]) expect(unpackChunk(bad)).toBeNull();
    expect(unpackChunk(chunk)).not.toBeNull();
    expect(unpackChunk(raw(1, 1))).toEqual([{ seq: 1, received: 1, bytes: new Uint8Array(1) }]);
  });
});

describe('clip', () => {
  it('keeps text up to the limit, and cuts longer text to the limit plus “…”', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcd', 3)).toBe('abc…');
    expect(clip('ab  cd', 3)).toBe('ab…');
  });

  it('counts code points, so it never splits a character in two', () => {
    expect(clip('😀😀😀😀', 3)).toBe('😀😀😀…');
  });
});

describe('encodeHeader and decodeHeader', () => {
  it('write the header as JSON {groupSecret, epoch, preview, token, chunkCount}', () => {
    const secret = newGroupSecret();
    const header = encodeHeader({ ...envelope([]), groupSecret: secret, epoch: 2, chunkCount: 3 });
    expect(JSON.parse(new TextDecoder().decode(header))).toEqual({
      groupSecret: base64url(secret),
      epoch: 2,
      preview: PREVIEW,
      token: TOKEN,
      chunkCount: 3,
    });
  });

  it('read back what they wrote', () => {
    const written = { ...envelope([]), epoch: 1, chunkCount: 2 };
    const read = decodeHeader(encodeHeader(written));
    expect(read).toEqual({
      groupSecret: Uint8Array.from(written.groupSecret),
      epoch: 1,
      preview: PREVIEW,
      token: TOKEN,
      chunkCount: 2,
    });
  });

  it('cut each preview field to its limit, so a long name or section never grows the header', () => {
    const long = 'x'.repeat(5000);
    const header = encodeHeader({
      ...envelope([]),
      preview: { groupName: long, inviterName: long, documentTitle: long, excerpt: long },
      chunkCount: 1,
    });
    const read = decodeHeader(header);
    expect(read?.preview).toEqual({
      groupName: clip(long, NAME_MAX),
      inviterName: clip(long, NAME_MAX),
      documentTitle: clip(long, NAME_MAX),
      excerpt: clip(long, EXCERPT_MAX),
    });
    expect([NAME_MAX, EXCERPT_MAX]).toEqual([120, 280]);
    expect(header.length).toBeLessThan(4096);
  });

  it('keep the preview’s text exactly, markup and all, as plain data', () => {
    const preview = {
      groupName: '<img src=x onerror=alert(1)>',
      inviterName: '‮nimdA',
      documentTitle: '**House** rules',
      excerpt: '<script>alert(1)</script> [x](javascript:alert(1))',
    };
    const read = decodeHeader(encodeHeader({ ...envelope([]), preview, chunkCount: 1 }));
    expect(read?.preview).toEqual(preview);
  });

  it.each([
    ['bytes that aren’t UTF-8', Uint8Array.of(0xff, 0xfe)],
    ['text that isn’t JSON', bytes('{"groupSecret"')],
    ['JSON that isn’t an object', bytes('[1,2]')],
    ['an empty object', bytes('{}')],
  ])('refuse %s', (_label, header) => {
    expect(decodeHeader(header)).toBeNull();
  });

  const secret = base64url(newGroupSecret());
  it.each([
    ['a group secret of 31 bytes', { groupSecret: base64url(new Uint8Array(31)) }],
    ['a group secret with stray bits', { groupSecret: `${'A'.repeat(42)}B` }],
    ['a group secret that isn’t base64url', { groupSecret: `${secret.slice(0, 42)}+` }],
    ['a group secret that isn’t text', { groupSecret: 7 }],
    ['no preview', { preview: null }],
    ['a preview field that isn’t text', { preview: { ...PREVIEW, inviterName: 7 } }],
    ['a preview missing a field', { preview: { ...PREVIEW, excerpt: undefined } }],
    ['a group name over its limit', { preview: { ...PREVIEW, groupName: 'x'.repeat(122) } }],
    ['an inviter name over its limit', { preview: { ...PREVIEW, inviterName: 'x'.repeat(122) } }],
    ['a title over its limit', { preview: { ...PREVIEW, documentTitle: 'x'.repeat(122) } }],
    ['an excerpt over its limit', { preview: { ...PREVIEW, excerpt: 'x'.repeat(282) } }],
    ['no token', { token: null }],
    ['a token whose key is cut short', { token: { ...TOKEN, by: TOKEN.by.slice(1) } }],
    ['a token whose signature is cut short', { token: { ...TOKEN, sig: TOKEN.sig.slice(1) } }],
    ['no chunks', { chunkCount: 0 }],
    ['a chunk count that isn’t whole', { chunkCount: 1.5 }],
    ['a chunk count that isn’t a number', { chunkCount: '1' }],
    ['no epoch, as an invite made before #98 has', { epoch: undefined }],
    ['an epoch that isn’t whole', { epoch: 0.5 }],
    ['a negative epoch', { epoch: -1 }],
    ['an epoch past u32', { epoch: 2 ** 32 }],
  ])('refuse a header with %s', (_label, change) => {
    expect(decodeHeader(bytes(JSON.stringify({ ...headerJson(), ...change })))).toBeNull();
  });

  it('accept a field at exactly its limit plus the “…”', () => {
    const preview = { ...PREVIEW, groupName: 'x'.repeat(121), excerpt: 'x'.repeat(281) };
    expect(decodeHeader(bytes(JSON.stringify({ ...headerJson(), preview })))?.preview).toEqual(
      preview,
    );
  });
});

describe('sealEnvelope and openEnvelope', () => {
  const seed = newInviteSeed();
  const channel = inviteChannelOf(seed);
  const log = [entry(1, 900), entry(2, 40_000), entry(5, 40_000), entry(9, 64_000)];
  const sealed = envelope(log);
  const blobs = sealEnvelope(xchachaSeal, channel, sealed);

  it('seal a header blob, then one blob per chunk, each opening only under the invite key', () => {
    expect(blobs).toHaveLength(1 + packEntries(log).length);
    const opened = openEnvelope(xchachaSeal, channel, blobs);
    expect(opened).toEqual({ ...sealed, groupSecret: Uint8Array.from(sealed.groupSecret) });
    const header = xchachaSeal.open(channel.mailbox, channel.key, blobs[0] ?? new Uint8Array());
    expect(decodeHeader(header ?? new Uint8Array())?.chunkCount).toBe(blobs.length - 1);
  });

  it('carry no readable byte of the secret, the preview or the records', () => {
    // Canaries long enough that random ciphertext can't spell one by chance, as "Ana" could.
    const preview = {
      groupName: 'CANARY-GROUP-NAME-7f3a9c',
      inviterName: 'CANARY-INVITER-NAME-7f3a9c',
      documentTitle: 'CANARY-DOCUMENT-TITLE-7f3a9c',
      excerpt: 'CANARY-EXCERPT-7f3a9c',
    };
    const record = new TextEncoder().encode('CANARY-RECORD-BYTES-7f3a9c');
    const secret = newGroupSecret();
    const canaryBlobs = sealEnvelope(xchachaSeal, channel, {
      ...sealed,
      groupSecret: secret,
      preview,
      entries: [{ seq: 1, received: 1, bytes: record }],
    });
    const plain = [base64url(secret), ...Object.values(preview), 'CANARY-RECORD-BYTES-7f3a9c'];
    for (const blob of canaryBlobs) {
      const text = new TextDecoder('latin1').decode(blob);
      for (const word of plain) expect(text).not.toContain(word);
    }
    expect(openEnvelope(xchachaSeal, channel, canaryBlobs)?.preview).toEqual(preview);
  });

  it('refuse an empty mailbox, as an expired invite leaves', () => {
    expect(openEnvelope(xchachaSeal, channel, [])).toBeNull();
  });

  it('refuse a missing chunk, an extra blob, or blobs out of order', () => {
    const [header, ...chunks] = blobs;
    if (header === undefined) throw new Error('Expected a header.');
    expect(openEnvelope(xchachaSeal, channel, blobs.slice(0, -1))).toBeNull();
    expect(openEnvelope(xchachaSeal, channel, [...blobs, chunks[0] ?? header])).toBeNull();
    expect(openEnvelope(xchachaSeal, channel, [...chunks, header])).toBeNull();
  });

  it('refuse a blob with any byte changed', () => {
    fc.assert(
      fc.property(fc.nat({ max: blobs.length - 1 }), fc.nat({ max: 65_535 }), (which, at) => {
        const tampered = blobs.map((blob) => Uint8Array.from(blob));
        const blob = tampered[which] ?? new Uint8Array();
        blob[at % blob.length] = (blob[at % blob.length] ?? 0) ^ 0x01;
        expect(openEnvelope(xchachaSeal, channel, tampered)).toBeNull();
      }),
      { numRuns: 30 },
    );
  });

  it('refuse a blob cut short', () => {
    const cut = blobs.map((blob, i) => (i === 1 ? blob.subarray(0, 4096) : blob));
    expect(openEnvelope(xchachaSeal, channel, cut)).toBeNull();
  });

  it('open under no other seed, and never under the group’s own key', () => {
    expect(openEnvelope(xchachaSeal, inviteChannelOf(newInviteSeed()), blobs)).toBeNull();
    const asGroup = { mailbox: channel.mailbox, key: sealed.groupSecret };
    expect(openEnvelope(xchachaSeal, asGroup, blobs)).toBeNull();
  });

  it('refuse a chunk sealed with a valid key that holds no entries', () => {
    const header = encodeHeader({ ...sealed, chunkCount: 1 });
    const forged = [header, Uint8Array.of(1, 2, 3)].map((plain) =>
      xchachaSeal.seal(channel.mailbox, channel.key, plain),
    );
    expect(openEnvelope(xchachaSeal, channel, forged)).toBeNull();
  });

  it('refuse a header the key opens but that doesn’t parse', () => {
    const forged = [bytes('not a header'), ...packEntries(log)].map((plain) =>
      xchachaSeal.seal(channel.mailbox, channel.key, plain),
    );
    expect(openEnvelope(xchachaSeal, channel, forged)).toBeNull();
  });
});
