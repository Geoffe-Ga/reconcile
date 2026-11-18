/**
 * The steward's inbox on the steward's device (#490; listed-doors.md §6.3,
 * §6.4): it reads after the cursor it keeps, opens reports and appeals with
 * the steward's box secret, drops what doesn't open, parse or verify, and
 * lists the rest newest first, until the relay has surely let them go.
 */
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { doorKeysOf, sealPadded } from '../crypto/door';
import { APPEAL_INFO, REPORT_INFO, signAppeal, stewardInboxOf } from '../crypto/shelf';
import { newSigningKeys } from '../crypto/sign';
import { createRelay } from '../net/relay';
import { DOOR } from '../test/door';
import { createFakeRelay, type FakeRelay } from '../test/fakeRelay';
import { TEST_STEWARD } from '../test/steward';
import { INBOX_KEEP_MINUTES, type InboxKeep, type KeptInbox, readStewardInbox } from './inbox';
import { encodeAppeal, sendAppeal, sendReport } from './report';

const ADDRESS = base64url(
  doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box)).signing.publicKey,
);
const ENTRY = base64url(new Uint8Array(32).fill(4));
const INBOX = stewardInboxOf(TEST_STEWARD.box.publicKey);

/** A keep in memory, recording each write. */
function keepOf(initial?: KeptInbox) {
  let held = initial;
  const writes: (KeptInbox | null)[] = [];
  const keep: InboxKeep = {
    getStewardInbox: () => Promise.resolve(held),
    keepStewardInbox: (kept) => {
      writes.push(kept);
      held = kept ?? undefined;
      return Promise.resolve();
    },
  };
  return { keep, writes, held: () => held };
}

/** The steward's device reading `fake`'s inbox through `keep`. */
const read = (fake: FakeRelay, keep: InboxKeep) =>
  readStewardInbox({ relay: createRelay({ fetch: fake.fetch }), keep }, TEST_STEWARD.box.secretKey);

/** A sender on `fake`. */
const sender = (fake: FakeRelay) => ({ relay: createRelay({ fetch: fake.fetch }) });

describe('readStewardInbox', () => {
  it('lists reports and appeals newest first, each with what it names', async () => {
    const fake = createFakeRelay();
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C3', note: 'Fake' });
    fake.minute += 5;
    await sendAppeal(sender(fake), DOOR, { id: ENTRY, note: 'We are real.' });
    const { keep } = keepOf();

    const items = await read(fake, keep);

    expect(
      items.map(({ kind, address, id, clause, note, received }) => ({
        kind,
        address,
        id,
        clause,
        note,
        received,
      })),
    ).toEqual([
      {
        kind: 'appeal',
        address: ADDRESS,
        id: ENTRY,
        clause: null,
        note: 'We are real.',
        received: fake.minute,
      },
      {
        kind: 'report',
        address: ADDRESS,
        id: ENTRY,
        clause: 'C3',
        note: 'Fake',
        received: fake.minute - 5,
      },
    ]);
  });

  it('reads only after the cursor it keeps, and keeps what it read before', async () => {
    const fake = createFakeRelay();
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C1' });
    const { keep, held } = keepOf();
    await read(fake, keep);
    const cursor = held()?.cursor ?? 0;
    expect(cursor).toBeGreaterThan(0);

    fake.minute += 1;
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C2' });
    const asked = fake.requests.length;
    const items = await read(fake, keep);

    expect(items.map((item) => item.clause)).toEqual(['C2', 'C1']);
    const gets = fake.requests.slice(asked).map((request) => request.url);
    expect(gets).toEqual([`/v1/mailbox/${INBOX}?after=${String(cursor)}&limit=100`]);
    expect(held()?.items).toHaveLength(2);
  });

  it('drops an appeal whose signature doesn’t verify, and anything that doesn’t open or parse', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const box = TEST_STEWARD.box.publicKey;
    // An appeal naming the door's address, signed by another key.
    const forged = signAppeal(newSigningKeys(), encodeAppeal({ address: ADDRESS, note: 'Mine' }));
    await relay.putBlob(INBOX, sealPadded(box, forged, APPEAL_INFO, INBOX, 4096), 30);
    // Junk under the report label, and a box sealed to someone else.
    await relay.putBlob(INBOX, sealPadded(box, new Uint8Array([1, 2]), REPORT_INFO, INBOX), 30);
    const elsewhere = newSigningKeys().publicKey;
    await relay.putBlob(INBOX, sealPadded(elsewhere, new Uint8Array(3), REPORT_INFO, INBOX), 30);
    await sendAppeal(sender(fake), DOOR, { note: 'Ours' });
    const { keep, held } = keepOf();

    const items = await read(fake, keep);

    expect(items.map((item) => item.note)).toEqual(['Ours']);
    // The cursor passes what it dropped, so it's never read again.
    expect(held()?.cursor).toBe(4);
  });

  it('keeps one copy of a blob the relay serves twice', async () => {
    const fake = createFakeRelay();
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C1' });
    const [blob] = fake.blobs(INBOX);
    if (blob === undefined) throw new Error('Expected the report.');
    await createRelay({ fetch: fake.fetch }).putBlob(INBOX, Uint8Array.from(blob), 30);

    expect(await read(fake, keepOf().keep)).toHaveLength(1);
  });

  it('reads a new relay from the start, and keeps what it held', async () => {
    const fake = createFakeRelay();
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C1' });
    const { keep } = keepOf();
    await read(fake, keep);
    fake.restart();
    fake.minute += 1;
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C2' });

    expect((await read(fake, keep)).map((item) => item.clause)).toEqual(['C2', 'C1']);
  });

  it('starts afresh for another inbox, and forgets what the relay has surely let go', async () => {
    const fake = createFakeRelay();
    const stale: KeptInbox = {
      inbox: 'another-inbox'.padEnd(43, '0'),
      instance: fake.instance,
      cursor: 99,
      items: [
        {
          key: 'k',
          kind: 'report',
          seq: 1,
          received: 0,
          address: ADDRESS,
          id: ENTRY,
          clause: 'C1',
          note: null,
        },
      ],
    };
    await sendReport(sender(fake), { address: ADDRESS, id: ENTRY, clause: 'C2' });
    const { keep } = keepOf(stale);
    expect((await read(fake, keep)).map((item) => item.clause)).toEqual(['C2']);

    fake.minute += INBOX_KEEP_MINUTES - 1;
    expect(await read(fake, keep)).toHaveLength(1);
    fake.minute += 1;
    expect(await read(fake, keep)).toEqual([]);
    expect(INBOX_KEEP_MINUTES).toBe(32 * 1440);
  });
});
