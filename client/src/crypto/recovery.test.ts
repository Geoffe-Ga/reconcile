import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { local, text, utf8 } from '../test/bytes';
import { base64url, fromBase64url } from './base64url';
import { kxPublicKeyOf, newKxKey, sealTo } from './box';
import {
  ALERT_TAG_BYTES,
  newAlertTag,
  newRecoveryKeys,
  openAlert,
  openRelease,
  parseRecoveryCode,
  RECOVERY_ALERT_INFO,
  RECOVERY_RELEASE_INFO,
  RECOVERY_SEED_BYTES,
  recoveryChannel,
  recoveryCheck,
  recoveryCode,
  recoveryNumber,
  sealAlert,
  sealRelease,
} from './recovery';
import { BLOB_SIZES, xchachaSeal } from './seal';
import type { RecoveryShare } from './shares';

/** `vectors/recovery.json`: a code, its check, its channel, a release and an alert, made outside @noble. */
interface RecoveryFile {
  readonly kind: 'recovery';
  readonly seed: readonly number[];
  readonly requestSecret: readonly number[];
  readonly requestPublic: readonly number[];
  readonly code: string;
  readonly check: string;
  /** The second number (#398), from the new device's secret key. */
  readonly number: string;
  readonly mailbox: readonly number[];
  readonly sealKey: readonly number[];
  readonly release: {
    readonly split: string;
    readonly t: number;
    readonly n: number;
    readonly share: readonly number[];
    readonly number: string;
    readonly plaintext: readonly number[];
    readonly box: readonly number[];
    readonly blob: readonly number[];
  };
  /** A release from before #398, with no second number. */
  readonly releaseV1: {
    readonly plaintext: readonly number[];
    readonly box: readonly number[];
    readonly blob: readonly number[];
  };
  readonly alert: {
    readonly groupId: string;
    readonly person: string;
    readonly personSecret: readonly number[];
    readonly personPublic: readonly number[];
    readonly split: string;
    readonly tag: string;
    readonly plaintext: readonly number[];
    readonly box: readonly number[];
  };
}

const [file] = Object.values(
  import.meta.glob<RecoveryFile>('./vectors/recovery.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/recovery.json is missing.');
const known = file;

const bytes = (values: readonly number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const SEED = bytes(known.seed);
const REQUEST_SECRET = bytes(known.requestSecret);
const REQUEST_PUBLIC = bytes(known.requestPublic);
const GROUP = known.alert.groupId;
const PERSON = known.alert.person;
const OTHER = 'someone-else-in-the-recovery-test'.padEnd(43, '2');
const MAILBOX = text(bytes(known.mailbox));
const ALERT_BOX = base64url(bytes(known.alert.box));
const RELEASE_PLAINTEXT = text(bytes(known.release.plaintext));
const ALERT_PLAINTEXT = text(bytes(known.alert.plaintext));

/** A share to release: the vector's. */
const SHARE: RecoveryShare = {
  split: known.release.split,
  t: known.release.t,
  n: known.release.n,
  share: bytes(known.release.share),
};

describe('the recovery code', () => {
  it('is RR1. and the base64url of the seed and the new device’s key, as Python made it', () => {
    expect(recoveryCode({ seed: SEED, publicKey: REQUEST_PUBLIC })).toBe(known.code);
    const parsed = parseRecoveryCode(known.code);
    expect(local(parsed?.seed ?? new Uint8Array())).toEqual(SEED);
    expect(local(parsed?.publicKey ?? new Uint8Array())).toEqual(REQUEST_PUBLIC);
    expect(parsed?.code).toBe(known.code);
  });

  it('is found in whatever was pasted around it, and read the same', () => {
    for (const text of [
      `  ${known.code}\n`,
      `My Reconcile recovery code: ${known.code} https://reconcile.example/`,
      `${known.code}.`,
    ]) {
      expect(parseRecoveryCode(text)?.code).toBe(known.code);
    }
  });

  it('refuses anything else: another prefix, a length off by one, a key no box can go to', () => {
    const body = known.code.slice(4);
    const lowOrder = `RR1.${base64url(new Uint8Array(48))}`;
    for (const text of [
      '',
      body,
      `RR2.${body}`,
      `RL1.${body}`,
      `RR1.${body.slice(1)}`,
      `RR1.${body}A`,
      `RR1.${body.slice(0, 40)}!${body.slice(41)}`,
      lowOrder,
    ]) {
      expect(parseRecoveryCode(text), text).toBeNull();
    }
  });

  it('makes a fresh 16-byte seed and X25519 key each time, whose code reads back', () => {
    const one = newRecoveryKeys();
    const two = newRecoveryKeys();
    expect(one.seed).toHaveLength(RECOVERY_SEED_BYTES);
    expect(one.seed).not.toEqual(two.seed);
    expect(local(one.publicKey)).toEqual(kxPublicKeyOf(one.secretKey));
    const code = recoveryCode(one);
    expect(code).toMatch(/^RR1\.[A-Za-z0-9_-]{64}$/);
    expect(local(parseRecoveryCode(code)?.publicKey ?? new Uint8Array())).toEqual(
      local(one.publicKey),
    );
  });
});

describe('the check number', () => {
  it('is SHA-256 of the tag, a zero byte and the code, read as six digits, as Python made it', () => {
    expect(recoveryCheck(known.code)).toBe(known.check);
  });

  it('is six digits for any code, and changes when the code does', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (seed) => {
        const code = recoveryCode({ seed, publicKey: REQUEST_PUBLIC });
        expect(recoveryCheck(code)).toMatch(/^[0-9]{6}$/);
      }),
    );
    const swapped = recoveryCode({ seed: SEED, publicKey: kxPublicKeyOf(newKxKey()) });
    expect(recoveryCheck(swapped)).not.toBe(known.check);
  });
});

describe('the second number (#398)', () => {
  it('is HKDF of the new device’s secret key, read as six digits, as Python made it', () => {
    expect(recoveryNumber(REQUEST_SECRET)).toBe(known.number);
  });

  it('is six digits for any key, and comes from the secret key, which no code carries', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (secretKey) => {
        expect(recoveryNumber(secretKey)).toMatch(/^[0-9]{6}$/);
      }),
    );
    // Another key, so another public key in the code, and another number.
    expect(recoveryNumber(newKxKey())).not.toBe(known.number);
    expect(known.code).not.toContain(known.number);
  });
});

describe('the request mailbox', () => {
  it('derives its id and seal key from the seed alone, as Python did', () => {
    const channel = recoveryChannel(SEED);
    expect(channel.mailbox).toBe(MAILBOX);
    expect(local(channel.key)).toEqual(bytes(known.sealKey));
  });
});

describe('a release', () => {
  it('opens the vector’s blob: the Seal under the seed’s key, then the box to the new device', () => {
    const { mailbox, key } = recoveryChannel(SEED);
    const box = xchachaSeal.open(mailbox, key, bytes(known.release.blob));
    expect(local(box ?? new Uint8Array())).toEqual(bytes(known.release.box));
    const release = openRelease(REQUEST_SECRET, mailbox, bytes(known.release.box));
    expect(release).toEqual({ share: SHARE, number: known.number });
    expect(text(bytes(known.release.plaintext))).toBe(
      JSON.stringify({
        v: 2,
        split: SHARE.split,
        t: SHARE.t,
        n: SHARE.n,
        share: base64url(SHARE.share),
        number: known.number,
      }),
    );
  });

  it('refuses a release from before #398, which carries no second number', () => {
    const { mailbox, key } = recoveryChannel(SEED);
    const box = xchachaSeal.open(mailbox, key, bytes(known.releaseV1.blob));
    expect(local(box ?? new Uint8Array())).toEqual(bytes(known.releaseV1.box));
    expect(openRelease(REQUEST_SECRET, mailbox, bytes(known.releaseV1.box))).toBeNull();
  });

  it('seals the share so only the new device opens it, in this mailbox, in one 1,024-byte blob', () => {
    const { mailbox, key } = recoveryChannel(SEED);
    const box = sealRelease(REQUEST_PUBLIC, mailbox, SHARE, known.number);
    const blob = xchachaSeal.seal(mailbox, key, box);
    expect(blob).toHaveLength(BLOB_SIZES[0]);
    expect(openRelease(REQUEST_SECRET, mailbox, box)).toEqual({
      share: SHARE,
      number: known.number,
    });
    expect(openRelease(newKxKey(), mailbox, box)).toBeNull();
    expect(openRelease(REQUEST_SECRET, recoveryChannel(newRecoveryKeys().seed).mailbox, box)).toBe(
      null,
    );
    const changed = Uint8Array.from(box);
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    expect(openRelease(REQUEST_SECRET, mailbox, changed)).toBeNull();
  });

  it('refuses to seal a second number that isn’t six digits', () => {
    const { mailbox } = recoveryChannel(SEED);
    for (const number of ['', '12345', '1234567', '12345a', '123 456', ' 123456']) {
      expect(() => sealRelease(REQUEST_PUBLIC, mailbox, SHARE, number), number).toThrow(RangeError);
    }
  });

  it('opens to nothing but version 2: a well-shaped share and a six-digit second number', () => {
    const { mailbox } = recoveryChannel(SEED);
    const good = JSON.parse(RELEASE_PLAINTEXT) as Record<string, unknown>;
    for (const plaintext of [
      'not json',
      '[1, 2]',
      JSON.stringify({ ...good, t: 9 }),
      JSON.stringify({ ...good, split: 'short' }),
      JSON.stringify({ ...good, share: base64url(new Uint8Array(33)) }),
      JSON.stringify({ ...good, share: undefined }),
      JSON.stringify({ ...good, v: undefined }),
      JSON.stringify({ ...good, v: 1 }),
      JSON.stringify({ ...good, v: 3 }),
      JSON.stringify({ ...good, number: undefined }),
      JSON.stringify({ ...good, number: 966043 }),
      JSON.stringify({ ...good, number: '96604' }),
      JSON.stringify({ ...good, number: '9660430' }),
      JSON.stringify({ ...good, number: '96604a' }),
    ]) {
      const box = sealTo(REQUEST_PUBLIC, utf8(plaintext), RECOVERY_RELEASE_INFO, utf8(mailbox));
      expect(openRelease(REQUEST_SECRET, mailbox, box), plaintext).toBeNull();
    }
    const right = sealTo(REQUEST_PUBLIC, utf8(RELEASE_PLAINTEXT), 'another/label', utf8(mailbox));
    expect(openRelease(REQUEST_SECRET, mailbox, right)).toBeNull();
  });
});

describe('an alert', () => {
  const place = { groupId: GROUP, person: PERSON };
  const kxKey = bytes(known.alert.personSecret);

  it('opens the vector’s box for the person, in that group, to its split and tag', () => {
    const opened = openAlert({ ...place, kxKey, box: ALERT_BOX });
    expect(opened).toEqual({ split: known.alert.split, tag: known.alert.tag });
  });

  it('opens only for the person it was sealed to, in the group it was posted in', () => {
    const kx = bytes(known.alert.personPublic);
    const box = sealAlert({ ...place, kx }, { split: SHARE.split, tag: known.alert.tag });
    expect(openAlert({ ...place, kxKey, box })).toEqual({
      split: SHARE.split,
      tag: known.alert.tag,
    });
    expect(openAlert({ ...place, kxKey: newKxKey(), box })).toBeNull();
    expect(openAlert({ groupId: OTHER, person: PERSON, kxKey, box })).toBeNull();
    expect(openAlert({ groupId: GROUP, person: OTHER, kxKey, box })).toBeNull();
    expect(openAlert({ ...place, kxKey, box: `${box}!` })).toBeNull();
  });

  it('opens to nothing but version 1 with a 16-byte split and tag', () => {
    const kx = bytes(known.alert.personPublic);
    const aad = utf8(`${GROUP}${PERSON}`);
    const good = JSON.parse(ALERT_PLAINTEXT) as Record<string, unknown>;
    for (const plaintext of [
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, split: 'short' }),
      JSON.stringify({ ...good, tag: base64url(new Uint8Array(15)) }),
      JSON.stringify({ ...good, tag: undefined }),
      'null',
    ]) {
      const box = base64url(sealTo(kx, utf8(plaintext), RECOVERY_ALERT_INFO, aad));
      expect(openAlert({ ...place, kxKey, box }), plaintext).toBeNull();
    }
  });

  it('carries a fresh 16-byte tag each time', () => {
    const one = newAlertTag();
    expect(fromBase64url(one)).toHaveLength(ALERT_TAG_BYTES);
    expect(base64url(fromBase64url(one))).toBe(one);
    expect(newAlertTag()).not.toBe(one);
  });

  it('refuses to seal anything but a 16-byte split and tag', () => {
    const kx = bytes(known.alert.personPublic);
    expect(() => sealAlert({ ...place, kx }, { split: 'short', tag: known.alert.tag })).toThrow(
      RangeError,
    );
    expect(() => sealAlert({ ...place, kx }, { split: SHARE.split, tag: 'short' })).toThrow(
      RangeError,
    );
  });
});
