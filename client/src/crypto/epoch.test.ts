import { describe, expect, it } from 'vitest';

import { base64url, fromBase64url } from './base64url';
import { BOX_OVERHEAD, kxPublicKeyOf, newKxKey } from './box';
import {
  EPOCH_COMMIT_TAG,
  EPOCH_WRAP_INFO,
  epochCommit,
  newEpochSecret,
  unwrapEpochSecret,
  wrapEpochSecret,
} from './epoch';
import { GROUP_SECRET_BYTES } from './groupKeys';
import { local } from '../test/bytes';

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
  it('names the tag and info it was made under', () => {
    expect(EPOCH_COMMIT_TAG).toBe('reconcile/v1/epoch-commit');
    expect(EPOCH_WRAP_INFO).toBe('reconcile/v1/epoch-wrap');
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
