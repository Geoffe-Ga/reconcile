/**
 * Personal Documents in a front-door application (#425; ADR-0077 §3,
 * ADR-0009): the copy's format, its cap, and what Send puts in the inbox.
 *
 * The cap is measured against the real limits: what is left of the largest
 * padded box once the longest application without documents is in it, every
 * code point of its name and message escaped to six bytes. An application
 * without documents stays byte for byte what the app wrote before, checked
 * against `vectors/door.json`'s application, which was made outside the app.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { kxPublicKeyOf } from '../crypto/box';
import {
  APPLICATION_INFO,
  doorChannelsOf,
  MAX_PADDED_PLAINTEXT,
  openPadded,
  sealPadded,
} from '../crypto/door';
import { PayloadTooLarge, xchachaSeal } from '../crypto/seal';
import { createRelay } from '../net/relay';
import { openStore } from '../store/db';
import type { PersonalEntry } from '../store/personal';
import { DOOR } from '../test/door';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import {
  type Application,
  apply,
  DOCUMENTS_MAX,
  DOCUMENTS_MAX_BYTES,
  documentsProblem,
  encodeApplication,
  MESSAGE_MAX,
  NAME_MAX,
  parseApplication,
} from './apply';
import { addressOf, type OpenPage } from './page';

freshIndexedDBPerTest();

/** `vectors/door.json`'s padded boxes, the application first. */
interface DoorFile {
  readonly boxes: readonly {
    readonly recipientSecret: readonly number[];
    readonly mailbox: readonly number[];
    readonly plaintext: readonly number[];
    readonly blob: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<DoorFile>('../crypto/vectors/door.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/door.json is missing.');

const encoder = new TextEncoder();
const textOf = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);
const listed = (bytes: Uint8Array) => Array.from(bytes);

const SEED = base64url(new Uint8Array(32).fill(3));
const KEY = base64url(kxPublicKeyOf(new Uint8Array(32).fill(4)));
const APPLICATION: Application = {
  name: 'Kim',
  message: 'I live at number 12.',
  reply: { seed: SEED, key: KEY },
};

/** A statement whose Markdown and address stay text. */
const STATEMENT = {
  title: 'What I stand for',
  text: '# Rent\n\nFair rents for all, see [our list](https://rent.test) and <b>this</b>.',
};

const ADDRESS = addressOf(DOOR);
const BOX_SECRET = fromBase64url(DOOR.box);
const BOX_PUBLIC = kxPublicKeyOf(BOX_SECRET);
const PAGE: OpenPage = {
  v: 1,
  open: true,
  name: 'Riverside Tenants',
  excerpt: 'We keep rents fair.',
  box: base64url(BOX_PUBLIC),
};
const { inbox: INBOX } = doorChannelsOf(ADDRESS);

/** The longest application without documents: every code point escapes to six bytes, `\u0000`. */
const WORST: Application = {
  ...APPLICATION,
  name: '\u0000'.repeat(NAME_MAX),
  message: '\u0000'.repeat(MESSAGE_MAX),
};

/** One document whose encoded list, `[{"title":"T","text":"…"}]`, is exactly `bytes` long. */
function listOf(bytes: number) {
  return [{ title: 'T', text: 'x'.repeat(bytes - '[{"title":"T","text":""}]'.length) }];
}

/** `application` sealed to the door's box for its inbox, then opened and parsed again. */
function throughTheInbox(application: Application) {
  const blob = sealPadded(BOX_PUBLIC, encodeApplication(application), APPLICATION_INFO, INBOX);
  const plaintext = openPadded(BOX_SECRET, blob, APPLICATION_INFO, INBOX);
  return { blob, read: plaintext === null ? null : parseApplication(plaintext) };
}

describe('an application without documents', () => {
  it('is byte for byte door.json’s application, made outside the app, and seals to its size', () => {
    const [vector] = file.boxes;
    if (vector === undefined) throw new Error('Expected door.json’s application.');
    const plaintext = Uint8Array.from(vector.plaintext);
    const read = parseApplication(plaintext);
    expect(read).not.toBeNull();
    expect(Object.keys(read ?? {})).toEqual(['name', 'message', 'reply']);
    expect(listed(encodeApplication(read ?? APPLICATION))).toEqual(listed(plaintext));
    const box = kxPublicKeyOf(Uint8Array.from(vector.recipientSecret));
    const mailbox = base64url(Uint8Array.from(vector.mailbox));
    const blob = sealPadded(box, encodeApplication(read ?? APPLICATION), APPLICATION_INFO, mailbox);
    expect(blob).toHaveLength(vector.blob.length);
  });

  it('writes no documents field, so it reads as it did before #425', () => {
    expect(textOf(encodeApplication(APPLICATION))).toBe(
      `{"name":"Kim","message":"I live at number 12.","reply":{"seed":"${SEED}","key":"${KEY}"}}`,
    );
    expect(parseApplication(encodeApplication(APPLICATION))).toEqual(APPLICATION);
  });
});

describe('an application with documents', () => {
  it('writes them last, each its title then its text, and reads them back as sent', () => {
    const application = { ...APPLICATION, documents: [STATEMENT] };
    expect(textOf(encodeApplication(application))).toBe(
      `{"name":"Kim","message":"I live at number 12.","reply":{"seed":"${SEED}","key":"${KEY}"},` +
        `"documents":[{"title":"What I stand for","text":${JSON.stringify(STATEMENT.text)}}]}`,
    );
    expect(parseApplication(encodeApplication(application))).toEqual(application);
  });

  it('carries 1 to 3, each a title of 1 to 120 code points and any text, the empty text too', () => {
    expect(DOCUMENTS_MAX).toBe(3);
    const three = [STATEMENT, { title: '😀'.repeat(120), text: '' }, { title: 'C', text: 'c' }];
    const application = { ...APPLICATION, documents: three };
    expect(parseApplication(encodeApplication(application))).toEqual(application);
  });

  it.each([
    ['no documents in the list', []],
    ['four documents', [STATEMENT, STATEMENT, STATEMENT, STATEMENT]],
    ['a list that isn’t one', { title: 'A', text: 'a' }],
    ['null', null],
    ['a document with its id', [{ ...STATEMENT, id: 'AAAAAAAAAAAAAAAAAAAAAA' }]],
    ['a document with no text', [{ title: 'A' }]],
    ['a blank title', [{ title: '  ', text: 'a' }]],
    ['a title of 121 code points', [{ title: 't'.repeat(121), text: 'a' }]],
    ['text that isn’t text', [{ title: 'A', text: 7 }]],
    ['a document that isn’t an object', ['A']],
  ])('is refused whole with %s', (_name, documents) => {
    const value = { ...APPLICATION, documents };
    expect(parseApplication(encoder.encode(JSON.stringify(value)))).toBeNull();
  });

  it('round-trips any titles and texts within the limits (fast-check)', () => {
    const title = fc.string({ minLength: 1, maxLength: 120 }).filter((text) => text.trim() !== '');
    const documents = fc.array(fc.record({ title, text: fc.string({ maxLength: 400 }) }), {
      minLength: 1,
      maxLength: 3,
    });
    fc.assert(
      fc.property(documents, (list) => {
        const application = { ...APPLICATION, documents: list };
        expect(parseApplication(encodeApplication(application))).toEqual(application);
      }),
      { numRuns: 50 },
    );
  });
});

describe('the cap on documents, measured against the padding and the blob sizes', () => {
  it('is what the largest padded box has left beside the longest application without them', () => {
    expect(encodeApplication(WORST)).toHaveLength(12_859);
    const field = ',"documents":'.length;
    expect(DOCUMENTS_MAX_BYTES).toBe(MAX_PADDED_PLAINTEXT - 12_859 - field);
    expect(DOCUMENTS_MAX_BYTES).toBe(52_588);
  });

  it('fits the longest application with documents at the cap in one 64 KiB blob, read back whole', () => {
    const application = { ...WORST, documents: listOf(DOCUMENTS_MAX_BYTES) };
    expect(encodeApplication(application)).toHaveLength(MAX_PADDED_PLAINTEXT);
    const { blob, read } = throughTheInbox(application);
    expect(blob).toHaveLength(65_536);
    expect(read).toEqual(application);
  });

  it('refuses one byte over it, at the form and in the parser, and the blob can’t hold it', () => {
    const over = listOf(DOCUMENTS_MAX_BYTES + 1);
    expect(documentsProblem(listOf(DOCUMENTS_MAX_BYTES))).toBeNull();
    expect(documentsProblem(over)).toBe('too-long');
    const small = { ...APPLICATION, documents: over };
    expect(parseApplication(encodeApplication(small))).toBeNull();
    expect(() => throughTheInbox({ ...WORST, documents: over })).toThrow(PayloadTooLarge);
  });

  it('counts each code point as its encoding does, escapes included', () => {
    const control = [{ title: 'T', text: '\u0001'.repeat(10) }];
    expect(documentsProblem(listOf(DOCUMENTS_MAX_BYTES - 50).concat(control))).toBe('too-long');
    expect(documentsProblem([STATEMENT, STATEMENT, STATEMENT, STATEMENT])).toBe('too-many');
    expect(documentsProblem([])).toBeNull();
  });

  it('keeps a short application with a short document in the smallest blob, as one without', () => {
    const { blob } = throughTheInbox({ ...APPLICATION, documents: [STATEMENT] });
    expect(blob).toHaveLength(1024);
  });
});

/** An applicant's services on `fake`, with its own store. */
async function applicant(fake = createFakeRelay()) {
  const store = await openStore('applicant');
  const relay = createRelay({ fetch: fake.fetch });
  return { fake, store, relay, seal: xchachaSeal, now: () => 1_762_650_000_000 };
}

/** The one PUT's blob, opened with the door's box secret, as JSON. */
function sentJson(services: Awaited<ReturnType<typeof applicant>>): Record<string, unknown> {
  const [request, ...more] = services.fake.requests;
  if (request === undefined || more.length > 0) throw new Error('Expected exactly one request.');
  const plaintext = openPadded(
    BOX_SECRET,
    request.body ?? new Uint8Array(),
    APPLICATION_INFO,
    INBOX,
  );
  return JSON.parse(textOf(plaintext) ?? 'null') as Record<string, unknown>;
}

/** Kim's statement as Personal holds it: its id, times and a share's mark beside its words. */
const HELD: PersonalEntry = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  title: 'What I stand for',
  text: 'Café rents.',
  createdAt: 1,
  updatedAt: 2,
  share: { n: 3, postedAt: 29_000_004, pending: false },
};

describe('apply with documents', () => {
  it('seals a copy of only each title and text, in NFC, inside the one application', async () => {
    const services = await applicant();
    const values = { name: 'Kim', message: 'Hi.', documents: [HELD] };
    expect(await apply(services, ADDRESS, PAGE, values)).toBe('sent');
    const json = sentJson(services);
    expect(Object.keys(json)).toEqual(['name', 'message', 'reply', 'documents']);
    expect(json.documents).toEqual([{ title: 'What I stand for', text: 'Café rents.' }]);
    const words = JSON.stringify(json);
    for (const held of [HELD.id, '"createdAt"', '"share"', '"id"']) {
      expect(words).not.toContain(held);
    }
    services.store.close();
  });

  it('keeps no copy on the applicant’s device: what it sent stays its own Document', async () => {
    const services = await applicant();
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.', documents: [HELD] });
    const [kept] = await services.store.listSent();
    expect(Object.keys(kept ?? {}).sort()).toEqual([
      'door',
      'groupName',
      'id',
      'replyKey',
      'seed',
      'sentAt',
    ]);
    services.store.close();
  });

  it('sends an empty choice as an application without documents', async () => {
    const services = await applicant();
    await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.', documents: [] });
    expect(Object.keys(sentJson(services))).toEqual(['name', 'message', 'reply']);
    services.store.close();
  });

  it('sends nothing, and keeps nothing, when the documents are over the cap', async () => {
    const services = await applicant();
    const documents = listOf(DOCUMENTS_MAX_BYTES + 1);
    expect(await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.', documents })).toBe(
      'failed',
    );
    const four = [STATEMENT, STATEMENT, STATEMENT, STATEMENT];
    expect(
      await apply(services, ADDRESS, PAGE, { name: 'Kim', message: 'Hi.', documents: four }),
    ).toBe('failed');
    expect(services.fake.requests).toEqual([]);
    expect(await services.store.listSent()).toEqual([]);
    services.store.close();
  });
});
