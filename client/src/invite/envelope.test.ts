import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { newGroupSecret } from '../crypto/groupKeys';
import { inviteChannelOf, newInviteSeed } from '../crypto/invite';
import { MAX_RECORD_BYTES } from '../crypto/record';
import { MAX_PLAINTEXT_BYTES, xchachaSeal } from '../crypto/seal';
import { parseRecord } from '../engine/event';
import { expiryKeyOf, resultFor } from '../engine/expiry';
import { fold, type LogRecord } from '../engine/fold';
import { folded, foldLogs, Logs } from '../test/coalitions';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog } from '../test/votes';
import {
  type ChunkEntry,
  clip,
  decodeHeader,
  encodeHeader,
  ENTRY_HEADER_BYTES,
  type Envelope,
  EXCERPT_MAX,
  MAX_COALITIONS,
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
  return {
    groupSecret: newGroupSecret(),
    epoch: 0,
    preview: PREVIEW,
    token: TOKEN,
    entries,
    cleared: [],
    coalitions: [],
  };
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
      kept: fc.constant(true as const),
    },
    { requiredKeys: ['seq', 'received', 'bytes'] },
  ),
  { minLength: 1, maxLength: 40 },
);

/** 30 days in relay minutes: how long ballots stay after a decision (#111). */
const THIRTY_DAYS = 43_200;

/** The members of the test groups below, by name. */
const VOTERS = ['Ana', 'Ben', 'Cal'] as const;

/**
 * A group of Ana, Ben and Cal that decides one Proposal for each entry of
 * `ballots`, scored 4 by the members it names, and has Ana post each one's
 * result once its deadline has passed (#111).
 */
function decided(ballots: readonly (readonly string[])[]) {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const ids = ballots.map((voters, i) => {
    const opened = log.minute;
    const id = log.propose('Ana', { title: `Proposal ${String(i + 1)}` });
    for (const voter of voters) {
      log.minute += 1;
      log.vote(voter, id, 4);
    }
    log.minute = deadlineOf(opened) + 1;
    const proposal = log.state().proposals.find((candidate) => candidate.id === id);
    if (proposal === undefined) throw new Error('Expected the Proposal to open.');
    log.result('Ana', resultFor(proposal));
    log.minute += 1;
    return id;
  });
  return { log, ids };
}

/**
 * `records` as a device keeps them once it has cleared `cleared` (#111,
 * `clearIn`): no ballot on any of them, and the one result each keeps.
 */
function withoutBallots(records: readonly LogRecord[], cleared: readonly string[]): LogRecord[] {
  return records.filter((record) => {
    const key = expiryKeyOf(record.bytes);
    return key === null || key.result || !cleared.includes(key.proposal);
  });
}

/** `envelope`, sealed under a fresh invite seed, then opened as a joiner opens it. */
function roundTrip(sent: Envelope): Envelope | null {
  const channel = inviteChannelOf(newInviteSeed());
  return openEnvelope(xchachaSeal, channel, sealEnvelope(xchachaSeal, channel, sent));
}

describe('packEntries and unpackChunk', () => {
  it('write each entry as seq (8 bytes) ‖ received (8) ‖ epoch (4) ‖ kept (1) ‖ length (4) ‖ record, big-endian (#98, #269)', () => {
    const [chunk] = packEntries([
      { seq: 0x0102, received: 0x0304, bytes: Uint8Array.of(0xaa, 0xbb), epoch: 0x0506 },
      { seq: 9, received: 8, bytes: Uint8Array.of(0xcc), kept: true },
    ]);
    expect(Array.from(chunk ?? [])).toEqual([
      0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 3, 4, 0, 0, 5, 6, 0, 0, 0, 0, 2, 0xaa, 0xbb, 0, 0,
      0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0xcc,
    ]);
    expect(ENTRY_HEADER_BYTES).toBe(25);
  });

  it('read an entry of epoch 0 back without an epoch, as the log keeps it, and one not kept without a mark', () => {
    const [chunk = new Uint8Array()] = packEntries([
      entry(1, 3),
      { ...entry(2, 3), epoch: 2 },
      { ...entry(3, 3), kept: true },
    ]);
    expect(unpackChunk(chunk)).toEqual([
      entry(1, 3),
      { ...entry(2, 3), epoch: 2 },
      { ...entry(3, 3), kept: true },
    ]);
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

  it('fit 5,000 kept results in chunks that each fit one blob, and read every mark back (#269)', () => {
    const { log } = decided([['Ana']]);
    const result = log.records.find((record) => expiryKeyOf(record.bytes)?.result === true);
    if (result === undefined) throw new Error('Expected a result.');
    const many: ChunkEntry[] = Array.from({ length: 5000 }, (_, i) => ({
      seq: i + 1,
      received: 29_000_000 + i,
      bytes: result.bytes,
      kept: true,
    }));

    const chunks = packEntries(many);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
    const read = chunks.flatMap((chunk) => unpackChunk(chunk) ?? []);
    expect(read).toHaveLength(5000);
    expect(read.every((read) => read.kept === true)).toBe(true);
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

  /**
   * One entry's header: seq 1, received 1, epoch 0, `kept`, then `length`,
   * followed by `body` bytes of record.
   */
  const raw = (length: number, body: number, kept = 0): Uint8Array => {
    const bytes = new Uint8Array(ENTRY_HEADER_BYTES + body);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 1n);
    view.setBigUint64(8, 1n);
    view.setUint8(20, kept);
    view.setUint32(21, length);
    return bytes;
  };

  it.each([
    ['an empty chunk', new Uint8Array(0)],
    ['an entry cut inside its header', raw(1, 1).subarray(0, 24)],
    ['a length that runs past the chunk', raw(9, 1)],
    ['an empty record', raw(0, 0)],
    ['a whole entry, then a stray byte', Uint8Array.of(...raw(1, 1), 0)],
    ['a kept byte that is neither 0 nor 1', raw(1, 1, 2)],
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
    expect(unpackChunk(raw(1, 1, 1))).toEqual([
      { seq: 1, received: 1, bytes: new Uint8Array(1), kept: true },
    ]);
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
  it('write the header as JSON {groupSecret, epoch, preview, token, chunkCount}, with nothing for each cleared Proposal (#269)', () => {
    const secret = newGroupSecret();
    const header = encodeHeader({
      ...envelope([]),
      groupSecret: secret,
      epoch: 2,
      chunkCount: 3,
    });
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

  it('refuse a header with cleared, as an invite made between #111 and #269 has, whose chunks carry no kept byte', () => {
    for (const cleared of [[], ['p1']]) {
      expect(decodeHeader(bytes(JSON.stringify({ ...headerJson(), cleared })))).toBeNull();
    }
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

  it('keep the header the same however many Proposals the inviter has cleared: 5,000 add nothing to it (#269)', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `${'P'.repeat(37)}${String(100_000 + i)}`);
    const header = (cleared: readonly string[]) => {
      const [first] = sealEnvelope(xchachaSeal, channel, { ...sealed, cleared });
      return xchachaSeal.open(channel.mailbox, channel.key, first ?? new Uint8Array());
    };

    expect(header(many)).toEqual(header([]));
    expect(header(many)?.length).toBeLessThan(4096);
  });

  it('mark the one result each cleared Proposal keeps, and read back exactly the cleared Proposals whose results it carries (#111, #269)', () => {
    const { log: group, ids } = decided([['Ana', 'Ben'], ['Ben'], ['Cal']]);
    const [first, , third] = ids;
    if (first === undefined || third === undefined) throw new Error('Expected three Proposals.');
    const kept = withoutBallots(group.records, [third, first]);
    const sent = { ...envelope(kept), cleared: [third, 'no-such-proposal', first] };

    const blobs = sealEnvelope(xchachaSeal, channel, sent);

    const marked = blobs
      .slice(1)
      .map((blob) => xchachaSeal.open(channel.mailbox, channel.key, blob) ?? new Uint8Array())
      .flatMap((chunk) => unpackChunk(chunk) ?? [])
      .filter((read) => read.kept === true);
    expect(marked.map((read) => expiryKeyOf(read.bytes)?.proposal)).toEqual([first, third]);
    const opened = openEnvelope(xchachaSeal, channel, blobs);
    // In log order, once each, and only those whose result the invite carries.
    expect(opened?.cleared).toEqual([first, third]);
    expect(opened?.entries).toEqual(kept);
    expect(opened?.entries.some((read) => 'kept' in read)).toBe(false);
  });

  it('refuse an entry marked kept that isn’t a signed result, which no inviter marks', () => {
    const { log: group } = decided([['Ana']]);
    const vote = group.records.find((record) => parseRecord(record.bytes)?.event.type === 'vote');
    if (vote === undefined) throw new Error('Expected a vote.');
    for (const marked of [
      { ...entry(1, 10), kept: true },
      { ...vote, kept: true },
    ] as const) {
      const header = encodeHeader({ ...sealed, chunkCount: 1 });
      const forged = [header, ...packEntries([marked])].map((plain) =>
        xchachaSeal.seal(channel.mailbox, channel.key, plain),
      );
      expect(openEnvelope(xchachaSeal, channel, forged)).toBeNull();
    }
  });
});

describe('a group’s coalitions in its invite (#279)', () => {
  const channel = inviteChannelOf(newInviteSeed());
  const group = [entry(1, 900), entry(2, 900)];
  const eastside = { secret: newGroupSecret(), entries: [entry(3, 40_000), entry(7, 40_000)] };
  const metro = { secret: newGroupSecret(), entries: [entry(4, 500)] };
  const sent = { ...envelope(group), coalitions: [eastside, metro] };
  const blobs = sealEnvelope(xchachaSeal, channel, sent);

  /** The header `blobs` carry, as JSON. */
  function headerOf(sealed: readonly Uint8Array[]): Record<string, unknown> {
    const plain = xchachaSeal.open(channel.mailbox, channel.key, sealed[0] ?? new Uint8Array());
    return JSON.parse(new TextDecoder().decode(plain ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
  }

  /** `header` and `chunks`, each sealed under the channel, as an inviter would post them. */
  function forged(header: unknown, chunks: readonly Uint8Array[] = []): Uint8Array[] {
    return [bytes(JSON.stringify(header)), ...chunks].map((plain) =>
      xchachaSeal.seal(channel.mailbox, channel.key, plain),
    );
  }

  it('carries each coalition’s log after the group’s, under its secret, and reads every one back', () => {
    const counts = [group, eastside.entries, metro.entries].map((log) => packEntries(log).length);
    expect(counts).toEqual([1, 2, 1]);
    expect(blobs).toHaveLength(1 + 4);
    expect(headerOf(blobs)).toMatchObject({
      chunkCount: 1,
      coalitions: [
        { secret: base64url(eastside.secret), chunkCount: 2 },
        { secret: base64url(metro.secret), chunkCount: 1 },
      ],
    });
    const opened = openEnvelope(xchachaSeal, channel, blobs);
    expect(opened?.entries).toEqual(group);
    expect(opened?.coalitions).toEqual([
      { secret: Uint8Array.from(eastside.secret), entries: eastside.entries },
      { secret: Uint8Array.from(metro.secret), entries: metro.entries },
    ]);
  });

  it('writes no coalitions for a group that reaches none, so its invite is as it was', () => {
    const plain = sealEnvelope(xchachaSeal, channel, envelope(group));
    expect(headerOf(plain)).not.toHaveProperty('coalitions');
    expect(openEnvelope(xchachaSeal, channel, plain)?.coalitions).toEqual([]);
  });

  it('leaves out a coalition whose log is empty, and carries at most 32', () => {
    const many = Array.from({ length: MAX_COALITIONS + 3 }, (_, i) => ({
      secret: newGroupSecret(),
      entries: [entry(10 + i, 50)],
    }));
    const empty = { secret: newGroupSecret(), entries: [] };
    const opened = roundTrip({ ...envelope(group), coalitions: [empty, ...many] });
    expect(MAX_COALITIONS).toBe(32);
    expect(opened?.coalitions.map((c) => base64url(c.secret))).toEqual(
      many.slice(0, MAX_COALITIONS).map((c) => base64url(c.secret)),
    );
  });

  it('refuses a coalition chunk missing or extra', () => {
    expect(openEnvelope(xchachaSeal, channel, blobs.slice(0, -1))).toBeNull();
    expect(openEnvelope(xchachaSeal, channel, [...blobs, blobs[1] ?? new Uint8Array()])).toBeNull();
  });

  it('refuses a list that’s empty, too long or repeats a coalition, or a secret or count that’s wrong', () => {
    const chunks = [...packEntries(group), ...packEntries(metro.entries)];
    const one = { secret: base64url(metro.secret), chunkCount: 1 };
    const base = { ...headerJson(), chunkCount: 1 };
    // The control: the same blobs with a well-formed list open.
    expect(openEnvelope(xchachaSeal, channel, forged({ ...base, coalitions: [one] }))).toBeNull();
    expect(
      openEnvelope(xchachaSeal, channel, forged({ ...base, coalitions: [one] }, chunks)),
    ).not.toBeNull();
    const tooMany = Array.from({ length: MAX_COALITIONS + 1 }, () => ({
      secret: base64url(newGroupSecret()),
      chunkCount: 1,
    }));
    for (const coalitions of [
      [],
      tooMany,
      [one, one],
      [{ ...one, secret: base64url(new Uint8Array(31)) }],
      [{ ...one, chunkCount: 0 }],
      [{ ...one, chunkCount: 1.5 }],
      ['not a coalition'],
      'not a list',
    ]) {
      expect(decodeHeader(bytes(JSON.stringify({ ...base, coalitions })))).toBeNull();
    }
  });

  it('refuses a coalition entry marked kept, since a coalition’s log keeps no result', () => {
    const header = {
      ...headerJson(),
      coalitions: [{ secret: base64url(metro.secret), chunkCount: 1 }],
    };
    const marked = packEntries([{ ...entry(4, 500), kept: true }]);
    expect(
      openEnvelope(xchachaSeal, channel, forged(header, [...packEntries(group), ...marked])),
    ).toBeNull();
  });
});

describe('a newcomer’s fold (#269)', () => {
  it('equals the inviter’s, for a Proposal cleared inside the shipped history, a coalition motion outside it, and an id it never names', () => {
    // Group A (ana, ben) passes its reconcile Proposal, which its own log holds; the coalition
    // of A and B forms; zed's motion, which only the coalition's log holds, opens in A, which
    // passes it; ana posts A's results for both.
    const R = 29_375_000;
    const logs = new Logs();
    logs.group('A', R, ['ana', 'ben']);
    const reconcile = logs.reconcile('A', R + 3, 'ana', 'A');
    logs.vote('A', R + 4, 'ana', reconcile, 4);
    logs.vote('A', R + 5, 'ben', reconcile, 4);
    const at = logs.formed(R + 10, ['A', 'B'], ['kim', 'zed']);
    const motion = logs.motion(at, 'zed');
    logs.vote('A', at + 2, 'ana', motion, 4);
    logs.vote('A', at + 3, 'ben', motion, 3);
    const owed = folded(foldLogs(logs.logs, at + 4), 'A').state;
    for (const id of [reconcile, motion]) {
      const proposal = owed.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new Error('Expected the Proposal to open in A.');
      logs.add('A', at + 4, 'ana', { type: 'result', body: resultFor(proposal) });
    }
    const now = at + 4 + THIRTY_DAYS;
    const own = withoutBallots(logs.logs.A ?? [], [reconcile, motion]);
    const cleared = [reconcile, motion, 'a Proposal no record names'];
    const inviter = foldLogs({ ...logs.logs, A: own }, now, { A: cleared });

    const opened = roundTrip({ ...envelope(own), cleared });
    if (opened === null) throw new Error('Expected the invite to open.');
    const joiner = foldLogs({ ...logs.logs, A: opened.entries }, now, { A: opened.cleared });

    expect(opened.cleared).toEqual([reconcile, motion]);
    expect(joiner).toEqual(inviter);
    const state = folded(joiner, 'A').state;
    expect(state.proposals.filter((p) => p.cleared).map((p) => p.id)).toEqual([reconcile, motion]);
  });

  it('takes no Proposal as cleared that the inviter hasn’t, though one nobody voted on keeps a result and no ballot, as a cleared one does', () => {
    const { log: group, ids } = decided([[], []]);
    const [unvoted, gone] = ids;
    if (unvoted === undefined || gone === undefined) throw new Error('Expected two Proposals.');
    const now = group.minute + THIRTY_DAYS;
    const inviter = fold(group.records, now, [], [gone]);

    const opened = roundTrip({ ...envelope(group.records), cleared: [gone] });

    expect(opened?.cleared).toEqual([gone]);
    const joiner = fold(opened?.entries ?? [], now, [], opened?.cleared);
    expect(joiner).toEqual(inviter);
    expect(joiner.proposals.map((p) => p.cleared)).toEqual([false, true]);
  });

  it('equals the inviter’s for any Proposals the inviter has cleared, and any ids it holds that no record names', () => {
    const plan = fc.record({
      proposals: fc.array(fc.record({ voters: fc.subarray([...VOTERS]), clear: fc.boolean() }), {
        minLength: 1,
        maxLength: 4,
      }),
      stale: fc.array(fc.string({ minLength: 1, maxLength: 43 }), { maxLength: 3 }),
    });
    fc.assert(
      fc.property(plan, ({ proposals, stale }) => {
        const { log: group, ids } = decided(proposals.map((p) => p.voters));
        const gone = ids.filter((_, i) => proposals[i]?.clear === true);
        const own = withoutBallots(group.records, gone);
        const now = group.minute + THIRTY_DAYS;
        const inviter = fold(own, now, [], [...stale, ...gone]);

        const opened = roundTrip({ ...envelope(own), cleared: [...stale, ...gone] });

        expect(opened?.cleared).toEqual(gone);
        expect(fold(opened?.entries ?? [], now, [], opened?.cleared)).toEqual(inviter);
      }),
      { numRuns: 50 },
    );
  });
});
