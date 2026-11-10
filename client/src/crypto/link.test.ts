import { bytesToHex } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { base64url } from './base64url';
import { inviteChannelOf } from './invite';
import {
  LINK_BUNDLE_MAILBOX_INFO,
  LINK_CODE_PREFIX,
  LINK_KEY_INFO,
  LINK_NUMBER_INFO,
  LINK_PAIRING_KEY_INFO,
  LINK_PAIRING_MAILBOX_INFO,
  LINK_SEED_BYTES,
  LINK_TRANSCRIPT_TAG,
  LinkRefused,
  linkCode,
  linkNumber,
  linkSecrets,
  linkTranscript,
  matchesCommitment,
  newLinkKeys,
  newLinkSeed,
  pairingChannelOf,
  parseLinkCode,
  sharedSecret,
} from './link';

/** One case of `vectors/link.json`: every value is its bytes, computed outside @noble. */
interface LinkCase {
  readonly name: string;
  readonly seed: readonly number[];
  readonly secretA: readonly number[];
  readonly secretB: readonly number[];
  readonly publicA: readonly number[];
  readonly publicB: readonly number[];
  readonly commitment: readonly number[];
  readonly pairingMailbox: readonly number[];
  readonly pairingKey: readonly number[];
  readonly shared: readonly number[];
  readonly transcript: readonly number[];
  readonly number: string;
  readonly key: readonly number[];
  readonly bundleMailbox: readonly number[];
}

/** `vectors/link.json` (#96). */
interface LinkFile {
  readonly kind: 'link';
  readonly infos: Readonly<Record<string, string>>;
  readonly cases: readonly LinkCase[];
  readonly lowOrder: readonly { readonly name: string; readonly publicKey: readonly number[] }[];
}

const [file] = Object.values(
  import.meta.glob<LinkFile>('./vectors/link.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/link.json is missing.');

const bytes = (list: readonly number[]): Uint8Array => Uint8Array.from(list);

/** A case's derivations, as the existing device (A) makes them: e_A with E_B. */
function fromA(c: LinkCase) {
  const shared = sharedSecret(bytes(c.secretA), bytes(c.publicB));
  const transcript = linkTranscript(bytes(c.seed), bytes(c.publicA), bytes(c.publicB));
  return { shared, transcript, ...linkSecrets(shared, transcript) };
}

/** The same, as the new device (B) makes them: e_B with E_A. */
function fromB(c: LinkCase) {
  const shared = sharedSecret(bytes(c.secretB), bytes(c.publicA));
  const transcript = linkTranscript(bytes(c.seed), bytes(c.publicA), bytes(c.publicB));
  return { shared, transcript, ...linkSecrets(shared, transcript) };
}

const keys32 = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** The characters from `first` to `last`, in code-point order: a run of the base64url alphabet. */
function span(first: string, last: string): string {
  const start = first.charCodeAt(0);
  return String.fromCharCode(
    ...Array.from({ length: last.charCodeAt(0) - start + 1 }, (_, i) => start + i),
  );
}

describe('link.json', () => {
  it('names the labels every derivation uses', () => {
    expect(file.kind).toBe('link');
    expect(file.infos).toEqual({
      pairingMailbox: LINK_PAIRING_MAILBOX_INFO,
      pairingKey: LINK_PAIRING_KEY_INFO,
      transcript: LINK_TRANSCRIPT_TAG,
      number: LINK_NUMBER_INFO,
      key: LINK_KEY_INFO,
      bundleMailbox: LINK_BUNDLE_MAILBOX_INFO,
    });
    expect(file.cases.length).toBeGreaterThanOrEqual(2);
  });

  it('pins a number with a leading zero', () => {
    const [first] = file.cases;
    expect(first?.number).toBe('042719');
    expect(first === undefined ? null : fromA(first).number).toBe('042719');
  });

  describe.each(file.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('derives the public keys and the commitment', () => {
      // A fresh keypair's public key is the curve's: rebuilding it from the secret must agree.
      const shared = sharedSecret(bytes(c.secretA), bytes(c.publicB));
      expect(bytesToHex(shared)).toBe(bytesToHex(bytes(c.shared)));
      expect(matchesCommitment(bytes(c.publicA), bytes(c.commitment))).toBe(true);
      expect(matchesCommitment(bytes(c.publicB), bytes(c.commitment))).toBe(false);
    });

    it('writes the code as RL1. and the seed and commitment, and reads it back', () => {
      const code = linkCode(bytes(c.seed), bytes(c.publicA));
      expect(code).toBe(`${LINK_CODE_PREFIX}${base64url(bytes([...c.seed, ...c.commitment]))}`);
      expect(code).toMatch(/^RL1\.[A-Za-z0-9_-]{86}$/);
      const parsed = parseLinkCode(code);
      expect(parsed && bytesToHex(parsed.seed)).toBe(bytesToHex(bytes(c.seed)));
      expect(parsed && bytesToHex(parsed.commitment)).toBe(bytesToHex(bytes(c.commitment)));
    });

    it('derives the pairing mailbox and seal key from the seed', () => {
      const channel = pairingChannelOf(bytes(c.seed));
      expect(channel.mailbox).toBe(base64url(bytes(c.pairingMailbox)));
      expect(bytesToHex(channel.key)).toBe(bytesToHex(bytes(c.pairingKey)));
    });

    it('builds the transcript T = tag ‖ s ‖ E_A ‖ E_B', () => {
      expect(bytesToHex(fromA(c).transcript)).toBe(bytesToHex(bytes(c.transcript)));
    });

    it('gives both devices the same number, K and bundle mailbox', () => {
      for (const side of [fromA(c), fromB(c)]) {
        expect(bytesToHex(side.shared)).toBe(bytesToHex(bytes(c.shared)));
        expect(side.number).toBe(c.number);
        expect(linkNumber(side.shared, side.transcript)).toBe(c.number);
        expect(bytesToHex(side.key)).toBe(bytesToHex(bytes(c.key)));
        expect(side.bundle.mailbox).toBe(base64url(bytes(c.bundleMailbox)));
        expect(bytesToHex(side.bundle.key)).toBe(bytesToHex(bytes(c.key)));
      }
    });

    it('gives another number and K when any part of T changes', () => {
      const { shared } = fromA(c);
      const swapped = linkTranscript(bytes(c.seed), bytes(c.publicB), bytes(c.publicA));
      const otherSeed = linkTranscript(
        bytes(c.seed.map((byte, i) => (i === 0 ? byte ^ 1 : byte))),
        bytes(c.publicA),
        bytes(c.publicB),
      );
      for (const transcript of [swapped, otherSeed]) {
        const other = linkSecrets(shared, transcript);
        expect(bytesToHex(other.key)).not.toBe(bytesToHex(bytes(c.key)));
      }
    });
  });

  it.each(file.lowOrder.map((point) => [point.name, point] as const))(
    'refuses %s, whose shared secret is all zeros',
    (_name, point) => {
      const [c] = file.cases;
      if (c === undefined) throw new Error('link.json has no case.');
      expect(() => sharedSecret(bytes(c.secretA), bytes(point.publicKey))).toThrow(LinkRefused);
    },
  );
});

describe('parseLinkCode', () => {
  const [c] = file.cases;
  if (c === undefined) throw new Error('link.json has no case.');
  const code = linkCode(bytes(c.seed), bytes(c.publicA));

  it('trims the text around a pasted code', () => {
    expect(parseLinkCode(`  ${code}\n`)?.seed.length).toBe(LINK_SEED_BYTES);
  });

  it.each([
    ['nothing', ''],
    ['the code without its prefix', code.slice(LINK_CODE_PREFIX.length)],
    ['another prefix', `RL2.${code.slice(4)}`],
    ['a lowercase prefix', `rl1.${code.slice(4)}`],
    ['a code one character short', code.slice(0, -1)],
    ['a code one character long', `${code}A`],
    ['a character base64url lacks', `${code.slice(0, -1)}+`],
    ['a space inside', `${code.slice(0, 20)} ${code.slice(20)}`],
    ['padding', `${code}==`],
    ['an invite link', 'https://reconcile.test/#join/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ])('reads %s as no code', (_name, text) => {
    expect(parseLinkCode(text)).toBeNull();
  });

  it('refuses a final character whose spare bits aren t zero', () => {
    // 64 bytes fill 85⅓ characters, so the 86th has 4 spare bits; setting the lowest
    // keeps the bytes the same but spells them another way.
    const alphabet = `${span('A', 'Z')}${span('a', 'z')}${span('0', '9')}-_`;
    const last = alphabet.indexOf(code.at(-1) ?? '');
    expect(last % 16).toBe(0);
    expect(parseLinkCode(`${code.slice(0, -1)}${alphabet.charAt(last + 1)}`)).toBeNull();
  });

  it('reads back every code it writes', () => {
    fc.assert(
      fc.property(keys32, keys32, (seed, publicKey) => {
        const parsed = parseLinkCode(linkCode(seed, publicKey));
        expect(parsed && bytesToHex(parsed.seed)).toBe(bytesToHex(seed));
        expect(parsed && matchesCommitment(publicKey, parsed.commitment)).toBe(true);
      }),
    );
  });
});

describe('linkCode', () => {
  it('refuses a seed that isn t 32 bytes', () => {
    const { publicKey } = newLinkKeys();
    expect(() => linkCode(new Uint8Array(31), publicKey)).toThrow(
      new RangeError('A link seed is 32 bytes.'),
    );
    expect(() => pairingChannelOf(new Uint8Array(33))).toThrow(
      new RangeError('A link seed is 32 bytes.'),
    );
  });
});

describe('matchesCommitment', () => {
  it('refuses a commitment of the wrong length', () => {
    const { publicKey } = newLinkKeys();
    const code = parseLinkCode(linkCode(newLinkSeed(), publicKey));
    const commitment = code?.commitment ?? new Uint8Array(32);
    expect(matchesCommitment(publicKey, commitment)).toBe(true);
    expect(matchesCommitment(publicKey, commitment.subarray(0, 31))).toBe(false);
  });
});

describe('fresh seeds and keys', () => {
  it('makes a new 32-byte seed each time', () => {
    const one = newLinkSeed();
    const two = newLinkSeed();
    expect(one.length).toBe(LINK_SEED_BYTES);
    expect(bytesToHex(one)).not.toBe(bytesToHex(two));
  });

  it('makes one-time X25519 keys whose exchange agrees', () => {
    const a = newLinkKeys();
    const b = newLinkKeys();
    expect(a.publicKey.length).toBe(32);
    expect(bytesToHex(a.secretKey)).not.toBe(bytesToHex(b.secretKey));
    expect(bytesToHex(sharedSecret(a.secretKey, b.publicKey))).toBe(
      bytesToHex(sharedSecret(b.secretKey, a.publicKey)),
    );
  });

  it('names no invite mailbox: a link seed and an invite seed of the same bytes differ', () => {
    const seed = newLinkSeed();
    expect(pairingChannelOf(seed).mailbox).not.toBe(inviteChannelOf(seed).mailbox);
  });

  it('refuses a public key that isn t 32 bytes', () => {
    const { secretKey } = newLinkKeys();
    expect(() => sharedSecret(secretKey, new Uint8Array(31))).toThrow(LinkRefused);
  });
});
