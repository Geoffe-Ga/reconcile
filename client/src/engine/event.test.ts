import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { signRecord } from '../crypto/record';
import { EVENT_CONTEXT, publicKeyOf, sign } from '../crypto/sign';
import { concat } from '../test/bytes';
import { authorOf, testKeys } from '../test/keys';
import { LEVELS } from './capabilities';
import {
  base64url,
  createEvent,
  decodeEvent,
  type EventInput,
  eventId,
  fromBase64url,
  parseEvent,
  parseRecord,
  signEvent,
} from './event';

const encoder = new TextEncoder();

/** Two members' author keys: 32-byte public keys in base64url. */
const ANA = authorOf('ana');
const BEN = authorOf('ben');

/** UTF-8 bytes of `text`. */
function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** UTF-8 bytes of a JSON value, serialized once. */
function json(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}

const PROPOSAL: EventInput = {
  type: 'proposal',
  group: 'g1',
  author: ANA,
  ts: 1762650000000,
  body: { atom: 'g1.0', title: 'Quiet hours', why: 'Sleep.', text: 'Quiet after 10pm.' },
};

/** A valid v1 envelope around `body`, for shape tests. */
function envelope(type: string, body: unknown, overrides: Record<string, unknown> = {}): unknown {
  return { v: 1, type, group: 'g1', author: ANA, ts: 1, body, ...overrides };
}

describe('base64url', () => {
  it('uses the URL-safe alphabet without padding', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64url(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
    expect(base64url(new Uint8Array([]))).toBe('');
  });
});

/** SHA-256 by the platform's WebCrypto: an implementation independent of @noble/hashes. */
async function platformSha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

describe('eventId', () => {
  it('starts like the FIPS 180-2 digest of "abc" (ba7816bf8f01…) in base64url', () => {
    expect(eventId(utf8('abc')).slice(0, 8)).toBe('ungWv48B');
  });

  it('is the unpadded base64url SHA-256 of the exact bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), async (bytes) => {
        const id = eventId(bytes);
        expect(id).toBe(base64url(await platformSha256(bytes)));
        expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }),
    );
  });

  it('changes when one byte changes', () => {
    expect(eventId(utf8('{"a":1}'))).not.toBe(eventId(utf8('{"a": 1}')));
  });
});

describe('createEvent', () => {
  it('serializes {v, type, group, author, ts, body} once, in that order', () => {
    const { bytes } = createEvent(PROPOSAL);
    expect(new TextDecoder().decode(bytes)).toBe(
      `{"v":1,"type":"proposal","group":"g1","author":"${ANA}","ts":1762650000000,` +
        '"body":{"atom":"g1.0","title":"Quiet hours","why":"Sleep.","text":"Quiet after 10pm."}}',
    );
  });

  it('returns the id of exactly the bytes it returns', () => {
    const { bytes, id } = createEvent(PROPOSAL);
    expect(id).toBe(eventId(bytes));
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('NFC-normalizes every string in the body, nested ones included', () => {
    const { bytes } = createEvent({
      type: 'genesis',
      group: '',
      author: ANA,
      ts: 0,
      body: { name: 'Cafe\u0301', founder: 'Jose\u0301', title: 'T', atoms: ['e\u0301te\u0301'] },
    });
    const parsed = parseEvent(bytes);
    expect(parsed?.event.body).toEqual({
      name: 'Caf\u00e9',
      founder: 'Jos\u00e9',
      title: 'T',
      atoms: ['\u00e9t\u00e9'],
    });
  });

  it('round-trips through parseEvent with the same id', () => {
    const vote: EventInput = {
      type: 'vote',
      group: 'g1',
      author: BEN,
      ts: 5,
      body: { proposal: 'p1', scores: { p1: 0 }, note: 'Too loud a change.' },
    };
    const { bytes, id } = createEvent(vote);
    expect(parseEvent(bytes)).toEqual({ event: { v: 1, ...vote }, id });
  });

  it('NFC-normalizes a version’s text, and round-trips it with the same id', () => {
    const version: EventInput = {
      type: 'version',
      group: 'g1',
      author: BEN,
      ts: 6,
      body: { proposal: 'p1', text: 'Café closes at 11.\n' },
    };
    const { bytes, id } = createEvent(version);
    expect(parseEvent(bytes)).toEqual({
      event: { v: 1, ...version, body: { proposal: 'p1', text: 'Café closes at 11.\n' } },
      id,
    });
  });

  it('round-trips any valid event (property)', () => {
    const text = fc.string({ unit: 'grapheme', maxLength: 20 });
    const input = fc.record({
      group: fc.string({ maxLength: 10 }),
      author: fc.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      ts: fc.nat(),
      body: fc.record(
        { atom: text, title: text, why: text, text, link: text },
        { requiredKeys: ['atom', 'title', 'why', 'text'] },
      ),
    });
    fc.assert(
      fc.property(input, (fields) => {
        const { bytes, id } = createEvent({ type: 'proposal', ...fields });
        const parsed = parseEvent(bytes);
        expect(parsed?.id).toBe(id);
        expect(createEvent({ type: 'proposal', ...fields }).id).toBe(id);
        expect(parsed?.event.body).toEqual(
          JSON.parse(JSON.stringify(fields.body).normalize('NFC')) as unknown,
        );
      }),
    );
  });
});

describe('parseEvent', () => {
  it('returns the event and the id of its bytes', () => {
    const bytes = json(envelope('join', { name: 'Ben' }));
    expect(parseEvent(bytes)).toEqual({
      event: { v: 1, type: 'join', group: 'g1', author: ANA, ts: 1, body: { name: 'Ben' } },
      id: eventId(bytes),
    });
  });

  it('keeps an unknown envelope version, so the fold can ignore it', () => {
    const parsed = parseEvent(json(envelope('join', { name: 'Ben' }, { v: 2 })));
    expect(parsed?.event.v).toBe(2);
  });

  it('keeps optional fields and drops unknown body keys', () => {
    const genesis = parseEvent(
      json(
        envelope('genesis', { name: 'G', chat: 'https://c', founder: 'A', title: 'T', atoms: [] }),
      ),
    );
    expect(genesis?.event.body).toEqual({
      name: 'G',
      chat: 'https://c',
      founder: 'A',
      title: 'T',
      atoms: [],
    });
    const join = parseEvent(json(envelope('join', { name: 'Ben', token: 'later' })));
    expect(join?.event.body).toEqual({ name: 'Ben' });
    const level = parseEvent(json(envelope('level', { level: 'steward', name: 'Ben' })));
    expect(level?.event.body).toEqual({ level: 'steward' });
  });

  it('keeps a genesis’s rules as written, so the fold checks them against the defaults', () => {
    const rules = { bars: { entrenched: { avgAtLeast: 1 } }, unknown: ['kept'] };
    const body = { name: 'G', founder: 'A', title: 'T', atoms: [], rules };
    expect(parseEvent(json(envelope('genesis', body)))?.event.body).toEqual(body);
  });

  it('keeps a join’s level as written, known or not, so the fold decides', () => {
    for (const level of [...LEVELS, 'admin', '']) {
      const parsed = parseEvent(json(envelope('join', { name: 'Ben', level })));
      expect(parsed?.event).toMatchObject({ type: 'join', body: { name: 'Ben', level } });
    }
  });

  it('reads a level event, whose body names the level its author chooses', () => {
    const [, middle] = LEVELS;
    const bytes = json(envelope('level', { level: middle }));
    expect(parseEvent(bytes)).toEqual({
      event: { v: 1, type: 'level', group: 'g1', author: ANA, ts: 1, body: { level: middle } },
      id: eventId(bytes),
    });
  });

  it.each([
    ['genesis', { name: 'G', founder: 'A', title: 'T', atoms: [] }],
    ['join', { name: 'Ben' }],
    ['proposal', { atom: 'a', title: 't', why: 'w', text: 'x' }],
    ['vote', { proposal: 'p', scores: {} }],
    ['version', { proposal: 'p', text: 'x' }],
  ])('leaves an absent optional field absent on a %s', (type, body) => {
    const parsed = parseEvent(json(envelope(type, body)));
    expect(Object.keys(parsed?.event.body ?? { missing: true })).toEqual(Object.keys(body));
  });

  it('rejects invalid UTF-8 even inside a JSON string, rather than replacing it', () => {
    const text = JSON.stringify(envelope('join', { name: 'Ben' }));
    const [before, after] = text.split('Ben');
    const bytes = new Uint8Array([...utf8(String(before)), 0xff, ...utf8(String(after))]);
    expect(parseEvent(bytes)).toBeNull();
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['a byte-order mark', utf8('\uFEFF' + JSON.stringify(envelope('join', { name: 'Ben' })))],
    ['bad JSON', utf8('{"v":1,')],
    ['an array', json([1])],
    ['null', json(null)],
    ['a number', json(1)],
  ])('returns null for %s', (_label, bytes) => {
    expect(parseEvent(bytes)).toBeNull();
  });

  it.each([
    ['v as a string', { v: '1' }],
    ['v as a fraction', { v: 1.5 }],
    ['a missing group', { group: undefined }],
    ['a numeric group', { group: 7 }],
    ['an empty author', { author: '' }],
    ['an author outside base64url', { author: `${ANA.slice(1)} ` }],
    ['a 42-character author', { author: ANA.slice(1) }],
    ['a 44-character author', { author: `${ANA}A` }],
    ['a fractional ts', { ts: 1.5 }],
    ['a negative ts', { ts: -1 }],
    ['a string ts', { ts: '1' }],
    ['an unknown type', { type: 'leave' }],
    ['a missing type', { type: undefined }],
    ['an array body', { body: [] }],
    ['a null body', { body: null }],
  ])('returns null for %s', (_label, overrides) => {
    expect(parseEvent(json(envelope('join', { name: 'Ben' }, overrides)))).toBeNull();
  });

  it.each([
    ['genesis without atoms', 'genesis', { name: 'G', founder: 'A', title: 'T' }],
    ['genesis with a numeric Atom', 'genesis', { name: 'G', founder: 'A', title: 'T', atoms: [1] }],
    [
      'genesis with atoms not a list',
      'genesis',
      { name: 'G', founder: 'A', title: 'T', atoms: 'x' },
    ],
    [
      'genesis with a null chat',
      'genesis',
      { name: 'G', chat: null, founder: 'A', title: 'T', atoms: [] },
    ],
    [
      'genesis with null rules',
      'genesis',
      { name: 'G', founder: 'A', title: 'T', atoms: [], rules: null },
    ],
    [
      'genesis with a list of rules',
      'genesis',
      { name: 'G', founder: 'A', title: 'T', atoms: [], rules: [] },
    ],
    [
      'genesis with rules as text',
      'genesis',
      { name: 'G', founder: 'A', title: 'T', atoms: [], rules: 'defaults' },
    ],
    ['genesis without a founder', 'genesis', { name: 'G', title: 'T', atoms: [] }],
    ['genesis without a name', 'genesis', { founder: 'A', title: 'T', atoms: [] }],
    ['genesis without a title', 'genesis', { name: 'G', founder: 'A', atoms: [] }],
    ['join without a name', 'join', {}],
    ['join with a numeric level', 'join', { name: 'Ben', level: 2 }],
    ['join with a null level', 'join', { name: 'Ben', level: null }],
    ['level without a level', 'level', {}],
    ['level with a list of levels', 'level', { level: ['admin'] }],
    ['proposal without text', 'proposal', { atom: 'a', title: 't', why: 'w' }],
    ['proposal without an atom', 'proposal', { title: 't', why: 'w', text: 'x' }],
    ['proposal without a title', 'proposal', { atom: 'a', why: 'w', text: 'x' }],
    ['proposal without a why', 'proposal', { atom: 'a', title: 't', text: 'x' }],
    [
      'proposal with a string window',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', window: '7' },
    ],
    [
      'proposal with a null window',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', window: null },
    ],
    [
      'proposal with a numeric link',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', link: 1 },
    ],
    ['vote without scores', 'vote', { proposal: 'p' }],
    ['vote without a proposal', 'vote', { scores: { p: 1 } }],
    ['vote with a list of scores', 'vote', { proposal: 'p', scores: [1] }],
    ['vote with a score of 5', 'vote', { proposal: 'p', scores: { p: 5 } }],
    ['vote with a score of -1', 'vote', { proposal: 'p', scores: { p: -1 } }],
    ['vote with a fractional score', 'vote', { proposal: 'p', scores: { p: 2.5 } }],
    ['vote with a string score', 'vote', { proposal: 'p', scores: { p: '3' } }],
    ['vote with a numeric note', 'vote', { proposal: 'p', scores: { p: 3 }, note: 3 }],
    ['version without a proposal', 'version', { text: 'x' }],
    ['version without text', 'version', { proposal: 'p' }],
    ['version with a numeric proposal', 'version', { proposal: 1, text: 'x' }],
    ['version with null text', 'version', { proposal: 'p', text: null }],
  ])('returns null for %s', (_label, type, body) => {
    expect(parseEvent(json(envelope(type, body)))).toBeNull();
  });

  it('accepts every score from 0 to 4', () => {
    const parsed = parseEvent(
      json(envelope('vote', { proposal: 'p', scores: { a: 0, b: 1, c: 2, d: 3, e: 4 } })),
    );
    expect(parsed?.event.body).toEqual({
      proposal: 'p',
      scores: { a: 0, b: 1, c: 2, d: 3, e: 4 },
    });
  });

  it('keeps a "__proto__" score key as data, never as a prototype', () => {
    const parsed = decodeEvent(
      utf8(
        JSON.stringify(envelope('vote', { proposal: 'p', scores: {} })).replace(
          '"scores":{}',
          '"scores":{"__proto__":3}',
        ),
      ),
    );
    expect(parsed?.type).toBe('vote');
    const scores = parsed?.type === 'vote' ? parsed.body.scores : {};
    expect(Object.getPrototypeOf(scores)).toBe(Object.prototype);
    expect(Object.entries(scores)).toEqual([['__proto__', 3]]);
  });

  it('reads a version as its Proposal and text, dropping unknown keys', () => {
    const version = parseEvent(
      json(envelope('version', { proposal: 'p1', text: 'Quiet after 11pm.\n', title: 'no' })),
    );
    expect(version?.event).toEqual({
      v: 1,
      type: 'version',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { proposal: 'p1', text: 'Quiet after 11pm.\n' },
    });
  });

  it('keeps optional proposal and vote fields', () => {
    const proposal = parseEvent(
      json(envelope('proposal', { atom: 'a', title: 't', why: 'w', text: 'x', link: 'https://l' })),
    );
    expect(proposal?.event.body).toEqual({
      atom: 'a',
      title: 't',
      why: 'w',
      text: 'x',
      link: 'https://l',
    });
    const vote = parseEvent(json(envelope('vote', { proposal: 'p', scores: {}, note: 'n' })));
    expect(vote?.event.body).toEqual({ proposal: 'p', scores: {}, note: 'n' });
  });

  it('keeps a proposal’s numeric window as written, even a fraction, for the fold to check (#106)', () => {
    const body = { atom: 'a', title: 't', why: 'w', text: 'x' };
    for (const window of [10, 7.5, 0]) {
      const parsed = parseEvent(json(envelope('proposal', { ...body, window })));
      expect(parsed?.event.body).toEqual({ ...body, window });
    }
    const without = parseEvent(json(envelope('proposal', body)));
    expect(without?.event.body).toEqual(body);
  });
});

describe('fromBase64url', () => {
  it('reads the URL-safe alphabet, with or without padding', () => {
    expect([...fromBase64url('-_8')]).toEqual([0xfb, 0xff]);
    expect([...fromBase64url('Zm9v')]).toEqual([0x66, 0x6f, 0x6f]);
    expect([...fromBase64url('Zm8=')]).toEqual([0x66, 0x6f]);
    expect([...fromBase64url('')]).toEqual([]);
  });

  it('undoes base64url (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect([...fromBase64url(base64url(bytes))]).toEqual([...bytes]);
      }),
    );
  });
});

const JOIN = { type: 'join', group: 'g1', ts: 5, body: { name: 'Ben' } } as const;

describe('signEvent', () => {
  it('writes the key’s public half as the author, and signs the exact bytes', () => {
    const { secretKey } = testKeys('ben');
    const publicKey = publicKeyOf(secretKey);
    const signed = signEvent(secretKey, JOIN);
    const { bytes, id } = createEvent({ ...JOIN, author: BEN });
    expect(BEN).toBe(base64url(publicKey));
    expect(signed.bytes).toEqual(bytes);
    expect(signed.id).toBe(id);
    expect([...signed.record]).toEqual([
      ...concat(publicKey, sign(EVENT_CONTEXT, secretKey, bytes), bytes),
    ]);
  });

  it('signs the same draft to the same record every time', () => {
    const { secretKey } = testKeys('ben');
    expect(base64url(signEvent(secretKey, JOIN).record)).toBe(
      base64url(signEvent(secretKey, JOIN).record),
    );
  });
});

describe('parseRecord', () => {
  const { record, bytes, id } = signEvent(testKeys('ben').secretKey, JOIN);

  it('reads a record its author signed into the event and its id', () => {
    expect(parseRecord(record)).toEqual({ event: { v: 1, author: BEN, ...JOIN }, id });
  });

  it('refuses a record whose signature fails, before reading it', () => {
    const forged = Uint8Array.from(record);
    forged[50] = (forged[50] ?? 0) ^ 0x01;
    expect(parseRecord(forged)).toBeNull();
  });

  it('refuses a valid signature by a key that isn’t the event’s author', () => {
    const anaKeys = { publicKey: fromBase64url(ANA), secretKey: testKeys('ana').secretKey };
    expect(parseRecord(signRecord(anaKeys, bytes))).toBeNull();
  });

  it('refuses validly signed bytes that aren’t an event', () => {
    const benKeys = { publicKey: fromBase64url(BEN), secretKey: testKeys('ben').secretKey };
    expect(parseRecord(signRecord(benKeys, utf8('{"v":1,')))).toBeNull();
  });

  it('refuses bare event bytes, with no key or signature', () => {
    expect(parseRecord(bytes)).toBeNull();
  });
});
