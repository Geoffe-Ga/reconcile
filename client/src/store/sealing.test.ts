/**
 * Records that keep their secrets in the vault (#255, #265): how a shared
 * personal Document and a sent application split into what IndexedDB keeps
 * and what the vault keeps, and join again.
 */
import { describe, expect, it } from 'vitest';

import { local } from '../test/bytes';
import { replySealing, type SentApplication, type StoredSent } from './applications';
import { type PersonalDocument, shareSealing, type StoredDocument } from './personal';
import { plainRecords, wholeRecord } from './sealing';
import type { Secrets } from './vault';

const SEED = new Uint8Array(32).fill(0x61);
const SECRET_KEY = new Uint8Array(32).fill(0x62);
const PUBLIC_KEY = new Uint8Array(32).fill(0x63);
const REPLY_SEED = new Uint8Array(32).fill(0x64);
const REPLY_KEY = new Uint8Array(32).fill(0x65);
const INVITE = new Uint8Array(32).fill(0x66);

const WORDS = { id: 'doc-1', title: 'Mine', text: 'Kind.', createdAt: 1, updatedAt: 2 };
const MARK = { n: 3, lastPostedAt: 9, pending: false };

/** A Document shared by link, whole. */
const SHARED: PersonalDocument = {
  ...WORDS,
  share: { ...MARK, seed: SEED, secretKey: SECRET_KEY, publicKey: PUBLIC_KEY },
};

/** An application this device sent, whole, before a reply opened. */
const SENT: SentApplication = {
  id: 'app-1',
  door: 'door-1',
  groupName: 'Riverside Tenants',
  seed: REPLY_SEED,
  replyKey: REPLY_KEY,
  sentAt: 5,
};

/** `secrets` with their bytes in the test's realm, so `toEqual` can compare them. */
function comparable(secrets: Secrets | null | undefined) {
  if (secrets === null || secrets === undefined) return secrets;
  return Object.fromEntries(Object.entries(secrets).map(([name, bytes]) => [name, local(bytes)]));
}

describe('shareSealing (#255)', () => {
  it('takes a share’s seed, signing key and public key out, leaving its mark on the record', () => {
    const { kept, secrets } = shareSealing.split(SHARED);

    expect(kept).toEqual({ ...WORDS, share: MARK });
    expect(comparable(secrets)).toEqual({
      seed: local(SEED),
      secretKey: local(SECRET_KEY),
      publicKey: local(PUBLIC_KEY),
    });
    expect(shareSealing.join(kept, secrets ?? undefined)).toEqual(SHARED);
  });

  it('leaves a Document with no share, or one already without its keys, as it is', () => {
    const marked: StoredDocument = { ...WORDS, share: MARK };

    expect(shareSealing.split(WORDS)).toEqual({ kept: WORDS, secrets: null });
    expect(shareSealing.split(marked)).toEqual({ kept: marked, secrets: null });
    expect(shareSealing.hasSecrets(WORDS)).toBe(false);
    expect(shareSealing.hasSecrets(marked)).toBe(true);
    expect(shareSealing.hasSecrets(SHARED)).toBe(true);
  });

  it.each([
    ['its seed', { secretKey: SECRET_KEY, publicKey: PUBLIC_KEY }],
    ['its signing key', { seed: SEED, publicKey: PUBLIC_KEY }],
    ['its public key', { seed: SEED, secretKey: SECRET_KEY }],
  ])(
    'takes nothing out of a share that lacks %s, and can’t make one whole without it',
    (_, keys) => {
      const partial = { ...WORDS, share: { ...MARK, ...keys } };

      expect(shareSealing.split(partial)).toEqual({ kept: partial, secrets: null });
      expect(shareSealing.join({ ...WORDS, share: MARK }, keys)).toBeNull();
    },
  );

  it('keeps a paused share’s pause on its mark, so a share a restore brought back stays paused (#328)', () => {
    const pausedMark = { ...MARK, paused: true as const };
    const paused: PersonalDocument = {
      ...WORDS,
      share: { ...pausedMark, seed: SEED, secretKey: SECRET_KEY, publicKey: PUBLIC_KEY },
    };

    const { kept, secrets } = shareSealing.split(paused);

    expect(kept).toEqual({ ...WORDS, share: pausedMark });
    expect(shareSealing.join(kept, secrets ?? undefined)).toEqual(paused);
    expect(wholeRecord(shareSealing, kept, secrets ?? undefined)).toEqual(paused);
  });

  it('makes a Document with no share whole with no secrets, and a marked one only with them', () => {
    expect(shareSealing.join(WORDS, undefined)).toEqual(WORDS);
    expect(shareSealing.join({ ...WORDS, share: MARK }, undefined)).toBeNull();
  });
});

describe('replySealing (#265)', () => {
  it('takes the reply seed and key out, leaving what Your groups shows', () => {
    const { kept, secrets } = replySealing.split(SENT);

    expect(kept).toEqual({
      id: 'app-1',
      door: 'door-1',
      groupName: 'Riverside Tenants',
      sentAt: 5,
    });
    expect(comparable(secrets)).toEqual({ seed: local(REPLY_SEED), replyKey: local(REPLY_KEY) });
    expect(replySealing.join(kept, secrets ?? undefined)).toEqual(SENT);
  });

  it('takes an invite’s seed out with them once a reply opened', () => {
    const invited = { ...SENT, invite: INVITE };

    const { kept, secrets } = replySealing.split(invited);

    expect(Object.keys(kept).sort()).toEqual(['door', 'groupName', 'id', 'sentAt']);
    expect(comparable(secrets)).toEqual({
      seed: local(REPLY_SEED),
      replyKey: local(REPLY_KEY),
      invite: local(INVITE),
    });
    expect(replySealing.join(kept, secrets ?? undefined)).toEqual(invited);
  });

  it('always has secrets, and leaves a record already without them as it is', () => {
    const { kept } = replySealing.split(SENT);

    expect(replySealing.hasSecrets(kept)).toBe(true);
    expect(replySealing.split(kept)).toEqual({ kept, secrets: null });
    expect(replySealing.join(kept, undefined)).toBeNull();
    expect(replySealing.join(kept, { seed: REPLY_SEED })).toBeNull();
    expect(replySealing.join(kept, { replyKey: REPLY_KEY })).toBeNull();
  });

  it('takes nothing out of a record that lacks its reply key', () => {
    const stored: StoredSent = {
      id: SENT.id,
      door: SENT.door,
      groupName: SENT.groupName,
      seed: SENT.seed,
      sentAt: SENT.sentAt,
    };

    expect(replySealing.split(stored)).toEqual({ kept: stored, secrets: null });
  });
});

describe('wholeRecord and plainRecords', () => {
  it('make a record whole with the secrets it holds itself before the vault’s', () => {
    const other: Secrets = { seed: SEED, secretKey: SECRET_KEY, publicKey: REPLY_KEY };

    expect(wholeRecord(shareSealing, SHARED, other)).toEqual(SHARED);
    expect(wholeRecord(shareSealing, { ...WORDS, share: MARK }, other)).toEqual({
      ...WORDS,
      share: { ...MARK, ...other },
    });
    expect(wholeRecord(shareSealing, WORDS, undefined)).toEqual(WORDS);
  });

  it('refuse a record whose secrets are nowhere', () => {
    expect(() => wholeRecord(replySealing, replySealing.split(SENT).kept, undefined)).toThrow(
      'A record’s keys are missing from this device.',
    );
  });

  it('pick out the records that still hold their secrets in the clear, whole', () => {
    const marked: StoredDocument = { ...WORDS, id: 'doc-2', share: MARK };
    const other = { ...SHARED, id: 'doc-3' };

    expect(plainRecords(shareSealing, [WORDS, SHARED, marked, other])).toEqual([SHARED, other]);
    expect(plainRecords(replySealing, [replySealing.split(SENT).kept])).toEqual([]);
  });
});
