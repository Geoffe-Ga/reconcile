import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { local, utf8 } from '../test/bytes';
import { base64url, fromBase64url } from './base64url';
import { kxPublicKeyOf, newKxKey, openBox, sealTo } from './box';
import { ALLOWED_THRESHOLDS } from './recoveryPolicy';
import {
  combineShares,
  newSplitId,
  openShare,
  RECOVERY_SHARE_INFO,
  type RecoveryShare,
  SHARE_BYTES,
  type SharePlace,
  sealShare,
  splitKey,
  SPLIT_ID_BYTES,
} from './shares';

/** `vectors/shares.json`: splits, hiding and a box made outside the library and @noble. */
interface SharesFile {
  readonly kind: 'shares';
  readonly key: readonly number[];
  readonly splits: readonly {
    readonly name: string;
    readonly t: number;
    readonly n: number;
    readonly shares: readonly (readonly number[])[];
  }[];
  readonly hiding: {
    readonly shares: readonly (readonly number[])[];
    readonly completions: readonly {
      readonly share: readonly number[];
      readonly key: readonly number[];
    }[];
  };
  readonly box: {
    readonly groupId: string;
    readonly contact: string;
    readonly author: string;
    readonly kxSecret: readonly number[];
    readonly kxPublic: readonly number[];
    readonly info: string;
    readonly aad: readonly number[];
    readonly plaintext: readonly number[];
    readonly box: readonly number[];
  };
}

const [file] = Object.values(
  import.meta.glob<SharesFile>('./vectors/shares.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/shares.json is missing.');
const known = file;

const bytes = (values: readonly number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const KEY = bytes(known.key);
const GROUP = 'group-id-of-a-share-test-'.padEnd(43, '0');
const CONTACT = 'contact-key-of-a-share-test-'.padEnd(43, '1');
const AUTHOR = 'author-key-of-a-share-test-'.padEnd(43, '2');
const PLACE: SharePlace = { groupId: GROUP, contact: CONTACT, author: AUTHOR };

/** Every subset of `items` of size `k`, in order. */
function subsets<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  return items.flatMap((item, i) =>
    subsets(items.slice(i + 1), k - 1).map((rest) => [item, ...rest]),
  );
}

/** The key the shares rebuild, in the test's realm, or null. */
async function rebuilt(shares: readonly Uint8Array[]): Promise<Uint8Array | null> {
  const key = await combineShares(shares);
  return key === null ? null : local(key);
}

/** A share of `t` of `n` of a random key, as a recovery share. */
function shareOf(share: Uint8Array, t = 3, n = 5): RecoveryShare {
  return { split: newSplitId(), t, n, share };
}

/** fast-check's arbitrary for one allowed threshold. */
const threshold = fc.constantFrom(...ALLOWED_THRESHOLDS);

/** fast-check's arbitrary for a 32-byte key. */
const key32 = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe('shares.json, made outside the library', () => {
  it('rebuilds the key from every t of each split’s n shares, and from all n', async () => {
    for (const split of known.splits) {
      const shares = split.shares.map(bytes);
      expect(shares).toHaveLength(split.n);
      for (const chosen of [...subsets(shares, split.t), shares]) {
        expect(await rebuilt(chosen)).toEqual(KEY);
      }
    }
  });

  it('rebuilds nothing from any t − 1 of them', async () => {
    for (const split of known.splits) {
      for (const chosen of subsets(split.shares.map(bytes), split.t - 1)) {
        expect(await rebuilt(chosen)).not.toEqual(KEY);
      }
    }
  });

  it('shows t − 1 shares fit any key: one more share completes either key', async () => {
    const held = known.hiding.shares.map(bytes);
    const keys = await Promise.all(
      known.hiding.completions.map(({ share }) => rebuilt([...held, bytes(share)])),
    );
    expect(keys).toEqual(known.hiding.completions.map(({ key }) => bytes(key)));
    expect(keys[0]).not.toEqual(keys[1]);
  });

  it('opens the box sealed outside @noble to the share, for its contact, group and author', () => {
    const { box } = known;
    expect(RECOVERY_SHARE_INFO).toBe(box.info);
    expect(local(kxPublicKeyOf(bytes(box.kxSecret)))).toEqual(bytes(box.kxPublic));
    const place = { groupId: box.groupId, contact: box.contact, author: box.author };
    // The associated data is the group id ‖ the contact's key ‖ the author's key, in UTF-8.
    expect(local(utf8(`${box.groupId}${box.contact}${box.author}`))).toEqual(bytes(box.aad));
    const opened = openShare({
      ...place,
      kxKey: bytes(box.kxSecret),
      box: base64url(bytes(box.box)),
    });
    const plain = JSON.parse(new TextDecoder().decode(bytes(box.plaintext))) as {
      split: string;
      t: number;
      n: number;
    };
    const [, , , fourth] = known.splits[1]?.shares ?? [];
    expect(opened === null ? null : { ...opened, share: local(opened.share) }).toEqual({
      split: plain.split,
      t: 3,
      n: 5,
      share: bytes(fourth ?? []),
    });
    // The plaintext is exactly the JSON sealShare writes: {v, split, t, n, share}, in that order.
    expect(new TextDecoder().decode(bytes(box.plaintext))).toBe(
      JSON.stringify({
        v: 1,
        split: plain.split,
        t: 3,
        n: 5,
        share: base64url(bytes(fourth ?? [])),
      }),
    );
  });

  it('opens to nothing at another place, or for anyone but its contact', () => {
    const { box } = known;
    const place = { groupId: box.groupId, contact: box.contact, author: box.author };
    const sealed = base64url(bytes(box.box));
    const kxKey = bytes(box.kxSecret);
    expect(openShare({ ...place, kxKey: newKxKey(), box: sealed })).toBeNull();
    expect(openShare({ ...place, groupId: box.contact, kxKey, box: sealed })).toBeNull();
    expect(openShare({ ...place, contact: box.author, kxKey, box: sealed })).toBeNull();
    expect(openShare({ ...place, author: box.contact, kxKey, box: sealed })).toBeNull();
  });
});

describe('splitKey and combineShares', () => {
  it('rebuilds the key from any t of the n shares, and never from t − 1', async () => {
    // A threshold, and which t of its n shares to rebuild from, in a shuffled order.
    const picks = threshold.chain(({ t, n }) =>
      fc.record({
        t: fc.constant(t),
        n: fc.constant(n),
        chosen: fc.shuffledSubarray(
          Array.from({ length: n }, (_, i) => i),
          { minLength: t, maxLength: t },
        ),
      }),
    );
    await fc.assert(
      fc.asyncProperty(key32, picks, async (key, { t, n, chosen }) => {
        const shares = await splitKey(key, n, t);
        expect(shares).toHaveLength(n);
        for (const share of shares) expect(share).toHaveLength(SHARE_BYTES);
        const some = chosen.map((i) => shares[i] ?? new Uint8Array());
        expect(await rebuilt(some)).toEqual(local(key));
        expect(await rebuilt(some.slice(1))).not.toEqual(local(key));
      }),
      { numRuns: 60 },
    );
  });

  it('draws fresh coordinates and coefficients each time it splits', async () => {
    const [first, second] = await Promise.all([splitKey(KEY, 5, 3), splitKey(KEY, 5, 3)]);
    expect(first).not.toEqual(second);
  });

  it('gives every share its own coordinate from 1 to 255', async () => {
    const shares = await splitKey(KEY, 7, 5);
    const xs = shares.map((share) => share[SHARE_BYTES - 1]);
    expect(new Set(xs).size).toBe(7);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(1);
  });

  it('refuses a key that isn’t 32 bytes, and a threshold the policy doesn’t allow', async () => {
    await expect(splitKey(new Uint8Array(31), 5, 3)).rejects.toThrow(RangeError);
    await expect(splitKey(KEY, 5, 1)).rejects.toThrow('2 of 3 to 5 of 7');
    await expect(splitKey(KEY, 8, 3)).rejects.toThrow(RangeError);
    await expect(splitKey(KEY, 3, 4)).rejects.toThrow(RangeError);
  });

  it('rebuilds nothing from shares that can’t be a set', async () => {
    const shares = await splitKey(KEY, 5, 3);
    const [a, b, c] = shares.map(local);
    if (a === undefined || b === undefined || c === undefined) throw new Error('Expected shares.');
    expect(await rebuilt([a])).toBeNull();
    expect(await rebuilt([])).toBeNull();
    expect(await rebuilt([a, a, b])).toBeNull();
    expect(await rebuilt([a, b, c.subarray(1)])).toBeNull();
    const zero = Uint8Array.from(c);
    zero[SHARE_BYTES - 1] = 0;
    expect(await rebuilt([a, b, zero])).toBeNull();
    expect(await rebuilt([a, b, c])).toEqual(KEY);
  });
});

describe('sealShare and openShare', () => {
  it('names its info, and a split id is 16 random bytes', () => {
    expect(RECOVERY_SHARE_INFO).toBe('reconcile/v1/recovery-share');
    expect(SPLIT_ID_BYTES).toBe(16);
    const id = newSplitId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(newSplitId()).not.toBe(id);
  });

  it('opens only for its contact, and never moved to another group, contact or author', async () => {
    const shares = await splitKey(KEY, 5, 3);
    fc.assert(
      fc.property(fc.constantFrom(...shares), (share) => {
        const kxKey = newKxKey();
        const other = newKxKey();
        const sent = shareOf(share);
        const box = sealShare({ ...PLACE, kx: kxPublicKeyOf(kxKey) }, sent);
        const opened = openShare({ ...PLACE, kxKey, box });
        expect(opened === null ? null : { ...opened, share: local(opened.share) }).toEqual({
          ...sent,
          share: local(share),
        });
        expect(openShare({ ...PLACE, kxKey: other, box })).toBeNull();
        expect(
          openShare({ ...PLACE, groupId: 'another-group-'.padEnd(43, '3'), kxKey, box }),
        ).toBeNull();
        expect(openShare({ ...PLACE, contact: AUTHOR, kxKey, box })).toBeNull();
        expect(openShare({ ...PLACE, author: CONTACT, kxKey, box })).toBeNull();
      }),
      { numRuns: 10 },
    );
  });

  it('never carries the share, the split or the key in the clear', async () => {
    const [share] = await splitKey(KEY, 3, 2);
    if (share === undefined) throw new Error('Expected a share.');
    const sent = shareOf(share, 2, 3);
    const box = sealShare({ ...PLACE, kx: kxPublicKeyOf(newKxKey()) }, sent);
    expect(box).not.toContain(base64url(share));
    expect(box).not.toContain(sent.split);
    expect(box).not.toContain(base64url(KEY));
    expect(box).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses to seal a share that isn’t 33 bytes, or under a threshold the policy doesn’t allow', () => {
    const kx = kxPublicKeyOf(newKxKey());
    const share = new Uint8Array(SHARE_BYTES).fill(7);
    expect(() => sealShare({ ...PLACE, kx }, shareOf(share.subarray(1)))).toThrow(RangeError);
    expect(() => sealShare({ ...PLACE, kx }, shareOf(share, 6, 7))).toThrow(RangeError);
    expect(() => sealShare({ ...PLACE, kx }, { ...shareOf(share), split: 'short' })).toThrow(
      RangeError,
    );
  });

  /** A box sealed to `kxKey` at PLACE holding `body` as JSON, as a sender who skipped sealShare would. */
  function boxOf(kxKey: Uint8Array, body: unknown): string {
    const aad = utf8(`${GROUP}${CONTACT}${AUTHOR}`);
    const plaintext = utf8(typeof body === 'string' ? body : JSON.stringify(body));
    return base64url(sealTo(kxPublicKeyOf(kxKey), plaintext, RECOVERY_SHARE_INFO, aad));
  }

  it('opens to nothing for a box that holds anything but a well-shaped share', () => {
    const kxKey = newKxKey();
    const share = base64url(new Uint8Array(SHARE_BYTES).fill(9));
    const split = newSplitId();
    const good = { v: 1, split, t: 3, n: 5, share };
    expect(openShare({ ...PLACE, kxKey, box: boxOf(kxKey, good) })).not.toBeNull();
    const zeroX = new Uint8Array(SHARE_BYTES).fill(9);
    zeroX[SHARE_BYTES - 1] = 0;
    for (const bad of [
      { ...good, v: 2 },
      { ...good, t: 1 },
      { ...good, n: 8 },
      { ...good, t: '3' },
      { ...good, split: base64url(new Uint8Array(15)) },
      { ...good, split: `${split.slice(0, 21)}B` },
      { ...good, split: 7 },
      { ...good, share: base64url(new Uint8Array(32)) },
      { ...good, share: base64url(zeroX) },
      { ...good, share: '!' },
      [good],
      null,
      'not json',
    ]) {
      expect(
        openShare({ ...PLACE, kxKey, box: boxOf(kxKey, bad) }),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });

  it('opens to nothing for a box text that isn’t canonical base64url, or too short', () => {
    const kxKey = newKxKey();
    for (const box of ['', 'A', '!!!!', 'AAAA', `${'A'.repeat(100)}=`]) {
      expect(openShare({ ...PLACE, kxKey, box })).toBeNull();
    }
  });

  it('seals the share as JSON {v, split, t, n, share} under its own info', async () => {
    const kxKey = newKxKey();
    const [share] = await splitKey(KEY, 5, 3);
    if (share === undefined) throw new Error('Expected a share.');
    const sent = shareOf(share);
    const box = sealShare({ ...PLACE, kx: kxPublicKeyOf(kxKey) }, sent);
    const aad = utf8(`${GROUP}${CONTACT}${AUTHOR}`);
    const raw = openBox(kxKey, fromBase64url(box), RECOVERY_SHARE_INFO, aad);
    expect(raw === null ? null : new TextDecoder().decode(raw)).toBe(
      JSON.stringify({ v: 1, split: sent.split, t: 3, n: 5, share: base64url(share) }),
    );
  });
});
