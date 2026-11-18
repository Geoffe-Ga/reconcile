/**
 * Reports and appeals to the steward (#490; listed-doors.md §6.3): each is
 * one padded box sealed to the steward's pinned box key and PUT to the
 * steward's inbox for 30 days, with no wake, every one the same size. A
 * report names an entry, a clause and maybe a note, and nothing about the
 * reader; an appeal is signed with the door's key. With no pinned steward,
 * nothing is sent.
 */
import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from '../crypto/base64url';
import { openPadded, sealPadded } from '../crypto/door';
import { doorKeysOf } from '../crypto/door';
import { APPEAL_INFO, REPORT_INFO, signAppeal, stewardInboxOf } from '../crypto/shelf';
import { newSigningKeys } from '../crypto/sign';
import { objectIn } from '../crypto/json';
import type { PutOptions } from '../net/relay';
import { DOOR } from '../test/door';
import { TEST_PINS, TEST_STEWARD } from '../test/steward';
import {
  APPEAL_NOTE_MAX,
  encodeAppeal,
  encodeReport,
  NOTE_MAX,
  openAppeal,
  parseReport,
  sendAppeal,
  sendReport,
  STEWARD_BLOB_SIZE,
  STEWARD_TTL_DAYS,
} from './report';

const DOOR_KEYS = doorKeysOf(fromBase64url(DOOR.sign), fromBase64url(DOOR.box)).signing;
const ADDRESS = base64url(DOOR_KEYS.publicKey);
const ENTRY = base64url(new Uint8Array(32).fill(4));
const INBOX = stewardInboxOf(TEST_STEWARD.box.publicKey);

/** One PUT the relay got. */
interface Put {
  readonly mailbox: string;
  readonly blob: Uint8Array;
  readonly ttl: number | undefined;
  readonly options: PutOptions | undefined;
}

/** A relay that records each PUT, or refuses every one. */
function relayOf(refuse = false) {
  const puts: Put[] = [];
  return {
    puts,
    relay: {
      putBlob: (mailbox: string, blob: Uint8Array, ttl?: number, options?: PutOptions) => {
        if (refuse) return Promise.reject(new Error('offline'));
        puts.push({ mailbox, blob, ttl, options });
        return Promise.resolve(puts.length);
      },
    },
  };
}

/** The plaintext of `put`, opened as the steward under `info`. */
function openAsSteward(put: Put | undefined, info: string): Uint8Array {
  if (put === undefined) throw new Error('Nothing was PUT.');
  const plaintext = openPadded(TEST_STEWARD.box.secretKey, put.blob, info, put.mailbox);
  if (plaintext === null) throw new Error('The steward couldn’t open it.');
  return plaintext;
}

describe('sendReport', () => {
  it('sends a report that names the entry and nothing about the reader', async () => {
    const { relay, puts } = relayOf();
    const sent = await sendReport(
      { relay },
      { address: ADDRESS, id: ENTRY, clause: 'C3', note: ' Not the real union ' },
    );

    expect(sent).toBe('sent');
    expect(puts).toHaveLength(1);
    const [put] = puts;
    expect(put?.mailbox).toBe(INBOX);
    expect(put?.ttl).toBe(30);
    expect(put?.options).toBeUndefined();
    expect(put?.blob).toHaveLength(4096);
    const opened = objectIn(openAsSteward(put, REPORT_INFO)) ?? {};
    expect(Object.keys(opened).sort()).toEqual(['address', 'clause', 'id', 'note']);
    expect(opened).toEqual({
      address: ADDRESS,
      id: ENTRY,
      clause: 'C3',
      note: 'Not the real union',
    });
    // Never as an appeal.
    const blob = put?.blob ?? new Uint8Array();
    expect(openPadded(TEST_STEWARD.box.secretKey, blob, APPEAL_INFO, INBOX)).toBeNull();
  });

  it('leaves out a blank note, and sends every report at one size', async () => {
    const { relay, puts } = relayOf();
    await sendReport({ relay }, { address: ADDRESS, id: ENTRY, clause: 'C1', note: '  ' });
    await sendReport({ relay }, { address: ADDRESS, id: ENTRY, clause: 'C2' });
    await sendReport(
      { relay },
      { address: ADDRESS, id: ENTRY, clause: 'C2', note: '\u0000'.repeat(NOTE_MAX) },
    );

    expect(puts.map((put) => put.blob.length)).toEqual([4096, 4096, 4096]);
    expect(objectIn(openAsSteward(puts[0], REPORT_INFO))).toEqual({
      address: ADDRESS,
      id: ENTRY,
      clause: 'C1',
    });
  });

  it('sends nothing for a note past 500 code points, or with no steward pinned', async () => {
    const { relay, puts } = relayOf();
    const long = { address: ADDRESS, id: ENTRY, clause: 'C1', note: 'é'.repeat(501) } as const;
    expect(await sendReport({ relay }, long)).toBe('failed');
    const report = { address: ADDRESS, id: ENTRY, clause: 'C1' } as const;
    expect(await sendReport({ relay, pins: null }, report)).toBe('failed');
    expect(puts).toEqual([]);
    expect(NOTE_MAX).toBe(500);
    expect(STEWARD_TTL_DAYS).toBe(30);
    expect(STEWARD_BLOB_SIZE).toBe(4096);
  });

  it('answers failed when the relay can’t be reached', async () => {
    const { relay } = relayOf(true);
    const report = { address: ADDRESS, id: ENTRY, clause: 'C1' } as const;
    expect(await sendReport({ relay }, report)).toBe('failed');
  });
});

describe('parseReport', () => {
  const good = { address: ADDRESS, id: ENTRY, clause: 'C2', note: 'Spam' };
  const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it('reads a report with or without a note', () => {
    expect(parseReport(bytesOf(good))).toEqual(good);
    expect(parseReport(encodeReport({ address: ADDRESS, id: ENTRY, clause: 'C1' }))).toEqual({
      address: ADDRESS,
      id: ENTRY,
      clause: 'C1',
    });
  });

  it('refuses anything but exactly an address, an entry id, a clause and a note in bounds', () => {
    for (const bad of [
      { ...good, clause: 'C4' },
      { ...good, address: 'nope' },
      { ...good, id: 'nope' },
      { ...good, note: 'x'.repeat(501) },
      { ...good, note: 7 },
      { ...good, reporter: 'Ana' },
      { address: ADDRESS, clause: 'C1' },
      [good],
    ]) {
      expect(parseReport(bytesOf(bad))).toBeNull();
    }
    expect(parseReport(new Uint8Array([0xff]))).toBeNull();
  });
});

describe('sendAppeal', () => {
  it('signs the appeal with the door’s key and seals it to the steward, the size of a report', async () => {
    const { relay, puts } = relayOf();
    const sent = await sendAppeal({ relay }, DOOR, { id: ENTRY, note: ' We are the real union. ' });

    expect(sent).toBe('sent');
    const [put] = puts;
    expect(put?.mailbox).toBe(INBOX);
    expect(put?.ttl).toBe(30);
    expect(put?.options).toBeUndefined();
    expect(put?.blob).toHaveLength(4096);
    expect(openAppeal(openAsSteward(put, APPEAL_INFO))).toEqual({
      address: ADDRESS,
      id: ENTRY,
      note: 'We are the real union.',
    });
    const blob = put?.blob ?? new Uint8Array();
    expect(openPadded(TEST_STEWARD.box.secretKey, blob, REPORT_INFO, INBOX)).toBeNull();
  });

  it('names no entry for an appeal about the whole listing', async () => {
    const { relay, puts } = relayOf();
    await sendAppeal({ relay }, DOOR, { note: 'Please look again' });
    expect(openAppeal(openAsSteward(puts[0], APPEAL_INFO))).toEqual({
      address: ADDRESS,
      note: 'Please look again',
    });
  });

  it('sends nothing for a blank or overlong note, with no steward, or offline', async () => {
    const { relay, puts } = relayOf();
    expect(await sendAppeal({ relay }, DOOR, { note: ' ' })).toBe('failed');
    expect(await sendAppeal({ relay }, DOOR, { note: 'x'.repeat(APPEAL_NOTE_MAX + 1) })).toBe(
      'failed',
    );
    expect(await sendAppeal({ relay, pins: null }, DOOR, { note: 'Look' })).toBe('failed');
    expect(puts).toEqual([]);
    expect(await sendAppeal(relayOf(true), DOOR, { note: 'Look' })).toBe('failed');
  });

  it('fits the longest appeal in the same one size', async () => {
    const { relay, puts } = relayOf();
    await sendAppeal({ relay }, DOOR, { id: ENTRY, note: '\u0000'.repeat(APPEAL_NOTE_MAX) });
    expect(puts[0]?.blob).toHaveLength(4096);
  });
});

describe('openAppeal', () => {
  const message = encodeAppeal({ address: ADDRESS, note: 'Look again' });

  it('drops an appeal whose signature doesn’t verify against the address it names', () => {
    const other = newSigningKeys();
    expect(openAppeal(signAppeal(other, message))).toBeNull();
    const signed = signAppeal(DOOR_KEYS, message);
    signed[70] = (signed[70] ?? 0) ^ 1;
    expect(openAppeal(signed)).toBeNull();
  });

  it('drops a signed message that isn’t an appeal', () => {
    const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const bad of [
      { address: ADDRESS },
      { address: ADDRESS, note: '' },
      { address: ADDRESS, note: 'x', clause: 'C1' },
      { address: ADDRESS, id: 'nope', note: 'x' },
      { address: ADDRESS, note: 'x'.repeat(APPEAL_NOTE_MAX + 1) },
    ]) {
      expect(openAppeal(signAppeal(DOOR_KEYS, bytesOf(bad)))).toBeNull();
    }
    expect(openAppeal(new Uint8Array(10))).toBeNull();
  });

  it('never opens a report sealed under the appeal label as one', () => {
    const report = encodeReport({ address: ADDRESS, id: ENTRY, clause: 'C1' });
    const blob = sealPadded(fromBase64url(TEST_PINS.box), report, APPEAL_INFO, INBOX);
    const plaintext = openPadded(TEST_STEWARD.box.secretKey, blob, APPEAL_INFO, INBOX);
    expect(plaintext === null ? null : openAppeal(plaintext)).toBeNull();
  });
});
