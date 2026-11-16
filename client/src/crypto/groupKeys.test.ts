import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url, fromBase64url } from './base64url';
import {
  GROUP_SECRET_BYTES,
  MAILBOX_WEEK_INFO,
  SEAL_KEY_INFO,
  WEEK_MINUTES,
  deriveSealKey,
  deriveWeekMailboxId,
  newGroupSecret,
  weekOf,
} from './groupKeys';

/** `vectors/derive.json`: one fixed secret's weekly mailbox ids and seal key, computed outside @noble. */
interface DeriveFile {
  readonly kind: 'derive';
  readonly infos: { readonly weekMailboxId: string; readonly sealKey: string };
  /** Each value is its bytes; a mailbox id is the base64url of its bytes. */
  readonly vectors: readonly {
    readonly name: string;
    readonly secret: readonly number[];
    readonly weekMailboxIds: readonly { readonly week: number; readonly id: readonly number[] }[];
    readonly sealKey: readonly number[];
  }[];
}

const [derive] = Object.values(
  import.meta.glob<DeriveFile>('./vectors/derive.json', { import: 'default', eager: true }),
);
if (derive === undefined) throw new Error('vectors/derive.json is missing.');

/** M2-02's one mailbox per secret, before #110: no group traffic uses it now. */
const RETIRED_MAILBOX_INFO = 'reconcile/v1/mailbox';

/** The largest week a 4-byte big-endian week number holds. */
const LAST_WEEK = 2 ** 32 - 1;

const secrets = fc.uint8Array({ minLength: 32, maxLength: 32 });
const weeks = fc.integer({ min: 0, max: LAST_WEEK });

/** HKDF-SHA-256 with an empty salt by the platform's WebCrypto: a second implementation. */
async function platformHkdf(secret: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info };
  return new Uint8Array(await crypto.subtle.deriveBits(params, key, 256));
}

/** A label's UTF-8 bytes. */
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(text));
}

/** The issue's info for a week, built by hand: utf8(label) ‖ 0x00 ‖ u32be(week). */
function weekInfo(week: number): Uint8Array<ArrayBuffer> {
  const label = utf8(MAILBOX_WEEK_INFO);
  const info = new Uint8Array(label.length + 5);
  info.set(label);
  new DataView(info.buffer).setUint32(label.length + 1, week, false);
  return info;
}

/** The number of bits in which two equally long byte strings differ. */
function bitsApart(a: Uint8Array, b: Uint8Array): number {
  let bits = 0;
  for (const [i, byte] of a.entries()) {
    let diff = byte ^ (b[i] ?? 0);
    for (; diff !== 0; diff &= diff - 1) bits += 1;
  }
  return bits;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('derive.json', () => {
  it('names the two HKDF labels the derivations use', () => {
    expect(derive.kind).toBe('derive');
    expect(derive.infos).toEqual({ weekMailboxId: MAILBOX_WEEK_INFO, sealKey: SEAL_KEY_INFO });
    expect([MAILBOX_WEEK_INFO, SEAL_KEY_INFO]).toEqual([
      'reconcile/v1/mailbox-week',
      'reconcile/v1/seal-key',
    ]);
  });

  it.each(derive.vectors.map((vector) => [vector.name, vector] as const))(
    'pins the weekly mailbox ids and the seal key of %s',
    (_name, vector) => {
      const secret = Uint8Array.from(vector.secret);

      expect(vector.weekMailboxIds.map(({ week }) => week)).toEqual([2963, 2964, 0, LAST_WEEK]);
      for (const { week, id } of vector.weekMailboxIds) {
        expect(deriveWeekMailboxId(secret, week)).toBe(base64url(Uint8Array.from(id)));
      }
      expect(Array.from(deriveSealKey(secret))).toEqual(vector.sealKey);
    },
  );
});

describe('weekOf: the week of a relay minute (#110)', () => {
  it('is ⌊minute / 10,080⌋', () => {
    expect(WEEK_MINUTES).toBe(10_080);
    expect(weekOf(29_870_112)).toBe(2963);
    expect([0, 10_079, 10_080, 20_159, 20_160].map(weekOf)).toEqual([0, 0, 1, 1, 2]);
  });

  it('gives week w to every minute of it, and to no other', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 25 }),
        fc.integer({ min: 0, max: WEEK_MINUTES - 1 }),
        (week, into) => {
          expect(weekOf(week * WEEK_MINUTES + into)).toBe(week);
        },
      ),
    );
  });

  it('turns over on Thursday at 00:00 UTC, as Unix minute 0 does', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000 }), (week) => {
        const start = new Date(week * WEEK_MINUTES * 60_000);

        expect(start.getUTCDay()).toBe(4);
        expect([start.getUTCHours(), start.getUTCMinutes()]).toEqual([0, 0]);
        expect(weekOf(week * WEEK_MINUTES - 1)).toBe(week - 1);
      }),
    );
  });
});

describe('deriveWeekMailboxId', () => {
  it('gives what WebCrypto’s HKDF gives with an empty salt and the label, a zero byte and the week', async () => {
    await fc.assert(
      fc.asyncProperty(secrets, weeks, async (secret, week) => {
        expect(deriveWeekMailboxId(secret, week)).toBe(
          base64url(await platformHkdf(secret, weekInfo(week))),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('gives 52 consecutive weeks of one secret 52 ids, none another group’s or the retired single id', async () => {
    const [one, two] = [newGroupSecret(), newGroupSecret()];
    const year = Array.from({ length: 52 }, (_, n) => 2963 + n);
    const ours = year.map((week) => deriveWeekMailboxId(one, week));
    const theirs = year.map((week) => deriveWeekMailboxId(two, week));
    const retired = await Promise.all(
      [one, two].map(async (secret) =>
        base64url(await platformHkdf(secret, utf8(RETIRED_MAILBOX_INFO))),
      ),
    );

    expect(new Set(ours).size).toBe(52);
    expect(new Set([...ours, ...theirs]).size).toBe(104);
    for (const id of retired) expect([...ours, ...theirs]).not.toContain(id);
  });

  it('never gives two weeks of one secret, or one week of two secrets, the same id', () => {
    fc.assert(
      fc.property(secrets, secrets, weeks, weeks, (one, two, week, other) => {
        fc.pre(week !== other && bytesToHex(one) !== bytesToHex(two));

        expect(deriveWeekMailboxId(one, week)).not.toBe(deriveWeekMailboxId(one, other));
        expect(deriveWeekMailboxId(one, week)).not.toBe(deriveWeekMailboxId(two, week));
      }),
    );
  });

  it('gives next week an id as far from this week’s as an unrelated group’s, so nothing links them without the secret', () => {
    // Unrelated 256-bit values differ in 128 ± 8 bits; outside 64–192 is a 1-in-10¹⁶ chance.
    fc.assert(
      fc.property(
        secrets,
        secrets,
        fc.integer({ min: 0, max: LAST_WEEK - 1 }),
        (one, two, week) => {
          const now = fromBase64url(deriveWeekMailboxId(one, week));
          const next = fromBase64url(deriveWeekMailboxId(one, week + 1));
          const unrelated = fromBase64url(deriveWeekMailboxId(two, week));

          for (const other of [next, unrelated]) {
            expect(bitsApart(now, other)).toBeGreaterThanOrEqual(64);
            expect(bitsApart(now, other)).toBeLessThanOrEqual(192);
          }
        },
      ),
    );
  });

  it('makes a 43-character base64url id that is neither the secret nor the seal key', () => {
    fc.assert(
      fc.property(secrets, weeks, (secret, week) => {
        const mailbox = deriveWeekMailboxId(secret, week);

        expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(mailbox).not.toBe(base64url(secret));
        expect(mailbox).not.toBe(base64url(deriveSealKey(secret)));
      }),
    );
  });

  it.each([0, 16, 31, 33, 64])('refuses a %i-byte secret', (length) => {
    expect(() => deriveWeekMailboxId(new Uint8Array(length), 2963)).toThrow(
      new RangeError('A group secret is 32 bytes.'),
    );
  });

  it.each([-1, 1.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the week %s',
    (week) => {
      expect(() => deriveWeekMailboxId(new Uint8Array(32), week)).toThrow(
        new RangeError('A week is a whole number from 0 to 2³² − 1.'),
      );
    },
  );
});

describe('deriveSealKey', () => {
  it('gives what WebCrypto’s HKDF gives with an empty salt and its label, for any secret', async () => {
    await fc.assert(
      fc.asyncProperty(secrets, async (secret) => {
        expect(bytesToHex(deriveSealKey(secret))).toBe(
          bytesToHex(await platformHkdf(secret, utf8(SEAL_KEY_INFO))),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('makes a 32-byte key that isn’t the secret, the same for every week of the epoch', () => {
    fc.assert(
      fc.property(secrets, (secret) => {
        const key = deriveSealKey(secret);

        expect(key).toHaveLength(32);
        expect(bytesToHex(key)).not.toBe(bytesToHex(secret));
        expect(bytesToHex(deriveSealKey(secret))).toBe(bytesToHex(key));
      }),
    );
  });

  it('gives unrelated keys and ids for secrets one bit apart', () => {
    const one = new Uint8Array(32);
    const two = Uint8Array.from(one);
    two[31] = 1;

    expect(deriveWeekMailboxId(one, 2963)).not.toBe(deriveWeekMailboxId(two, 2963));
    expect(bytesToHex(deriveSealKey(one))).not.toBe(bytesToHex(deriveSealKey(two)));
  });

  it.each([0, 16, 31, 33, 64])('refuses a %i-byte secret', (length) => {
    expect(() => deriveSealKey(new Uint8Array(length))).toThrow(
      new RangeError('A group secret is 32 bytes.'),
    );
  });
});

describe('newGroupSecret', () => {
  it('is 32 bytes from the platform’s CSPRNG', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const secret = newGroupSecret();

    expect(GROUP_SECRET_BYTES).toBe(32);
    expect(secret).toHaveLength(32);
    expect(random).toHaveBeenCalledTimes(1);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(secret));
  });

  it('is new each time, so no two groups share a mailbox in any week', () => {
    const made = Array.from({ length: 20 }, () => newGroupSecret());

    expect(new Set(made.map(bytesToHex)).size).toBe(20);
    expect(new Set(made.map((secret) => deriveWeekMailboxId(secret, 2963))).size).toBe(20);
  });
});
