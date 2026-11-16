import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url } from './base64url';
import { deriveSealKey, deriveWeekMailboxId } from './groupKeys';
import {
  INVITE_KEY_INFO,
  INVITE_MAILBOX_INFO,
  INVITE_SEED_BYTES,
  deriveInviteKey,
  deriveInviteMailboxId,
  inviteChannelOf,
  newInviteSeed,
  signInviteToken,
  verifyInviteToken,
} from './invite';
import { EVENT_CONTEXT, INVITE_TOKEN_CONTEXT, newSigningKeys, publicKeyOf, sign } from './sign';

/** `vectors/invite.json`: fixed seeds' derivations and one token, computed outside @noble. */
interface InviteFile {
  readonly kind: 'invite';
  readonly infos: {
    readonly inviteMailboxId: string;
    readonly inviteKey: string;
    readonly token: string;
  };
  readonly derivations: readonly {
    readonly name: string;
    readonly seed: readonly number[];
    readonly inviteMailboxId: readonly number[];
    readonly inviteKey: readonly number[];
  }[];
  readonly tokens: readonly {
    readonly name: string;
    readonly secretKey: readonly number[];
    readonly publicKey: readonly number[];
    readonly groupId: string;
    readonly sig: readonly number[];
  }[];
}

const [file] = Object.values(
  import.meta.glob<InviteFile>('./vectors/invite.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/invite.json is missing.');

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });
const GROUP_ID = 'the-group-id-a-token-is-signed-over';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invite.json', () => {
  it('names the labels the derivations and the token use', () => {
    expect(file.kind).toBe('invite');
    expect(file.infos).toEqual({
      inviteMailboxId: INVITE_MAILBOX_INFO,
      inviteKey: INVITE_KEY_INFO,
      token: INVITE_TOKEN_CONTEXT,
    });
    expect([INVITE_MAILBOX_INFO, INVITE_KEY_INFO, INVITE_TOKEN_CONTEXT]).toEqual([
      'reconcile/v1/invite-mailbox',
      'reconcile/v1/invite-key',
      'reconcile/v1/invite-token',
    ]);
  });

  it.each(file.derivations.map((vector) => [vector.name, vector] as const))(
    'pins the invite mailbox id and key of %s',
    (_name, vector) => {
      const seed = Uint8Array.from(vector.seed);

      expect(deriveInviteMailboxId(seed)).toBe(base64url(Uint8Array.from(vector.inviteMailboxId)));
      expect(Array.from(deriveInviteKey(seed))).toEqual(vector.inviteKey);
    },
  );

  it.each(file.tokens.map((vector) => [vector.name, vector] as const))(
    'pins the token of %s, and it verifies',
    (_name, vector) => {
      const secretKey = Uint8Array.from(vector.secretKey);
      const sig = signInviteToken(secretKey, vector.groupId);

      expect(Array.from(sig)).toEqual(vector.sig);
      const publicKey = Uint8Array.from(vector.publicKey);
      expect(base64url(publicKeyOf(secretKey))).toBe(base64url(publicKey));
      expect(verifyInviteToken(publicKey, sig, vector.groupId)).toBe(true);
    },
  );
});

describe('the invite derivations', () => {
  it('differ from a group secret’s, so a seed never opens or names a group mailbox', () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const mailbox = deriveInviteMailboxId(seed);
        const key = deriveInviteKey(seed);

        expect(mailbox).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(key).toHaveLength(32);
        expect(mailbox).not.toBe(deriveWeekMailboxId(seed, 2963));
        expect(mailbox).not.toBe(base64url(seed));
        expect(bytesToHex(key)).not.toBe(bytesToHex(deriveSealKey(seed)));
        expect(bytesToHex(key)).not.toBe(bytesToHex(seed));
        expect(inviteChannelOf(seed)).toEqual({ mailbox, key });
      }),
      { numRuns: 50 },
    );
  });

  it.each([0, 16, 31, 33])('refuse a %i-byte seed', (length) => {
    const seed = new Uint8Array(length);

    expect(() => deriveInviteMailboxId(seed)).toThrow(
      new RangeError('An invite seed is 32 bytes.'),
    );
    expect(() => deriveInviteKey(seed)).toThrow(new RangeError('An invite seed is 32 bytes.'));
  });
});

describe('newInviteSeed', () => {
  it('is 32 bytes from the platform’s CSPRNG, new each time', () => {
    const random = vi.spyOn(crypto, 'getRandomValues');

    const seed = newInviteSeed();

    expect(INVITE_SEED_BYTES).toBe(32);
    expect(seed).toHaveLength(32);
    expect(random).toHaveBeenCalledTimes(1);
    expect(bytesToHex(random.mock.results[0]?.value as Uint8Array)).toBe(bytesToHex(seed));
    const made = Array.from({ length: 20 }, () => base64url(newInviteSeed()));
    expect(new Set(made).size).toBe(20);
  });
});

describe('invite tokens', () => {
  const keys = newSigningKeys();
  const sig = signInviteToken(keys.secretKey, GROUP_ID);

  it('verify only for the group id they were signed over', () => {
    expect(verifyInviteToken(keys.publicKey, sig, GROUP_ID)).toBe(true);
    expect(verifyInviteToken(keys.publicKey, sig, `${GROUP_ID.slice(1)}r`)).toBe(false);
  });

  it('verify only under their own key', () => {
    expect(verifyInviteToken(newSigningKeys().publicKey, sig, GROUP_ID)).toBe(false);
  });

  it('are never an event signature over the same bytes, nor the other way round', () => {
    const message = new TextEncoder().encode(GROUP_ID);
    const eventSig = sign(EVENT_CONTEXT, keys.secretKey, message);

    expect(bytesToHex(eventSig)).not.toBe(bytesToHex(sig));
    expect(verifyInviteToken(keys.publicKey, eventSig, GROUP_ID)).toBe(false);
  });

  it('refuse a signature or key of the wrong length, without throwing', () => {
    expect(verifyInviteToken(keys.publicKey, sig.subarray(0, 63), GROUP_ID)).toBe(false);
    expect(verifyInviteToken(keys.publicKey.subarray(0, 31), sig, GROUP_ID)).toBe(false);
  });
});
