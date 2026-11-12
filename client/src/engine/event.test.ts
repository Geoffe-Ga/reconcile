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
  isAddProposal,
  isCoalitionGenesis,
  isDissolveProposal,
  isAdmitProposal,
  isClassProposal,
  isMoveProposal,
  isNewDocumentProposal,
  isReconcileProposal,
  isRemovalProposal,
  isSealedReconcileProposal,
  isRulesProposal,
  isStewardProposal,
  parseEvent,
  parseRecord,
  signEvent,
  isPriorityProposal,
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

/** A well-formed result body: one version, two ballots, a pass. */
const RESULT = {
  proposal: 'p',
  closedAt: 29_375_100,
  eligible: 2,
  versions: [{ id: 'p', counts: [0, 0, 0, 1, 1] }],
  outcome: { kind: 'pass', version: 'p' },
  commit: 'the-ballot-commitment',
};

const PROPOSAL: EventInput = {
  type: 'proposal',
  group: 'g1',
  author: ANA,
  ts: 1762650000000,
  body: { atom: 'g1.0', title: 'Quiet hours', why: 'Sleep.', text: 'Quiet after 10pm.' },
};

/** A genesis's Documents (#92), for shape tests: one, with no Atoms, which the fold checks. */
const DOCS = [{ title: 'T', atoms: [] }];

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
      body: {
        name: 'Cafe\u0301',
        founder: 'Jose\u0301',
        documents: [{ title: 'Re\u0301gles', atoms: ['e\u0301te\u0301'] }],
      },
    });
    const parsed = parseEvent(bytes);
    expect(parsed?.event.body).toEqual({
      name: 'Caf\u00e9',
      founder: 'Jos\u00e9',
      documents: [{ title: 'R\u00e9gles', atoms: ['\u00e9t\u00e9'] }],
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
        {
          atom: text,
          title: text,
          why: text,
          text,
          link: text,
          dispatch: fc.record({ title: text, text }),
        },
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
      json(envelope('genesis', { name: 'G', chat: 'https://c', founder: 'A', documents: DOCS })),
    );
    expect(genesis?.event.body).toEqual({
      name: 'G',
      chat: 'https://c',
      founder: 'A',
      documents: DOCS,
    });
    const join = parseEvent(json(envelope('join', { name: 'Ben', token: 'later' })));
    expect(join?.event.body).toEqual({ name: 'Ben' });
    const level = parseEvent(json(envelope('level', { level: 'steward', name: 'Ben' })));
    expect(level?.event.body).toEqual({ level: 'steward' });
  });

  it('keeps a genesis’s rules as written, so the fold checks them against the defaults', () => {
    const rules = { bars: { entrenched: { avgAtLeast: 1 } }, unknown: ['kept'] };
    const body = { name: 'G', founder: 'A', documents: DOCS, rules };
    expect(parseEvent(json(envelope('genesis', body)))?.event.body).toEqual(body);
  });

  it('reads a genesis’s Documents in order, each as its title and Atoms alone (#92)', () => {
    const documents = [
      { title: 'Mission statement', atoms: ['We share.\n'], id: 'mine', extra: 1 },
      { title: 'House rules', atoms: ['Quiet after 11pm.\n', 'No pets.\n'] },
    ];
    const body = { name: 'G', founder: 'A', documents };
    expect(parseEvent(json(envelope('genesis', body)))?.event.body).toEqual({
      name: 'G',
      founder: 'A',
      documents: [
        { title: 'Mission statement', atoms: ['We share.\n'] },
        { title: 'House rules', atoms: ['Quiet after 11pm.\n', 'No pets.\n'] },
      ],
    });
  });

  it('keeps a genesis with no Documents, or a blank title, for the fold to refuse (#92)', () => {
    for (const documents of [[], [{ title: '', atoms: ['x'] }], [{ title: 'T', atoms: [] }]]) {
      const body = { name: 'G', founder: 'A', documents };
      expect(parseEvent(json(envelope('genesis', body)))?.event.body).toEqual(body);
    }
  });

  it('keeps a well-shaped invite token on a join, and drops any other, keeping the join', () => {
    const token = { by: ANA, sig: 'S'.repeat(86) };
    const kept = parseEvent(json(envelope('join', { name: 'Ben', token })));
    expect(kept?.event.body).toEqual({ name: 'Ben', token });
    for (const bad of [
      { by: ANA, sig: 'S'.repeat(85) },
      { by: ANA, sig: `${'S'.repeat(85)}+` },
      { by: ANA.slice(1), sig: token.sig },
      { by: ANA, sig: 7 },
      { by: ANA },
      [ANA, token.sig],
      null,
      'Ana sent me',
    ]) {
      const parsed = parseEvent(json(envelope('join', { name: 'Ben', token: bad })));
      expect(parsed?.event.body, JSON.stringify(bad)).toEqual({ name: 'Ben' });
    }
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

  it('reads a leave, whose body carries nothing, and drops any field a body adds', () => {
    for (const body of [{}, { reason: 'moving away' }]) {
      const bytes = json(envelope('leave', body));
      expect(parseEvent(bytes)).toEqual({
        event: { v: 1, type: 'leave', group: 'g1', author: ANA, ts: 1, body: {} },
        id: eventId(bytes),
      });
    }
  });

  it.each([
    ['genesis', { name: 'G', founder: 'A', documents: DOCS }],
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
    ['an unknown type', { type: 'no-such-type' }],
    ['a missing type', { type: undefined }],
    ['an array body', { body: [] }],
    ['a null body', { body: null }],
  ])('returns null for %s', (_label, overrides) => {
    expect(parseEvent(json(envelope('join', { name: 'Ben' }, overrides)))).toBeNull();
  });

  it.each([
    ['genesis without documents', 'genesis', { name: 'G', founder: 'A' }],
    [
      'genesis with a title and Atoms but no documents (#92)',
      'genesis',
      { name: 'G', founder: 'A', title: 'T', atoms: ['One.'] },
    ],
    ['genesis whose documents are no list', 'genesis', { name: 'G', founder: 'A', documents: {} }],
    [
      'genesis with a Document that is text',
      'genesis',
      { name: 'G', founder: 'A', documents: ['T'] },
    ],
    [
      'genesis with a Document without atoms',
      'genesis',
      { name: 'G', founder: 'A', documents: [{ title: 'T' }] },
    ],
    [
      'genesis with a Document without a title',
      'genesis',
      { name: 'G', founder: 'A', documents: [{ atoms: [] }] },
    ],
    [
      'genesis with a numeric Document title',
      'genesis',
      { name: 'G', founder: 'A', documents: [{ title: 1, atoms: [] }] },
    ],
    [
      'genesis with a numeric Atom',
      'genesis',
      { name: 'G', founder: 'A', documents: [{ title: 'T', atoms: [1] }] },
    ],
    [
      'genesis with atoms not a list',
      'genesis',
      { name: 'G', founder: 'A', documents: [{ title: 'T', atoms: 'x' }] },
    ],
    [
      'genesis with one good Document and one bad',
      'genesis',
      { name: 'G', founder: 'A', documents: [...DOCS, { title: 'T', atoms: [null] }] },
    ],
    [
      'genesis with a null chat',
      'genesis',
      { name: 'G', chat: null, founder: 'A', documents: DOCS },
    ],
    [
      'genesis with null rules',
      'genesis',
      { name: 'G', founder: 'A', documents: DOCS, rules: null },
    ],
    [
      'genesis with a list of rules',
      'genesis',
      { name: 'G', founder: 'A', documents: DOCS, rules: [] },
    ],
    [
      'genesis with rules as text',
      'genesis',
      { name: 'G', founder: 'A', documents: DOCS, rules: 'defaults' },
    ],
    ['genesis without a founder', 'genesis', { name: 'G', documents: DOCS }],
    ['genesis without a name', 'genesis', { founder: 'A', documents: DOCS }],
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
    ['vote with a numeric salt', 'vote', { proposal: 'p', scores: { p: 3 }, salt: 7 }],
    ['result without a commit', 'result', { ...RESULT, commit: undefined }],
    ['result with a fractional closedAt', 'result', { ...RESULT, closedAt: 1.5 }],
    ['result with a negative eligible count', 'result', { ...RESULT, eligible: -1 }],
    ['result with versions that aren’t a list', 'result', { ...RESULT, versions: {} }],
    [
      'result with four counts',
      'result',
      { ...RESULT, versions: [{ id: 'p', counts: [0, 0, 0, 1] }] },
    ],
    [
      'result with a negative count',
      'result',
      { ...RESULT, versions: [{ id: 'p', counts: [0, 0, 0, 0, -1] }] },
    ],
    [
      'result with a fractional count',
      'result',
      { ...RESULT, versions: [{ id: 'p', counts: [0, 0, 0, 0, 0.5] }] },
    ],
    [
      'result with a version without an id',
      'result',
      { ...RESULT, versions: [{ counts: [0, 0, 0, 0, 1] }] },
    ],
    ['result with an unknown outcome', 'result', { ...RESULT, outcome: { kind: 'win' } }],
    ['result with a pass naming no version', 'result', { ...RESULT, outcome: { kind: 'pass' } }],
    ['result with an outcome that isn’t an object', 'result', { ...RESULT, outcome: 'lapse' }],
    ['result with a string closedSeq', 'result', { ...RESULT, closedSeq: '7' }],
    ['result with a fractional closedSeq', 'result', { ...RESULT, closedSeq: 7.5 }],
    ['result with a negative closedSeq', 'result', { ...RESULT, closedSeq: -1 }],
    ['result with a null closedSeq', 'result', { ...RESULT, closedSeq: null }],
    [
      'proposal with both an atom and a target',
      'proposal',
      {
        atom: 'a',
        target: { kind: 'add', document: 'd', after: null },
        title: 't',
        why: 'w',
        text: 'x',
      },
    ],
    [
      'proposal with a target that is a string',
      'proposal',
      { target: 'add', title: 't', why: 'w', text: 'x' },
    ],
    ['proposal with a null target', 'proposal', { target: null, title: 't', why: 'w', text: 'x' }],
    [
      'add with no anchor',
      'proposal',
      { target: { kind: 'add', document: 'd' }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'add with a numeric anchor',
      'proposal',
      { target: { kind: 'add', document: 'd', after: 0 }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'add without a Document (#92)',
      'proposal',
      { target: { kind: 'add', after: null }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'add with a numeric Document (#92)',
      'proposal',
      { target: { kind: 'add', document: 0, after: null }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'add without text',
      'proposal',
      { target: { kind: 'add', document: 'd', after: null }, title: 't', why: 'w' },
    ],
    [
      'add with its window as text',
      'proposal',
      {
        target: { kind: 'add', document: 'd', after: null },
        title: 't',
        why: 'w',
        text: 'x',
        window: '7',
      },
    ],
    [
      'new Document without a title (#92)',
      'proposal',
      { target: { kind: 'new-document' }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'new Document with a numeric title (#92)',
      'proposal',
      { target: { kind: 'new-document', title: 7 }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'new Document without text (#92)',
      'proposal',
      { target: { kind: 'new-document', title: 'B' }, title: 't', why: 'w' },
    ],
    [
      'new Document that also names an atom (#92)',
      'proposal',
      { atom: 'a', target: { kind: 'new-document', title: 'B' }, title: 't', why: 'w', text: 'x' },
    ],
    [
      'new Document with its window as text (#92)',
      'proposal',
      {
        target: { kind: 'new-document', title: 'B' },
        title: 't',
        why: 'w',
        text: 'x',
        window: '7',
      },
    ],
    [
      'new Document whose dispatch has no text (#92)',
      'proposal',
      {
        target: { kind: 'new-document', title: 'B' },
        title: 't',
        why: 'w',
        text: 'x',
        dispatch: { title: 'u' },
      },
    ],
    [
      'move without an Atom (#103)',
      'proposal',
      { target: { kind: 'move', after: null }, title: 't', why: 'w' },
    ],
    [
      'move with a numeric Atom (#103)',
      'proposal',
      { target: { kind: 'move', atom: 0, after: null }, title: 't', why: 'w' },
    ],
    [
      'move with no anchor (#103)',
      'proposal',
      { target: { kind: 'move', atom: 'a.1' }, title: 't', why: 'w' },
    ],
    [
      'move with a numeric anchor (#103)',
      'proposal',
      { target: { kind: 'move', atom: 'a.1', after: 0 }, title: 't', why: 'w' },
    ],
    [
      'move that also names an atom (#103)',
      'proposal',
      { atom: 'a.1', target: { kind: 'move', atom: 'a.1', after: null }, title: 't', why: 'w' },
    ],
    [
      'move without a why (#103)',
      'proposal',
      { target: { kind: 'move', atom: 'a.1', after: null }, title: 't' },
    ],
    [
      'move with its window as text (#103)',
      'proposal',
      { target: { kind: 'move', atom: 'a.1', after: null }, title: 't', why: 'w', window: '7' },
    ],
    [
      'move whose dispatch has no text (#103)',
      'proposal',
      {
        target: { kind: 'move', atom: 'a.1', after: null },
        title: 't',
        why: 'w',
        dispatch: { title: 'u' },
      },
    ],
    [
      'class change without an Atom (#116)',
      'proposal',
      { target: { kind: 'class', to: 'entrenched' }, title: 't', why: 'w' },
    ],
    [
      'class change with a numeric Atom (#116)',
      'proposal',
      { target: { kind: 'class', atom: 1, to: 'entrenched' }, title: 't', why: 'w' },
    ],
    [
      'class change with no class to go to (#116)',
      'proposal',
      { target: { kind: 'class', atom: 'a.1' }, title: 't', why: 'w' },
    ],
    [
      'class change to a class given as a number (#116)',
      'proposal',
      { target: { kind: 'class', atom: 'a.1', to: 2 }, title: 't', why: 'w' },
    ],
    [
      'class change that also names an atom (#116)',
      'proposal',
      { atom: 'a.1', target: { kind: 'class', atom: 'a.1', to: 'eternal' }, title: 't', why: 'w' },
    ],
    [
      'class change without a title (#116)',
      'proposal',
      { target: { kind: 'class', atom: 'a.1', to: 'eternal' }, why: 'w' },
    ],
    [
      'class change with its window as text (#116)',
      'proposal',
      { target: { kind: 'class', atom: 'a.1', to: 'eternal' }, title: 't', why: 'w', window: '14' },
    ],
    [
      'class change whose dispatch has no title (#116)',
      'proposal',
      {
        target: { kind: 'class', atom: 'a.1', to: 'entrenched' },
        title: 't',
        why: 'w',
        dispatch: { text: 'u' },
      },
    ],
    ['a steward target that is a list', 'proposal', { target: [], title: 't', why: 'w' }],
    [
      'a target of an unknown kind',
      'proposal',
      { target: { kind: 'chair' }, title: 't', why: 'w' },
    ],
    [
      'a steward target with its seat as text',
      'proposal',
      { target: { kind: 'steward', seat: '1', member: null }, title: 't', why: 'w' },
    ],
    [
      'a steward target with a fractional seat',
      'proposal',
      { target: { kind: 'steward', seat: 1.5, member: null }, title: 't', why: 'w' },
    ],
    [
      'a steward target with a numeric member',
      'proposal',
      { target: { kind: 'steward', seat: 1, member: 7 }, title: 't', why: 'w' },
    ],
    [
      'a steward target that leaves out its member',
      'proposal',
      { target: { kind: 'steward', seat: 1 }, title: 't', why: 'w' },
    ],
    [
      'a steward Proposal that also names an Atom',
      'proposal',
      { atom: 'a', target: { kind: 'steward', seat: 1, member: null }, title: 't', why: 'w' },
    ],
    [
      'a steward Proposal without a why',
      'proposal',
      { target: { kind: 'steward', seat: 1, member: null }, title: 't' },
    ],
    [
      'a steward Proposal with a numeric link',
      'proposal',
      { target: { kind: 'steward', seat: 1, member: null }, title: 't', why: 'w', link: 1 },
    ],
    [
      'a dissolve target whose wipe is text',
      'proposal',
      { target: { kind: 'dissolve', wipe: 'true' }, title: 't', why: 'w' },
    ],
    [
      'a dissolve target that leaves out its wipe',
      'proposal',
      { target: { kind: 'dissolve' }, title: 't', why: 'w' },
    ],
    [
      'a dissolve Proposal that also names an Atom',
      'proposal',
      { atom: 'a', target: { kind: 'dissolve', wipe: false }, title: 't', why: 'w' },
    ],
    [
      'a dissolve Proposal without a title',
      'proposal',
      { target: { kind: 'dissolve', wipe: false }, why: 'w' },
    ],
    [
      'a dissolve Proposal with a numeric link',
      'proposal',
      { target: { kind: 'dissolve', wipe: false }, title: 't', why: 'w', link: 1 },
    ],
    [
      'a dissolve Proposal with a string window',
      'proposal',
      { target: { kind: 'dissolve', wipe: false }, title: 't', why: 'w', window: '14' },
    ],
    [
      'a removal target with a numeric member',
      'proposal',
      { target: { kind: 'remove', member: 7 }, title: 't', why: 'w' },
    ],
    [
      'a removal target that leaves out its member',
      'proposal',
      { target: { kind: 'remove' }, title: 't', why: 'w' },
    ],
    [
      'a removal target whose member is null',
      'proposal',
      { target: { kind: 'remove', member: null }, title: 't', why: 'w' },
    ],
    [
      'a removal Proposal that also names an Atom',
      'proposal',
      { atom: 'a', target: { kind: 'remove', member: 'k' }, title: 't', why: 'w' },
    ],
    [
      'a removal Proposal without a why',
      'proposal',
      { target: { kind: 'remove', member: 'k' }, title: 't' },
    ],
    [
      'a removal Proposal with a numeric link',
      'proposal',
      { target: { kind: 'remove', member: 'k' }, title: 't', why: 'w', link: 1 },
    ],
    ['removal-response without a Proposal', 'removal-response', { text: 'x' }],
    ['removal-response without text', 'removal-response', { proposal: 'p' }],
    ['removal-response with numeric text', 'removal-response', { proposal: 'p', text: 1 }],
    ['removal-response with a numeric Proposal', 'removal-response', { proposal: 1, text: 'x' }],
    ['remove without a Proposal', 'remove', {}],
    ['remove with a numeric Proposal', 'remove', { proposal: 7 }],
    ['dissolve without a proposal', 'dissolve', {}],
    ['dissolve with a numeric proposal', 'dissolve', { proposal: 7 }],
    ['suspend without a member', 'suspend', { reason: 'r' }],
    ['suspend with a numeric member', 'suspend', { member: 1 }],
    ['suspend with a null reason', 'suspend', { member: 'm', reason: null }],
    ['suspend with a numeric reason', 'suspend', { member: 'm', reason: 3 }],
    [
      'a rules target with a numeric opt-in',
      'proposal',
      { target: { kind: 'rules', optIn: 1, value: true }, title: 't', why: 'w' },
    ],
    [
      'a rules target that leaves out its value',
      'proposal',
      { target: { kind: 'rules', optIn: 'frontDoor' }, title: 't', why: 'w' },
    ],
    [
      'a rules Proposal that also names an Atom',
      'proposal',
      {
        atom: 'a',
        target: { kind: 'rules', optIn: 'frontDoor', value: false },
        title: 't',
        why: 'w',
      },
    ],
    [
      'a rules Proposal without a title',
      'proposal',
      { target: { kind: 'rules', optIn: 'frontDoor', value: false }, why: 'w' },
    ],
    [
      'a rules Proposal with its window as text',
      'proposal',
      {
        target: { kind: 'rules', optIn: 'frontDoor', value: false },
        title: 't',
        why: 'w',
        window: '14',
      },
    ],
    ['narrow without a Proposal', 'narrow', { optIn: 'chatBot' }],
    ['narrow without an opt-in', 'narrow', { proposal: 'p' }],
    ['narrow with a numeric Proposal', 'narrow', { optIn: 'chatBot', proposal: 1 }],
    ['vouch without a member', 'vouch', {}],
    ['vouch with a numeric member', 'vouch', { member: 7 }],
    ['vouch with a null member', 'vouch', { member: null }],
    ['chat-posted without a Proposal', 'chat-posted', { moment: 'open' }],
    ['chat-posted without a moment', 'chat-posted', { proposal: 'p' }],
    ['chat-posted with a numeric moment', 'chat-posted', { proposal: 'p', moment: 1 }],
    [
      'chat-posted with a numeric nonce',
      'chat-posted',
      { proposal: 'p', moment: 'open', nonce: 7 },
    ],
    ['door-invited without an application', 'door-invited', {}],
    ['door-invited with a numeric application', 'door-invited', { application: 7 }],
    ['door-invited with a null application', 'door-invited', { application: null }],
    ['chat-thread without a Proposal', 'chat-thread', { url: 'https://discord.com/channels/1/2' }],
    ['chat-thread without a URL', 'chat-thread', { proposal: 'p' }],
    ['chat-thread with a numeric URL', 'chat-thread', { proposal: 'p', url: 7 }],
    [
      'chat-thread with a numeric Proposal',
      'chat-thread',
      { proposal: 1, url: 'https://discord.com/channels/1/2' },
    ],
    ['dispatch without a title', 'dispatch', { text: 'x' }],
    ['dispatch without text', 'dispatch', { title: 't' }],
    ['dispatch with a numeric title', 'dispatch', { title: 1, text: 'x' }],
    ['dispatch with null text', 'dispatch', { title: 't', text: null }],
    ['dispatch with a numeric doc', 'dispatch', { title: 't', text: 'x', doc: 1 }],
    ['dispatch with a null doc', 'dispatch', { title: 't', text: 'x', doc: null }],
    [
      'a proposal whose dispatch is text',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', dispatch: 'Updated' },
    ],
    [
      'a proposal whose dispatch is null',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', dispatch: null },
    ],
    [
      'a proposal whose dispatch is a list',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', dispatch: [] },
    ],
    [
      'a proposal whose dispatch has no title',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', dispatch: { text: '' } },
    ],
    [
      'a proposal whose dispatch has numeric text',
      'proposal',
      { atom: 'a', title: 't', why: 'w', text: 'x', dispatch: { title: 'u', text: 1 } },
    ],
    [
      'a rules Proposal whose dispatch has no text',
      'proposal',
      {
        target: { kind: 'rules', optIn: 'frontDoor', value: true },
        title: 't',
        why: 'w',
        dispatch: { title: 'u' },
      },
    ],
    [
      'a steward Proposal whose dispatch is text',
      'proposal',
      { target: { kind: 'steward', seat: 1, member: null }, title: 't', why: 'w', dispatch: 'u' },
    ],
    [
      'an add whose dispatch has no text (#75)',
      'proposal',
      {
        target: { kind: 'add', document: 'd', after: null },
        title: 't',
        why: 'w',
        text: 'x',
        dispatch: { title: 'u' },
      },
    ],
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

  it('reads a result: its close, eligible count, each version’s five counts, outcome and commit', () => {
    const parsed = parseEvent(json(envelope('result', { ...RESULT, note: 'dropped' })));
    expect(parsed?.event.body).toEqual(RESULT);
    const fail = parseEvent(
      json(envelope('result', { ...RESULT, outcome: { kind: 'fail', version: 'p' } })),
    );
    expect(fail?.event.body).toEqual({ ...RESULT, outcome: { kind: 'fail' } });
    const lapse = parseEvent(json(envelope('result', { ...RESULT, outcome: { kind: 'lapse' } })));
    expect(lapse?.event.body).toEqual({ ...RESULT, outcome: { kind: 'lapse' } });
  });

  it('keeps a result’s closedSeq, the closing ballot’s place, and reads one without it (#289)', () => {
    const placed = parseEvent(json(envelope('result', { ...RESULT, closedSeq: 7 })));
    expect(placed?.event.body).toEqual({ ...RESULT, closedSeq: 7 });
    const first = parseEvent(json(envelope('result', { ...RESULT, closedSeq: 0 })));
    expect(first?.event.body).toEqual({ ...RESULT, closedSeq: 0 });
    const without = parseEvent(json(envelope('result', RESULT)));
    expect(without?.event.body).not.toHaveProperty('closedSeq');
  });

  it('keeps a vote’s salt, and reads a vote without one, as cast before #111', () => {
    const salted = parseEvent(
      json(envelope('vote', { proposal: 'p', scores: { p: 3 }, salt: 'AAAAAAAAAAAAAAAAAAAAAA' })),
    );
    expect(salted?.event.body).toEqual({
      proposal: 'p',
      scores: { p: 3 },
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const plain = parseEvent(json(envelope('vote', { proposal: 'p', scores: { p: 3 } })));
    expect(plain?.event.body).toEqual({ proposal: 'p', scores: { p: 3 } });
  });

  it.each([
    ['an anchor', 'a.1'],
    ['no anchor, for the start', null],
  ])(
    'reads an add Proposal with %s, keeping only its kind, Document and anchor (#92)',
    (_label, after) => {
      const body = {
        target: { kind: 'add', after, document: 'd', extra: 'x' },
        title: 't',
        why: 'w',
        text: 'New section.\n',
        link: 'https://l',
        window: 10,
      };
      const parsed = parseEvent(json(envelope('proposal', body)));
      expect(parsed?.event.body).toEqual({
        target: { kind: 'add', document: 'd', after },
        title: 't',
        why: 'w',
        text: 'New section.\n',
        link: 'https://l',
        window: 10,
      });
    },
  );

  it('reads a new-Document Proposal: its title, and its first sections as its text (#92)', () => {
    const body = {
      target: { kind: 'new-document', title: 'Budget', after: 'x' },
      title: 'Start a budget',
      why: 'We spend together.',
      text: '# Budget\n\nWe share costs.\n',
      link: 'https://l',
      window: 10,
      dispatch: { title: 'New: Budget', text: 'Read it.', doc: 'g1' },
      extra: 1,
    };
    const parsed = parseEvent(json(envelope('proposal', body)));
    expect(parsed?.event.body).toEqual({
      target: { kind: 'new-document', title: 'Budget' },
      title: 'Start a budget',
      why: 'We spend together.',
      text: '# Budget\n\nWe share costs.\n',
      link: 'https://l',
      window: 10,
      dispatch: { title: 'New: Budget', text: 'Read it.' },
    });
    const body2 = parsed?.event.type === 'proposal' ? parsed.event.body : null;
    expect(body2 !== null && isNewDocumentProposal(body2)).toBe(true);
    expect(body2 !== null && isAddProposal(body2)).toBe(false);
  });

  it('keeps a new-Document Proposal whose title or text is blank, for the fold to refuse (#92)', () => {
    const body = { target: { kind: 'new-document', title: '' }, title: 't', why: 'w', text: '' };
    expect(parseEvent(json(envelope('proposal', body)))?.event.body).toEqual(body);
  });

  it.each([
    ['an anchor', 'a.2'],
    ['no anchor, for the start', null],
  ])(
    'reads a move with %s, keeping only its kind, Atom and anchor, and dropping any text (#103)',
    (_label, after) => {
      const body = {
        target: { kind: 'move', atom: 'a.1', after, document: 'd', extra: 'x' },
        title: 'Move it',
        why: 'It reads better first.',
        text: 'Ignored.\n',
        link: 'https://l',
        window: 10,
        dispatch: { title: 'Updated: House rules', text: 'Moved.', doc: 'g1' },
      };
      const parsed = parseEvent(json(envelope('proposal', body)));
      expect(parsed?.event.body).toEqual({
        target: { kind: 'move', atom: 'a.1', after },
        title: 'Move it',
        why: 'It reads better first.',
        link: 'https://l',
        window: 10,
        dispatch: { title: 'Updated: House rules', text: 'Moved.' },
      });
      const read = parsed?.event.type === 'proposal' ? parsed.event.body : null;
      expect(read !== null && isMoveProposal(read)).toBe(true);
      expect(read !== null && isAddProposal(read)).toBe(false);
      expect(read !== null && isStewardProposal(read)).toBe(false);
    },
  );

  it.each(['ordinary', 'entrenched', 'eternal'])(
    'reads a class change to %s, keeping only its kind, Atom and class, and dropping any text (#116)',
    (to) => {
      const body = {
        target: { kind: 'class', atom: 'a.1', to, from: 'ordinary', after: null },
        title: 'Protect our values',
        why: 'They hold us together.',
        text: 'Ignored.\n',
        link: 'https://l',
        window: 21,
        dispatch: { title: 'Updated: House rules', text: 'Protected.', doc: 'g1' },
      };
      const parsed = parseEvent(json(envelope('proposal', body)));
      expect(parsed?.event.body).toEqual({
        target: { kind: 'class', atom: 'a.1', to },
        title: 'Protect our values',
        why: 'They hold us together.',
        link: 'https://l',
        window: 21,
        dispatch: { title: 'Updated: House rules', text: 'Protected.' },
      });
      const read = parsed?.event.type === 'proposal' ? parsed.event.body : null;
      expect(read !== null && isClassProposal(read)).toBe(true);
      expect(read !== null && isMoveProposal(read)).toBe(false);
      expect(read !== null && isStewardProposal(read)).toBe(false);
    },
  );

  it("keeps a class change to a class it doesn't know, for the fold to refuse (#116)", () => {
    const body = { target: { kind: 'class', atom: 'a.1', to: 'sacred' }, title: 't', why: 'w' };
    expect(parseEvent(json(envelope('proposal', body)))?.event.body).toEqual(body);
  });

  it('tells no other Proposal for a class change (#116)', () => {
    const move = {
      target: { kind: 'move', atom: 'a.1', after: null },
      title: 't',
      why: 'w',
    } as const;
    expect(isClassProposal(move)).toBe(false);
    expect(isClassProposal({ atom: 'a.1', title: 't', why: 'w', text: 'x\n' })).toBe(false);
  });

  it('keeps a move anchored on its own Atom, for the fold to refuse (#103)', () => {
    const body = { target: { kind: 'move', atom: 'a.1', after: 'a.1' }, title: 't', why: 'w' };
    expect(parseEvent(json(envelope('proposal', body)))?.event.body).toEqual(body);
  });

  it('reads the Dispatch an add carries, keeping its title and text alone (#75, #112)', () => {
    const body = {
      target: { kind: 'add', document: 'g1', after: 'a.1' },
      title: 't',
      why: 'w',
      text: 'New section.\n',
      dispatch: { title: 'Updated: House rules', text: 'A new section.', doc: 'g1' },
    };
    const parsed = parseEvent(json(envelope('proposal', body)));
    expect(parsed?.event.body).toEqual({
      target: { kind: 'add', document: 'g1', after: 'a.1' },
      title: 't',
      why: 'w',
      text: 'New section.\n',
      dispatch: { title: 'Updated: House rules', text: 'A new section.' },
    });
  });

  it('reads an edit whose text is empty, as a removal carries it', () => {
    const parsed = parseEvent(
      json(envelope('proposal', { atom: 'a', title: 't', why: 'w', text: '' })),
    );
    expect(parsed?.event.body).toEqual({ atom: 'a', title: 't', why: 'w', text: '' });
  });

  it('reads a steward election and a recall, dropping text and unknown keys (#102)', () => {
    const target = { kind: 'steward', seat: 2, member: BEN };
    const election = parseEvent(
      json(envelope('proposal', { target, title: 't', why: 'w', text: 'x', extra: 1 })),
    );
    expect(election?.event.body).toEqual({ target, title: 't', why: 'w' });
    const recall = { kind: 'steward', seat: 1, member: null };
    const linked = parseEvent(
      json(envelope('proposal', { target: recall, title: 't', why: 'w', link: 'https://l' })),
    );
    expect(linked?.event.body).toEqual({ target: recall, title: 't', why: 'w', link: 'https://l' });
  });

  it('reads a dissolve Proposal, keeping its wipe and window and dropping text and unknown keys (#108)', () => {
    const target = { kind: 'dissolve', wipe: true };
    const parsed = parseEvent(
      json(envelope('proposal', { target, title: 't', why: 'w', text: 'x', window: 21, extra: 1 })),
    );
    expect(parsed?.event.body).toEqual({ target, title: 't', why: 'w', window: 21 });
    const kept = { kind: 'dissolve', wipe: false };
    const linked = parseEvent(
      json(envelope('proposal', { target: kept, title: 't', why: 'w', link: 'https://l' })),
    );
    expect(linked?.event.body).toEqual({ target: kept, title: 't', why: 'w', link: 'https://l' });
  });

  it('tells a dissolve Proposal from a steward one and from an edit (#108)', () => {
    const dissolve = { target: { kind: 'dissolve', wipe: false } as const, title: 't', why: 'w' };
    const steward = {
      target: { kind: 'steward', seat: 1, member: null } as const,
      title: 't',
      why: 'w',
    };
    const edit = { atom: 'a', title: 't', why: 'w', text: 'x' };
    expect([dissolve, steward, edit].map(isDissolveProposal)).toEqual([true, false, false]);
    expect([dissolve, steward, edit].map(isStewardProposal)).toEqual([false, true, false]);
  });

  it('reads a removal Proposal as its member, dropping any window, text and unknown keys (#115)', () => {
    const target = { kind: 'remove', member: BEN };
    const parsed = parseEvent(
      json(
        envelope('proposal', {
          target: { ...target, extra: 1 },
          title: 't',
          why: 'w',
          text: 'x',
          window: 3,
          class: 'ordinary',
        }),
      ),
    );
    expect(parsed?.event.body).toEqual({ target, title: 't', why: 'w' });
    const linked = parseEvent(
      json(envelope('proposal', { target, title: 't', why: 'w', link: 'https://l' })),
    );
    expect(linked?.event.body).toEqual({ target, title: 't', why: 'w', link: 'https://l' });
  });

  it('tells a removal Proposal from a dissolve, a steward one and an edit (#115)', () => {
    const removal = { target: { kind: 'remove', member: BEN } as const, title: 't', why: 'w' };
    const dissolve = { target: { kind: 'dissolve', wipe: false } as const, title: 't', why: 'w' };
    const steward = {
      target: { kind: 'steward', seat: 1, member: null } as const,
      title: 't',
      why: 'w',
    };
    const edit = { atom: 'a', title: 't', why: 'w', text: 'x' };
    const all = [removal, dissolve, steward, edit];
    expect(all.map(isRemovalProposal)).toEqual([true, false, false, false]);
    expect(all.map(isDissolveProposal)).toEqual([false, true, false, false]);
    expect(all.map(isStewardProposal)).toEqual([false, false, true, false]);
    expect(all.map(isRulesProposal)).toEqual([false, false, false, false]);
  });

  it('reads a removal-response as its Proposal and text, kept as written, dropping unknown keys (#115)', () => {
    const body = { proposal: 'p1', text: ' I wasn’t there. ', extra: 1 };
    expect(parseEvent(json(envelope('removal-response', body)))?.event).toEqual({
      v: 1,
      type: 'removal-response',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { proposal: 'p1', text: ' I wasn’t there. ' },
    });
  });

  it('reads a remove as the removal it names, dropping unknown keys (#115)', () => {
    const parsed = parseEvent(json(envelope('remove', { proposal: 'p1', member: BEN })));
    expect(parsed?.event.body).toEqual({ proposal: 'p1' });
    expect(parsed?.event.type).toBe('remove');
  });

  it('reads a dissolve as the Proposal it names, dropping unknown keys (#108)', () => {
    const parsed = parseEvent(json(envelope('dissolve', { proposal: 'p1', wipe: true })));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'dissolve',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { proposal: 'p1' },
    });
  });

  it('reads a rules Proposal, keeping its value as written for the fold to check (#117)', () => {
    const target = { kind: 'rules', optIn: 'chatBot', value: { webhook: 'https://x', extra: 1 } };
    const parsed = parseEvent(
      json(envelope('proposal', { target, title: 't', why: 'w', text: 'x', class: 'ordinary' })),
    );
    expect(parsed?.event.body).toEqual({ target, title: 't', why: 'w' });
    const off = { kind: 'rules', optIn: 'chatBot', value: null };
    const linked = parseEvent(
      json(envelope('proposal', { target: { ...off, from: 1 }, title: 't', why: 'w', link: 'l' })),
    );
    expect(linked?.event.body).toEqual({ target: off, title: 't', why: 'w', link: 'l' });
  });

  it('keeps a rules Proposal’s voting window as written, for the fold to bound (#106, #117)', () => {
    const target = { kind: 'rules', optIn: 'frontDoor', value: false };
    const parsed = parseEvent(
      json(envelope('proposal', { target, title: 't', why: 'w', window: 13 })),
    );
    expect(parsed?.event.body).toEqual({ target, title: 't', why: 'w', window: 13 });
  });

  it('tells a rules Proposal from a steward one and from an edit', () => {
    const rules = {
      target: { kind: 'rules', optIn: 'frontDoor', value: false },
      title: 't',
      why: 'w',
    } as const;
    const steward = {
      target: { kind: 'steward', seat: 1, member: null },
      title: 't',
      why: 'w',
    } as const;
    const edit = { atom: 'a', title: 't', why: 'w', text: 'x' };
    expect([rules, steward, edit].map(isRulesProposal)).toEqual([true, false, false]);
    expect([rules, steward, edit].map(isStewardProposal)).toEqual([false, true, false]);
  });

  it('reads a narrow as its opt-in and Proposal, dropping unknown keys (#117)', () => {
    const parsed = parseEvent(
      json(envelope('narrow', { optIn: 'chatBot', proposal: 'p1', until: 9 })),
    );
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'narrow',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { optIn: 'chatBot', proposal: 'p1' },
    });
  });

  it('reads a chat-posted as its Proposal, moment and nonce, kept as written, dropping unknown keys (#119)', () => {
    const body = { proposal: 'p1', moment: 'version', nonce: 'n1', title: 'Quiet hours' };
    const parsed = parseEvent(json(envelope('chat-posted', body)));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'chat-posted',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { proposal: 'p1', moment: 'version', nonce: 'n1' },
    });
    const bare = parseEvent(json(envelope('chat-posted', { proposal: 'p1', moment: 'open' })));
    expect(bare?.event.body).toEqual({ proposal: 'p1', moment: 'open' });
  });

  it('reads a door-invited as its application, kept as written, dropping unknown keys (#121)', () => {
    const body = { application: 'a1', name: 'Kim', message: 'Hello' };
    const parsed = parseEvent(json(envelope('door-invited', body)));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'door-invited',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { application: 'a1' },
    });
  });

  it('reads a chat-thread as its Proposal and URL, kept as written, dropping unknown keys (#123)', () => {
    const body = { proposal: 'p1', url: 'https://example.com/x', title: 'Quiet hours' };
    const parsed = parseEvent(json(envelope('chat-thread', body)));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'chat-thread',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { proposal: 'p1', url: 'https://example.com/x' },
    });
  });

  it('reads a suspend as its member and an optional reason, dropping unknown keys (#102)', () => {
    const plain = parseEvent(json(envelope('suspend', { member: BEN, until: 9 })));
    expect(plain?.event).toEqual({
      v: 1,
      type: 'suspend',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { member: BEN },
    });
    const reasoned = parseEvent(json(envelope('suspend', { member: BEN, reason: 'Threats.' })));
    expect(reasoned?.event.body).toEqual({ member: BEN, reason: 'Threats.' });
  });

  it('reads a vouch as the member it names, dropping unknown keys (#101)', () => {
    const vouch = parseEvent(json(envelope('vouch', { member: BEN, weight: 9 })));
    expect(vouch?.event).toEqual({
      v: 1,
      type: 'vouch',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { member: BEN },
    });
  });

  it('reads a dispatch as its title, text and optional Document, dropping unknown keys (#112)', () => {
    const linked = parseEvent(
      json(envelope('dispatch', { title: 'Meet Sunday', text: 'At 10.', doc: 'g1', to: BEN })),
    );
    expect(linked?.event).toEqual({
      v: 1,
      type: 'dispatch',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { title: 'Meet Sunday', text: 'At 10.', doc: 'g1' },
    });
    const bare = parseEvent(json(envelope('dispatch', { title: 'Meet Sunday', text: '' })));
    expect(bare?.event.body).toEqual({ title: 'Meet Sunday', text: '' });
  });

  it('keeps a Proposal’s dispatch as its title and text, dropping a doc and unknown keys (#112)', () => {
    const dispatch = { title: 'Updated: House rules', text: 'Quiet hours moved.' };
    const edit = { atom: 'a', title: 't', why: 'w', text: 'x' };
    const parsed = parseEvent(
      json(envelope('proposal', { ...edit, dispatch: { ...dispatch, doc: 'g1', extra: 1 } })),
    );
    expect(parsed?.event.body).toEqual({ ...edit, dispatch });
    const targets = [
      { kind: 'steward', seat: 1, member: null },
      { kind: 'rules', optIn: 'frontDoor', value: true },
      { kind: 'dissolve', wipe: false },
    ];
    for (const target of targets) {
      const carried = parseEvent(
        json(envelope('proposal', { target, title: 't', why: 'w', dispatch })),
      );
      expect(carried?.event.body).toEqual({ target, title: 't', why: 'w', dispatch });
    }
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

describe('parseEvent: a priority vote (#107)', () => {
  const priority = { target: { kind: 'priority' }, title: 'q', why: 'w', options: ['a', 'b'] };

  it('reads its target, question, why and options, keeping a link and dropping unknown keys', () => {
    const body = { ...priority, link: 'https://l', extra: 1, target: { kind: 'priority', x: 1 } };
    expect(parseEvent(json(envelope('proposal', body)))?.event.body).toEqual({
      ...priority,
      link: 'https://l',
    });
  });

  it('leaves an absent link absent', () => {
    expect(Object.keys(parseEvent(json(envelope('proposal', priority)))?.event.body ?? {})).toEqual(
      ['target', 'title', 'why', 'options'],
    );
  });

  it.each([
    ['an Atom', { ...priority, atom: 'a' }],
    ['text', { ...priority, text: 'x' }],
    ['no options', { target: { kind: 'priority' }, title: 'q', why: 'w' }],
    ['a non-string option', { ...priority, options: ['a', 1] }],
    ['options that are a string', { ...priority, options: 'a, b' }],
    ['an unknown target', { ...priority, target: { kind: 'focus' } }],
    ['a target that is a string', { ...priority, target: 'priority' }],
    ['a non-string question', { ...priority, title: 1 }],
    ['a non-string why', { ...priority, why: null }],
    ['a non-string link', { ...priority, link: 1 }],
  ])('rejects one with %s', (_what, body) => {
    expect(parseEvent(json(envelope('proposal', body)))).toBeNull();
  });

  it('tells a priority vote from a steward change and an edit', () => {
    const asked = { ...priority, target: { kind: 'priority' } } as const;
    const steward = {
      target: { kind: 'steward', seat: 1, member: null },
      title: 't',
      why: 'w',
    } as const;
    const edit = { atom: 'a', title: 't', why: 'w', text: 'x' };
    expect([asked, steward, edit].map(isPriorityProposal)).toEqual([true, false, false]);
    expect([asked, steward, edit].map(isStewardProposal)).toEqual([false, true, false]);
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

describe('encryption keys and key changes (#98)', () => {
  /** A 32-byte key in base64url, as `kx` and the wraps' keys are spelled. */
  const KX = base64url(new Uint8Array(32).fill(9));
  const COMMIT = base64url(new Uint8Array(32).fill(7));
  const WRAP = base64url(new Uint8Array(104).fill(5));

  it('keeps a genesis’s or join’s well-shaped kx, and drops any other, keeping the event', () => {
    const genesis = { name: 'G', founder: 'A', documents: DOCS, kx: KX };
    expect(parseEvent(json(envelope('genesis', genesis)))?.event.body).toEqual(genesis);
    expect(parseEvent(json(envelope('join', { name: 'Ben', kx: KX })))?.event.body).toEqual({
      name: 'Ben',
      kx: KX,
    });
    for (const bad of [KX.slice(1), `${KX.slice(1)}+`, `${KX.slice(0, 42)}B`, 7, null, [KX]]) {
      const join = parseEvent(json(envelope('join', { name: 'Ben', kx: bad })));
      expect(join?.event.body, JSON.stringify(bad)).toEqual({ name: 'Ben' });
      const founded = parseEvent(json(envelope('genesis', { ...genesis, kx: bad })));
      expect(founded?.event.body, JSON.stringify(bad)).toEqual({ ...genesis, kx: undefined });
    }
  });

  it('reads a kx as its key, dropping unknown keys', () => {
    const parsed = parseEvent(json(envelope('kx', { kx: KX, note: 'mine' })));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'kx',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { kx: KX },
    });
  });

  it('reads a recovery-share as its box alone, dropping a recipient or any other key (#109)', () => {
    const parsed = parseEvent(json(envelope('recovery-share', { box: WRAP, to: BEN, t: 3 })));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'recovery-share',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { box: WRAP },
    });
  });

  it.each([
    ['no box', {}],
    ['a numeric box', { box: 7 }],
    ['a box outside base64url', { box: 'a box' }],
    ['a padded box', { box: `${WRAP}=` }],
    ['a one-character box', { box: 'A' }],
  ])('returns null for a recovery-share with %s (#109)', (_label, body) => {
    expect(parseEvent(json(envelope('recovery-share', body)))).toBeNull();
  });

  it('reads a key-rotate as its epoch, commit and wraps, dropping unknown keys', () => {
    const body = { epoch: 1, commit: COMMIT, wraps: { [ANA]: WRAP, [BEN]: WRAP }, secret: 'no' };
    const parsed = parseEvent(json(envelope('key-rotate', body)));
    expect(parsed?.event).toEqual({
      v: 1,
      type: 'key-rotate',
      group: 'g1',
      author: ANA,
      ts: 1,
      body: { epoch: 1, commit: COMMIT, wraps: { [ANA]: WRAP, [BEN]: WRAP } },
    });
    const top = parseEvent(json(envelope('key-rotate', { ...body, epoch: 2 ** 32 - 1 })));
    expect(top?.event.body).toMatchObject({ epoch: 2 ** 32 - 1 });
  });

  it('refuses a wrap under any key that isn’t a member key, "__proto__" included', () => {
    const bytes = utf8(
      `{"v":1,"type":"key-rotate","group":"g1","author":"${ANA}","ts":1,"body":{"epoch":1,"commit":"${COMMIT}","wraps":{"__proto__":"${WRAP}"}}}`,
    );
    expect(parseEvent(bytes)).toBeNull();
  });

  it.each([
    ['a kx without its key', 'kx', {}],
    ['a kx of the wrong length', 'kx', { kx: KX.slice(1) }],
    ['a kx with a bad last character', 'kx', { kx: `${KX.slice(0, 42)}B` }],
    ['a numeric kx', 'kx', { kx: 7 }],
    ['a key-rotate without an epoch', 'key-rotate', { commit: COMMIT, wraps: {} }],
    ['a key-rotate to epoch 0', 'key-rotate', { epoch: 0, commit: COMMIT, wraps: {} }],
    ['a key-rotate to a fractional epoch', 'key-rotate', { epoch: 1.5, commit: COMMIT, wraps: {} }],
    ['a key-rotate past u32', 'key-rotate', { epoch: 2 ** 32, commit: COMMIT, wraps: {} }],
    ['a key-rotate without a commit', 'key-rotate', { epoch: 1, wraps: {} }],
    ['a key-rotate with a short commit', 'key-rotate', { epoch: 1, commit: 'abc', wraps: {} }],
    ['a key-rotate without wraps', 'key-rotate', { epoch: 1, commit: COMMIT }],
    [
      'a key-rotate whose wraps are a list',
      'key-rotate',
      { epoch: 1, commit: COMMIT, wraps: [WRAP] },
    ],
    [
      'a wrap for a malformed key',
      'key-rotate',
      { epoch: 1, commit: COMMIT, wraps: { ana: WRAP } },
    ],
    ['a numeric wrap', 'key-rotate', { epoch: 1, commit: COMMIT, wraps: { [ANA]: 7 } }],
    [
      'a wrap that isn’t base64url',
      'key-rotate',
      { epoch: 1, commit: COMMIT, wraps: { [ANA]: 'a+b' } },
    ],
    ['an empty wrap', 'key-rotate', { epoch: 1, commit: COMMIT, wraps: { [ANA]: '' } }],
  ])('returns null for %s', (_label, type, body) => {
    expect(parseEvent(json(envelope(type, body)))).toBeNull();
  });
});

describe('a key change that doesn’t open, and one taken up (#224)', () => {
  it.each(['unwrap-failed', 'key-taken'] as const)(
    'reads a %s as the key change it names, dropping unknown keys',
    (type) => {
      const parsed = parseEvent(json(envelope(type, { rotation: 'r1', why: 'no' })));
      expect(parsed?.event).toEqual({
        v: 1,
        type,
        group: 'g1',
        author: ANA,
        ts: 1,
        body: { rotation: 'r1' },
      });
    },
  );

  it.each([
    ['an unwrap-failed without its key change', 'unwrap-failed', {}],
    ['an unwrap-failed naming a number', 'unwrap-failed', { rotation: 7 }],
    ['a key-taken without its key change', 'key-taken', {}],
    ['a key-taken naming a list', 'key-taken', { rotation: ['r1'] }],
  ])('returns null for %s', (_label, type, body) => {
    expect(parseEvent(json(envelope(type, body)))).toBeNull();
  });
});

describe('coalitions (#100)', () => {
  /** 32-byte values in base64url, as seat keys, secrets and inner are spelled. */
  const KEY = base64url(new Uint8Array(32).fill(9));
  const SECRET = base64url(new Uint8Array(32).fill(3));
  const INNER = base64url(new Uint8Array(32).fill(4));
  const SEAT = base64url(new Uint8Array(32).fill(5));
  const PROOF = base64url(new Uint8Array(64).fill(6));
  const SEATS = [
    { name: 'Riverside', key: KEY },
    { name: 'Hillside', key: SECRET },
  ];
  const COALITION = {
    kind: 'coalition',
    name: 'C',
    documents: [{ title: 'T', atoms: ['One.'] }],
    seats: SEATS,
  };
  const RECONCILE = {
    kind: 'reconcile',
    secret: SECRET,
    inner: INNER,
    seat: SEAT,
    name: 'C',
    title: 'T',
    atoms: ['One.'],
  };

  it('reads a coalition genesis as its seats and a group genesis body, dropping founder and kx', () => {
    const body = { ...COALITION, founder: 'Nobody', kx: KEY, rules: { vouches: 2 }, chat: 'x' };
    const parsed = parseEvent(json(envelope('genesis', body, { group: '' })));
    expect(parsed?.event.body).toEqual({ ...COALITION, rules: { vouches: 2 }, chat: 'x' });
    const genesis = parsed?.event.type === 'genesis' ? parsed.event.body : null;
    expect(genesis !== null && isCoalitionGenesis(genesis)).toBe(true);
    const group = parseEvent(
      json(envelope('genesis', { name: 'G', founder: 'A', documents: DOCS })),
    );
    const founded = group?.event.type === 'genesis' ? group.event.body : null;
    expect(founded !== null && isCoalitionGenesis(founded)).toBe(false);
  });

  it('drops anything but a seat’s name and key', () => {
    const seats = [{ name: 'Riverside', key: KEY, secret: SEAT }, SEATS[1]];
    const parsed = parseEvent(json(envelope('genesis', { ...COALITION, seats })));
    expect(parsed?.event.body).toEqual(COALITION);
  });

  it.each([
    ['without seats', { ...COALITION, seats: undefined }],
    ['whose seats are no list', { ...COALITION, seats: { a: SEATS[0] } }],
    ['with a seat that isn’t an object', { ...COALITION, seats: [KEY, SEATS[1]] }],
    ['with a seat without a name', { ...COALITION, seats: [{ key: KEY }, SEATS[1]] }],
    ['with a seat whose key is short', { ...COALITION, seats: [{ name: 'R', key: 'abc' }] }],
    [
      'with a seat whose key isn’t canonical',
      { ...COALITION, seats: [{ name: 'R', key: `${KEY.slice(0, 42)}B` }] },
    ],
    ['without documents', { ...COALITION, documents: undefined }],
    [
      'with a title and Atoms but no documents (#92)',
      { ...COALITION, documents: undefined, title: 'T', atoms: ['One.'] },
    ],
    ['with a Document without atoms (#92)', { ...COALITION, documents: [{ title: 'T' }] }],
    ['without a name', { ...COALITION, name: undefined }],
    ['of another kind', { ...COALITION, kind: 'federation' }],
  ])('refuses a coalition genesis %s', (_label, body) => {
    expect(parseEvent(json(envelope('genesis', body)))).toBeNull();
  });

  it('keeps a join’s well-shaped seat and proof, and drops any other, keeping the join', () => {
    const parsed = parseEvent(json(envelope('join', { name: 'Kim', seat: KEY, proof: PROOF })));
    expect(parsed?.event.body).toEqual({ name: 'Kim', seat: KEY, proof: PROOF });
    for (const [seat, proof] of [
      [KEY.slice(1), PROOF],
      [KEY, PROOF.slice(1)],
      [KEY, `${PROOF.slice(0, 85)}+`],
      [7, PROOF],
      [KEY, null],
    ]) {
      const join = parseEvent(json(envelope('join', { name: 'Kim', seat, proof })));
      expect(join?.event.body, JSON.stringify([seat, proof])).toEqual({
        name: 'Kim',
        ...(typeof seat === 'string' && seat === KEY ? { seat } : {}),
        ...(typeof proof === 'string' && proof === PROOF ? { proof } : {}),
      });
    }
  });

  it('reads a reconcile Proposal, keeping its window and dropping text and unknown keys', () => {
    const body = {
      target: { ...RECONCILE, extra: 1 },
      title: 'Join C',
      why: 'W',
      text: 'x',
      window: 5,
    };
    const parsed = parseEvent(json(envelope('proposal', body)));
    expect(parsed?.event.body).toEqual({ target: RECONCILE, title: 'Join C', why: 'W', window: 5 });
    const proposal = parsed?.event.type === 'proposal' ? parsed.event.body : null;
    expect(proposal !== null && isReconcileProposal(proposal)).toBe(true);
    const edit = parseEvent(json(envelope('proposal', PROPOSAL.body)));
    const steward = parseEvent(
      json(
        envelope('proposal', {
          target: { kind: 'steward', seat: 1, member: ANA },
          title: 'T',
          why: 'W',
        }),
      ),
    );
    for (const other of [edit, steward]) {
      const body = other?.event.type === 'proposal' ? other.event.body : null;
      expect(body !== null && isReconcileProposal(body)).toBe(false);
    }
  });

  it('reads a reconcile Proposal with no inner, as a group asking into a formed coalition writes (#313)', () => {
    const target = Object.fromEntries(Object.entries(RECONCILE).filter(([key]) => key !== 'inner'));
    const parsed = parseEvent(json(envelope('proposal', { target, title: 'Join C', why: 'W' })));
    expect(parsed?.event.body).toEqual({ target, title: 'Join C', why: 'W' });
  });

  it.each([
    ['a short secret', { ...RECONCILE, secret: SECRET.slice(1) }],
    ['a short inner', { ...RECONCILE, inner: INNER.slice(1) }],
    ['an inner that isn’t canonical', { ...RECONCILE, inner: `${INNER.slice(0, 42)}B` }],
    ['a numeric seat', { ...RECONCILE, seat: 5 }],
    ['a seat that isn’t canonical', { ...RECONCILE, seat: `${SEAT.slice(0, 42)}B` }],
    ['no name', { ...RECONCILE, name: undefined }],
    ['a numeric title', { ...RECONCILE, title: 1 }],
    ['atoms that aren’t strings', { ...RECONCILE, atoms: [1] }],
  ])('refuses a reconcile Proposal with %s', (_label, target) => {
    const body = { target, title: 'Join C', why: 'W' };
    expect(parseEvent(json(envelope('proposal', body)))).toBeNull();
  });

  const KX = base64url(new Uint8Array(32).fill(7));
  const ADMIT = { kind: 'admit', seat: { name: 'Oak St', key: KEY }, proof: PROOF, kx: KX };

  it('reads an admit Proposal (#114), keeping its window and dropping text and unknown keys', () => {
    const body = {
      target: { ...ADMIT, seat: { ...ADMIT.seat, secret: SEAT }, extra: 1 },
      title: 'Admit Oak St',
      why: 'W',
      text: 'x',
      window: 5,
    };
    const parsed = parseEvent(json(envelope('proposal', body)));
    expect(parsed?.event.body).toEqual({
      target: ADMIT,
      title: 'Admit Oak St',
      why: 'W',
      window: 5,
    });
    const proposal = parsed?.event.type === 'proposal' ? parsed.event.body : null;
    expect(proposal !== null && isAdmitProposal(proposal)).toBe(true);
    expect(proposal !== null && isReconcileProposal(proposal)).toBe(false);
    const reconcile = parseEvent(
      json(envelope('proposal', { target: RECONCILE, title: 'T', why: 'W' })),
    );
    const other = reconcile?.event.type === 'proposal' ? reconcile.event.body : null;
    expect(other !== null && isAdmitProposal(other)).toBe(false);
  });

  it.each([
    ['no seat', { ...ADMIT, seat: undefined }],
    ['a seat without a name', { ...ADMIT, seat: { key: KEY } }],
    ['a seat whose key is short', { ...ADMIT, seat: { name: 'Oak St', key: KEY.slice(1) } }],
    ['no proof', { ...ADMIT, proof: undefined }],
    ['a short proof', { ...ADMIT, proof: PROOF.slice(1) }],
    ['a proof with a character base64url lacks', { ...ADMIT, proof: `${PROOF.slice(0, 85)}+` }],
    ['a numeric proof', { ...ADMIT, proof: 6 }],
    ['no kx (#313)', { ...ADMIT, kx: undefined }],
    ['a short kx (#313)', { ...ADMIT, kx: KX.slice(1) }],
    ['a kx that isn’t canonical (#313)', { ...ADMIT, kx: `${KX.slice(0, 42)}B` }],
    ['a numeric kx (#313)', { ...ADMIT, kx: 7 }],
  ])('refuses an admit Proposal with %s (#114)', (_label, target) => {
    const body = { target, title: 'Admit Oak St', why: 'W' };
    expect(parseEvent(json(envelope('proposal', body)))).toBeNull();
  });

  it('reads a seat’s stated level, a whole number from 0, on a genesis and an admit (#122)', () => {
    for (const level of [0, 1, 2, 3]) {
      const seats = [{ name: 'Riverside', key: KEY, level }, SEATS[1]];
      const parsed = parseEvent(json(envelope('genesis', { ...COALITION, seats })));
      expect(parsed?.event.body).toEqual({ ...COALITION, seats });
      const admit = { ...ADMIT, seat: { ...ADMIT.seat, level } };
      const body = { target: admit, title: 'Admit', why: 'W' };
      expect(parseEvent(json(envelope('proposal', body)))?.event.body).toEqual(body);
    }
  });

  it.each([
    ['a negative level', -1],
    ['a fractional level', 1.5],
    ['a level as text', '1'],
    ['a null level', null],
  ])('refuses a genesis and an admit whose seat states %s (#122)', (_label, level) => {
    const seats = [{ name: 'Riverside', key: KEY, level }, SEATS[1]];
    expect(parseEvent(json(envelope('genesis', { ...COALITION, seats })))).toBeNull();
    const admit = { ...ADMIT, seat: { ...ADMIT.seat, level } };
    const body = { target: admit, title: 'Admit', why: 'W' };
    expect(parseEvent(json(envelope('proposal', body)))).toBeNull();
  });

  it('keeps an admit’s member groups’ names, and refuses any that aren’t a list of names (#122)', () => {
    const groups = ['Hill Co-op', 'Elm Row'];
    const body = { target: { ...ADMIT, groups }, title: 'Admit', why: 'W' };
    expect(parseEvent(json(envelope('proposal', body)))?.event.body).toEqual(body);
    for (const bad of [[1], 'Hill Co-op', { a: 'b' }]) {
      const refused = { target: { ...ADMIT, groups: bad }, title: 'Admit', why: 'W' };
      expect(parseEvent(json(envelope('proposal', refused)))).toBeNull();
    }
  });

  const SEALED = {
    kind: 'reconcile',
    sealed: base64url(new Uint8Array(1024).fill(7)),
    key: KEY,
    name: 'D',
    title: 'T',
    atoms: ['One.'],
  };

  it('reads a coalition’s sealed reconcile target (#122): its field, key, name and statement', () => {
    const body = { target: { ...SEALED, extra: 1 }, title: 'Join D', why: 'W', window: 5 };
    const parsed = parseEvent(json(envelope('proposal', body)));
    expect(parsed?.event.body).toEqual({ target: SEALED, title: 'Join D', why: 'W', window: 5 });
    const proposal = parsed?.event.type === 'proposal' ? parsed.event.body : null;
    expect(proposal !== null && isSealedReconcileProposal(proposal)).toBe(true);
    expect(proposal !== null && isReconcileProposal(proposal)).toBe(false);
    const plain = parseEvent(
      json(envelope('proposal', { target: RECONCILE, title: 'T', why: 'W' })),
    );
    const other = plain?.event.type === 'proposal' ? plain.event.body : null;
    expect(other !== null && isSealedReconcileProposal(other)).toBe(false);
    expect(other !== null && isReconcileProposal(other)).toBe(true);
  });

  it.each([
    ['a secret beside it', { ...SEALED, secret: SECRET }],
    ['an inner beside it', { ...SEALED, inner: INNER }],
    ['a seat secret beside it', { ...SEALED, seat: SEAT }],
    ['a field one byte short', { ...SEALED, sealed: base64url(new Uint8Array(1023)) }],
    ['a field one byte long', { ...SEALED, sealed: base64url(new Uint8Array(1025)) }],
    ['a field of 4 KiB', { ...SEALED, sealed: base64url(new Uint8Array(4096)) }],
    ['a field that isn’t canonical', { ...SEALED, sealed: `${SEALED.sealed.slice(0, -1)}B` }],
    [
      'a field with a character base64url lacks',
      { ...SEALED, sealed: `+${SEALED.sealed.slice(1)}` },
    ],
    ['a numeric field', { ...SEALED, sealed: 7 }],
    ['no key', { ...SEALED, key: undefined }],
    ['a short key', { ...SEALED, key: KEY.slice(1) }],
    ['no name', { ...SEALED, name: undefined }],
    ['atoms that aren’t strings', { ...SEALED, atoms: [1] }],
  ])('refuses a sealed reconcile target with %s (#122)', (_label, target) => {
    const body = { target, title: 'Join D', why: 'W' };
    expect(parseEvent(json(envelope('proposal', body)))).toBeNull();
  });

  it('reads a group-result with exactly its motion, seat and result', () => {
    for (const result of ['pass', 'fail']) {
      const body = { motion: 'm1', seat: KEY, result };
      expect(parseEvent(json(envelope('group-result', body)))?.event).toEqual({
        v: 1,
        type: 'group-result',
        group: 'g1',
        author: ANA,
        ts: 1,
        body,
      });
    }
  });

  it.each([
    ['an extra key such as scores', { motion: 'm1', seat: KEY, result: 'pass', scores: {} }],
    ['an extra key such as note', { motion: 'm1', seat: KEY, result: 'fail', note: 'n' }],
    ['a result that is neither pass nor fail', { motion: 'm1', seat: KEY, result: 'lapse' }],
    ['no motion', { seat: KEY, result: 'pass' }],
    ['a numeric motion', { motion: 1, seat: KEY, result: 'pass' }],
    ['a short seat', { motion: 'm1', seat: KEY.slice(1), result: 'pass' }],
    ['no result', { motion: 'm1', seat: KEY }],
  ])('refuses a group-result with %s', (_label, body) => {
    expect(parseEvent(json(envelope('group-result', body)))).toBeNull();
  });
});

describe('a room wrap (#313)', () => {
  const SEAT = base64url(new Uint8Array(32).fill(5));
  const WRAP = base64url(new Uint8Array(104).fill(9));

  it('reads a room-wrap with exactly its seat and a wrap of a 32-byte box', () => {
    const body = { seat: SEAT, wrap: WRAP };
    expect(WRAP).toHaveLength(139);
    expect(parseEvent(json(envelope('room-wrap', body)))?.event).toEqual({
      v: 1,
      type: 'room-wrap',
      group: 'g1',
      author: ANA,
      ts: 1,
      body,
    });
  });

  it.each([
    ['an extra key such as inner', { seat: SEAT, wrap: WRAP, inner: SEAT }],
    ['an extra key such as a name', { seat: SEAT, wrap: WRAP, name: 'Oak St' }],
    ['no seat', { wrap: WRAP }],
    ['a short seat', { seat: SEAT.slice(1), wrap: WRAP }],
    ['no wrap', { seat: SEAT }],
    ['a numeric wrap', { seat: SEAT, wrap: 9 }],
    ['a wrap one byte short', { seat: SEAT, wrap: base64url(new Uint8Array(103).fill(9)) }],
    ['a wrap one byte long', { seat: SEAT, wrap: base64url(new Uint8Array(105).fill(9)) }],
    ['a wrap with a character base64url lacks', { seat: SEAT, wrap: `${WRAP.slice(0, 138)}+` }],
    ['a wrap that isn’t canonical', { seat: SEAT, wrap: `${WRAP.slice(0, 138)}B` }],
  ])('refuses a room-wrap with %s', (_label, body) => {
    expect(parseEvent(json(envelope('room-wrap', body)))).toBeNull();
  });
});

describe('a room message (#125)', () => {
  it('reads a message with exactly its text, as written', () => {
    for (const text of ['Can we meet Thursday?', '', '  <script>alert(1)</script>\n']) {
      expect(parseEvent(json(envelope('message', { text })))?.event).toEqual({
        v: 1,
        type: 'message',
        group: 'g1',
        author: ANA,
        ts: 1,
        body: { text },
      });
    }
  });

  it.each([
    ['an extra key such as a name', { text: 'Hi', name: 'Ana' }],
    ['an extra key such as a group', { text: 'Hi', group: 'g2' }],
    ['no text', {}],
    ['a numeric text', { text: 1 }],
    ['a list for text', { text: ['Hi'] }],
  ])('refuses a message with %s', (_label, body) => {
    expect(parseEvent(json(envelope('message', body)))).toBeNull();
  });

  it('signs a message as any event, its text in NFC', () => {
    const signed = signEvent(testKeys('ana').secretKey, {
      type: 'message',
      group: 'g1',
      ts: 7,
      body: { text: 'Café' },
    });
    expect(parseRecord(signed.record)?.event).toMatchObject({
      type: 'message',
      author: ANA,
      body: { text: 'Café' },
    });
  });
});
