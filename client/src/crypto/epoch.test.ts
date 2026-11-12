import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from './base64url';
import { BOX_OVERHEAD, kxPublicKeyOf, newKxKey, sealTo } from './box';
import {
  EPOCH_COMMIT_TAG,
  EPOCH_WRAP_COINS_INFO,
  EPOCH_WRAP_INFO,
  epochCommit,
  newEpochSecret,
  unwrapEpochSecret,
  wrapEpochSecret,
  wrapsHold,
} from './epoch';
import { GROUP_SECRET_BYTES } from './groupKeys';
import { concat, local, utf8 } from '../test/bytes';

/** `vectors/epoch.json`: a commit and a wrap made outside @noble. Each value is its bytes. */
interface EpochFile {
  readonly kind: 'epoch';
  readonly vectors: readonly {
    readonly name: string;
    readonly groupId: string;
    readonly epoch: number;
    readonly secret: readonly number[];
    readonly commit: readonly number[];
    readonly memberKey: string;
    readonly kxSecret: readonly number[];
    readonly kxPublic: readonly number[];
    readonly aad: readonly number[];
    readonly wrap: readonly number[];
    readonly coins: { readonly ephemeral: readonly number[]; readonly nonce: readonly number[] };
    readonly derivedWrap: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<EpochFile>('./vectors/epoch.json', { import: 'default', eager: true }),
);

/** The file's one vector. */
function onlyVector(): EpochFile['vectors'][number] {
  const vector = file?.vectors[0];
  if (vector === undefined) throw new Error('vectors/epoch.json holds no vector.');
  return vector;
}

const known = onlyVector();

const bytes = (values: readonly number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const commit = base64url(bytes(known.commit));
const GROUP = 'another-group-id-'.padEnd(43, '1');
const MEMBER = 'another-member-key-'.padEnd(43, '2');

/** The vector's wrap read back by the member it was made for, at `where` unless overridden. */
function opened(
  where: Partial<Parameters<typeof unwrapEpochSecret>[0]> = {},
): Uint8Array<ArrayBuffer> | null {
  const secret = unwrapEpochSecret({
    groupId: known.groupId,
    epoch: known.epoch,
    member: known.memberKey,
    commit,
    wrap: base64url(bytes(known.wrap)),
    kxKey: bytes(known.kxSecret),
    ...where,
  });
  return secret === null ? null : local(secret);
}

describe('epoch.json, made outside @noble', () => {
  it('names the tag and infos it was made under', () => {
    expect(EPOCH_COMMIT_TAG).toBe('reconcile/v1/epoch-commit');
    expect(EPOCH_WRAP_INFO).toBe('reconcile/v1/epoch-wrap');
    expect(EPOCH_WRAP_COINS_INFO).toBe('reconcile/v1/epoch-wrap-coins');
  });

  it('wraps the secret byte for byte as the vector derives it, from the secret and the place (#224)', () => {
    const wrap = wrapEpochSecret({
      groupId: known.groupId,
      epoch: known.epoch,
      member: known.memberKey,
      commit,
      kx: bytes(known.kxPublic),
      secret: bytes(known.secret),
    });
    const derived = bytes(known.derivedWrap);
    expect(wrap).toBe(base64url(derived));
    // The box starts with the ephemeral public key and then the derived nonce.
    expect(local(derived.subarray(32, 56))).toEqual(bytes(known.coins.nonce));
    expect(local(derived.subarray(0, 32))).toEqual(
      local(kxPublicKeyOf(bytes(known.coins.ephemeral))),
    );
    expect(opened({ wrap })).toEqual(bytes(known.secret));
  });

  it('commits to the secret as SHA-256 of tag ‖ 0x00 ‖ group id ‖ u32be(epoch) ‖ secret', () => {
    expect(epochCommit(known.groupId, known.epoch, bytes(known.secret))).toBe(commit);
  });

  it('unwraps to the secret for the member, epoch, group and commit it was made for', () => {
    expect(opened()).toEqual(bytes(known.secret));
  });

  it('treats a wrap moved to another member, epoch or group as missing', () => {
    expect(opened({ member: MEMBER })).toBeNull();
    expect(opened({ epoch: known.epoch + 1 })).toBeNull();
    expect(opened({ groupId: GROUP })).toBeNull();
  });

  it('treats a wrap whose secret doesn’t match the commit as missing', () => {
    const other = epochCommit(known.groupId, known.epoch, newEpochSecret());
    expect(opened({ commit: other })).toBeNull();
  });

  it('treats any flipped byte, another key or a malformed wrap as missing', () => {
    const wrap = bytes(known.wrap);
    for (let at = 0; at < wrap.length; at += 1) {
      const copy = Uint8Array.from(wrap);
      copy[at] = (copy[at] ?? 0) ^ 0x01;
      expect(opened({ wrap: base64url(copy) }), `byte ${String(at)}`).toBeNull();
    }
    expect(opened({ kxKey: newKxKey() })).toBeNull();
    expect(opened({ wrap: 'not base64url!' })).toBeNull();
    expect(opened({ wrap: `${base64url(wrap)}A` })).toBeNull();
    expect(opened({ wrap: '' })).toBeNull();
    expect(opened({ wrap: 'A' })).toBeNull();
  });
});

describe('wrapEpochSecret', () => {
  const secret = newEpochSecret();
  const kxKey = newKxKey();
  const place = { groupId: GROUP, epoch: 3, member: MEMBER };
  const sealed = epochCommit(GROUP, 3, secret);

  it('wraps a secret its member alone unwraps, as one box in base64url', () => {
    const wrap = wrapEpochSecret({ ...place, commit: sealed, kx: kxPublicKeyOf(kxKey), secret });
    expect(fromBase64url(wrap)).toHaveLength(BOX_OVERHEAD + GROUP_SECRET_BYTES);
    const back = unwrapEpochSecret({ ...place, commit: sealed, wrap, kxKey });
    expect(back === null ? null : local(back)).toEqual(local(secret));
    expect(unwrapEpochSecret({ ...place, commit: sealed, wrap, kxKey: newKxKey() })).toBeNull();
  });

  it('treats a wrap that opens to another secret than its commit names as missing', () => {
    // A writer who commits to one secret and wraps another: the box opens, the commit doesn't match.
    const other = newEpochSecret();
    const wrap = wrapEpochSecret({
      ...place,
      commit: sealed,
      kx: kxPublicKeyOf(kxKey),
      secret: other,
    });
    expect(unwrapEpochSecret({ ...place, commit: sealed, wrap, kxKey })).toBeNull();
    const short = wrapEpochSecret({
      ...place,
      commit: sealed,
      kx: kxPublicKeyOf(kxKey),
      secret: other.subarray(0, 31),
    });
    expect(unwrapEpochSecret({ ...place, commit: sealed, wrap: short, kxKey })).toBeNull();
  });

  it('wraps the same secret to the same place the same way every time, and every other place another way (#224)', () => {
    const kx = kxPublicKeyOf(kxKey);
    const wrap = (where: Partial<Parameters<typeof wrapEpochSecret>[0]> = {}): string =>
      wrapEpochSecret({ ...place, commit: sealed, kx, secret, ...where });
    const first = wrap();
    expect(wrap()).toBe(first);
    const others = [
      wrap({ member: GROUP }),
      wrap({ groupId: MEMBER }),
      wrap({ epoch: 4 }),
      wrap({ commit: epochCommit(GROUP, 4, secret) }),
      wrap({ kx: kxPublicKeyOf(newKxKey()) }),
      wrap({ secret: newEpochSecret() }),
    ];
    expect(new Set([first, ...others]).size).toBe(others.length + 1);
  });

  it('makes a fresh 32-byte secret each time, and commits to each differently', () => {
    const other = newEpochSecret();
    expect(other).toHaveLength(GROUP_SECRET_BYTES);
    expect(local(other)).not.toEqual(local(secret));
    expect(epochCommit(GROUP, 3, other)).not.toBe(sealed);
    expect(epochCommit(GROUP, 4, secret)).not.toBe(sealed);
    expect(epochCommit(MEMBER, 3, secret)).not.toBe(sealed);
  });

  it('refuses a secret of the wrong length or an epoch past u32', () => {
    expect(() => epochCommit(GROUP, 1, new Uint8Array(31))).toThrow(RangeError);
    expect(() => epochCommit(GROUP, 2 ** 32, secret)).toThrow(RangeError);
    expect(() => epochCommit(GROUP, -1, secret)).toThrow(RangeError);
  });
});

describe('wrapsHold (#224)', () => {
  const groupId = GROUP;
  const epoch = 2;
  const secret = newEpochSecret();
  const commit = epochCommit(groupId, epoch, secret);
  const members = ['ana', 'ben', 'cal'].map((name) => {
    const kxKey = newKxKey();
    return { member: `${name}-key-`.padEnd(43, 'x'), kxKey, kx: kxPublicKeyOf(kxKey) };
  });
  const keys = Object.fromEntries(members.map(({ member, kx }) => [member, base64url(kx)]));
  /** Each member's wrap of `wrapped`, as a writer who follows the rule makes it. */
  const wrapsOf = (wrapped: Uint8Array): Record<string, string> =>
    Object.fromEntries(
      members.map(({ member, kx }) => [
        member,
        wrapEpochSecret({ groupId, epoch, member, commit, kx, secret: wrapped }),
      ]),
    );
  const honest = wrapsOf(secret);
  const check = (wraps: Record<string, string>, held = keys, with_ = secret): boolean =>
    wrapsHold({ groupId, epoch, commit, secret: with_, keys: held, wraps });

  it('holds when every wrap is the one the secret makes for its member', () => {
    expect(check(honest)).toBe(true);
  });

  it('fails when any one wrap is not, though the rest are', () => {
    const [ana, ben] = members;
    if (ana === undefined || ben === undefined) throw new Error('two members');
    const garbage = base64url(new Uint8Array(BOX_OVERHEAD + GROUP_SECRET_BYTES).fill(7));
    expect(check({ ...honest, [ben.member]: garbage })).toBe(false);
    // A wrap of the right secret to the right key, but with fresh coins: it opens, yet isn't the rule's.
    const aad = concat(
      utf8(groupId),
      Uint8Array.of(0, 0, 0, epoch),
      utf8(ben.member),
      utf8(commit),
    );
    const fresh = base64url(sealTo(ben.kx, secret, EPOCH_WRAP_INFO, aad));
    const where = { groupId, epoch, member: ben.member, commit };
    const back = unwrapEpochSecret({ ...where, wrap: fresh, kxKey: ben.kxKey });
    expect(back === null ? null : local(back)).toEqual(local(secret));
    expect(check({ ...honest, [ben.member]: fresh })).toBe(false);
    // Ana's wrap in Ben's place.
    expect(check({ ...honest, [ben.member]: honest[ana.member] ?? '' })).toBe(false);
    // A wrap of another secret, made by the rule.
    const elsewhere = wrapsOf(newEpochSecret());
    expect(check({ ...honest, [ben.member]: elsewhere[ben.member] ?? '' })).toBe(false);
    // A wrap made by the rule to another key than the one the group holds for them.
    const moved = wrapEpochSecret({
      groupId,
      epoch,
      member: ben.member,
      commit,
      secret,
      kx: kxPublicKeyOf(newKxKey()),
    });
    expect(check({ ...honest, [ben.member]: moved })).toBe(false);
  });

  it('fails when the wraps and the keys name different members', () => {
    const [ana] = members;
    if (ana === undefined) throw new Error('a member');
    const fewer = Object.fromEntries(
      Object.entries(honest).filter(([member]) => member !== ana.member),
    );
    expect(check(fewer)).toBe(false);
    const heldFewer = Object.fromEntries(
      Object.entries(keys).filter(([member]) => member !== ana.member),
    );
    expect(check(honest, heldFewer)).toBe(false);
    expect(check({ ...honest, extra: honest[ana.member] ?? '' })).toBe(false);
  });

  it('fails for a secret its commit doesn’t name, or a key no box can be sealed to', () => {
    expect(check(honest, keys, newEpochSecret())).toBe(false);
    expect(check(honest, keys, secret.subarray(0, 31))).toBe(false);
    // Every wrap made by the rule from another secret than the commit names: they all match it, yet it fails.
    const other = newEpochSecret();
    expect(check(wrapsOf(other), keys, other)).toBe(false);
    const [ana] = members;
    if (ana === undefined) throw new Error('a member');
    expect(check(honest, { ...keys, [ana.member]: base64url(new Uint8Array(32)) })).toBe(false);
    expect(check(honest, { ...keys, [ana.member]: 'not a key' })).toBe(false);
  });
});
