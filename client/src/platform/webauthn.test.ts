/**
 * `webauthn.ts` (#95) against a fake `navigator.credentials`: the exact
 * options each tap sends, and which answers count as PRF output.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  browserCredentials,
  type CredentialCalls,
  PasskeyUnanswered,
  UV_FLAG,
  webAuthn,
} from './webauthn';

const RP_ID = 'reconcile.example';
const CREDENTIAL_ID = Uint8Array.from([7, 7, 7, 1, 2, 3]);
const SALT = new Uint8Array(32).fill(0x5a);

/** Authenticator data: a 32-byte rpIdHash, the flags byte, then a 4-byte counter. */
function authenticatorData(flags: number): ArrayBuffer {
  const data = new Uint8Array(37);
  data[32] = flags;
  return data.buffer;
}

interface Answer {
  readonly rawId?: Uint8Array;
  readonly prf?: Uint8Array | null;
  readonly flags?: number;
}

/** A credential as the browser hands one back, with `answer`'s id, PRF output and flags. */
function credential({ rawId = CREDENTIAL_ID, prf = null, flags = 0x05 }: Answer = {}) {
  const results = prf === null ? {} : { prf: { results: { first: Uint8Array.from(prf).buffer } } };
  return {
    rawId: Uint8Array.from(rawId).buffer,
    response: { authenticatorData: authenticatorData(flags) },
    getClientExtensionResults: () => results,
  };
}

/** A fake `navigator.credentials` whose calls answer with `create` and `get`. */
function fakeCalls(
  answers: { create?: () => Promise<unknown>; get?: () => Promise<unknown> } = {},
) {
  const create = vi.fn<CredentialCalls['create']>(
    answers.create ?? (() => Promise.resolve(credential())),
  );
  const get = vi.fn<CredentialCalls['get']>(
    answers.get ?? (() => Promise.resolve(credential({ prf: new Uint8Array(32).fill(1) }))),
  );
  return { create, get };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCredential: tap 1', () => {
  it('asks for a passkey with exactly the issue’s options, and returns its id', async () => {
    const calls = fakeCalls();

    const id = await webAuthn(calls).createCredential(RP_ID);

    expect(Array.from(id)).toEqual(Array.from(CREDENTIAL_ID));
    expect(calls.get).not.toHaveBeenCalled();
    const [options] = calls.create.mock.calls[0] ?? [];
    const { user, challenge, ...publicKey } = options?.publicKey ?? ({} as never);
    expect(publicKey).toEqual({
      rp: { id: RP_ID, name: 'Reconcile' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      extensions: { prf: {} },
    });
    expect(Object.keys(options ?? {})).toEqual(['publicKey']);
    expect(user.name).toBe('Reconcile key');
    expect(user.displayName).toBe('Reconcile key');
    expect(new Uint8Array(user.id as ArrayBuffer)).toHaveLength(32);
    expect(new Uint8Array(challenge as ArrayBuffer)).toHaveLength(32);
  });

  it('makes a new random user id and challenge for every passkey', async () => {
    const calls = fakeCalls();
    const passkeys = webAuthn(calls);

    await passkeys.createCredential(RP_ID);
    await passkeys.createCredential(RP_ID);

    const [first, second] = calls.create.mock.calls.map(([options]) => options.publicKey);
    const hex = (bytes: BufferSource | undefined) =>
      Array.from(new Uint8Array(bytes as ArrayBuffer)).join(',');
    expect(hex(first?.user.id)).not.toBe(hex(second?.user.id));
    expect(hex(first?.challenge)).not.toBe(hex(second?.challenge));
    expect(hex(first?.user.id)).not.toBe(hex(first?.challenge));
  });

  it('ignores any PRF output create() gives', async () => {
    const prf = new Uint8Array(32).fill(9);
    const calls = fakeCalls({ create: () => Promise.resolve(credential({ prf })) });

    const id = await webAuthn(calls).createCredential(RP_ID);

    expect(Array.from(id)).toEqual(Array.from(CREDENTIAL_ID));
  });

  it.each([
    ['the person cancels', () => Promise.reject(new DOMException('No', 'NotAllowedError'))],
    ['the browser returns nothing', () => Promise.resolve(null)],
    ['the answer has no id', () => Promise.resolve({ rawId: 'not bytes' })],
    ['the answer has an empty id', () => Promise.resolve(credential({ rawId: new Uint8Array(0) }))],
  ])('fails with PasskeyUnanswered when %s', async (_name, create) => {
    await expect(webAuthn(fakeCalls({ create })).createCredential(RP_ID)).rejects.toThrow(
      PasskeyUnanswered,
    );
  });
});

describe('evaluatePrf: tap 2, and each unlock', () => {
  it('asks that one passkey, with user verification, to evaluate PRF on the salt', async () => {
    const calls = fakeCalls();

    await webAuthn(calls).evaluatePrf(RP_ID, CREDENTIAL_ID, SALT);

    expect(calls.create).not.toHaveBeenCalled();
    const [options] = calls.get.mock.calls[0] ?? [];
    const { challenge, allowCredentials, extensions, ...publicKey } =
      options?.publicKey ?? ({} as never);
    expect(publicKey).toEqual({ rpId: RP_ID, userVerification: 'required' });
    expect(Object.keys(options ?? {})).toEqual(['publicKey']);
    expect(new Uint8Array(challenge as ArrayBuffer)).toHaveLength(32);
    expect(
      allowCredentials?.map(({ type, id }) => [
        type,
        Array.from(new Uint8Array(id as ArrayBuffer)),
      ]),
    ).toEqual([['public-key', Array.from(CREDENTIAL_ID)]]);
    expect(Object.keys(extensions ?? {})).toEqual(['prf']);
    const first = extensions?.prf?.eval?.first;
    expect(Array.from(new Uint8Array(first as ArrayBuffer))).toEqual(Array.from(SALT));
  });

  it('returns a 32-byte PRF output when the UV flag is set, and zeroes the browser’s copy', async () => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const answer = credential({ prf });
    const calls = fakeCalls({ get: () => Promise.resolve(answer) });

    const output = await webAuthn(calls).evaluatePrf(RP_ID, CREDENTIAL_ID, SALT);

    expect(Array.from(output ?? [])).toEqual(Array.from(prf));
    const browserCopy = answer.getClientExtensionResults().prf?.results.first;
    expect(Array.from(new Uint8Array(browserCopy ?? new ArrayBuffer(1)))).toEqual(
      new Array<number>(32).fill(0),
    );
  });

  it.each([
    ['31 bytes', { prf: new Uint8Array(31).fill(3) }],
    ['33 bytes', { prf: new Uint8Array(33).fill(3) }],
    ['no PRF output', { prf: null }],
    ['the UV flag unset', { prf: new Uint8Array(32).fill(3), flags: 0x01 }],
    ['every flag but UV', { prf: new Uint8Array(32).fill(3), flags: 0xff ^ UV_FLAG }],
  ])('means no PRF with %s', async (_name, answer: Answer) => {
    const reply = credential(answer);
    const calls = fakeCalls({ get: () => Promise.resolve(reply) });

    expect(await webAuthn(calls).evaluatePrf(RP_ID, CREDENTIAL_ID, SALT)).toBeNull();
    const browserCopy = reply.getClientExtensionResults().prf?.results.first;
    if (browserCopy !== undefined)
      expect(new Uint8Array(browserCopy).every((b) => b === 0)).toBe(true);
  });

  it('reads UV as flag 0x04 of the authenticator data’s 33rd byte', async () => {
    const prf = new Uint8Array(32).fill(3);
    const only = (flags: number) =>
      fakeCalls({ get: () => Promise.resolve(credential({ prf, flags })) });

    expect(UV_FLAG).toBe(0x04);
    expect(await webAuthn(only(UV_FLAG)).evaluatePrf(RP_ID, CREDENTIAL_ID, SALT)).not.toBeNull();
    const short = { ...credential({ prf }), response: { authenticatorData: new ArrayBuffer(32) } };
    expect(
      await webAuthn(fakeCalls({ get: () => Promise.resolve(short) })).evaluatePrf(
        RP_ID,
        CREDENTIAL_ID,
        SALT,
      ),
    ).toBeNull();
    const none = { ...credential({ prf }), response: {} };
    expect(
      await webAuthn(fakeCalls({ get: () => Promise.resolve(none) })).evaluatePrf(
        RP_ID,
        CREDENTIAL_ID,
        SALT,
      ),
    ).toBeNull();
  });

  it.each([
    ['the person cancels', () => Promise.reject(new DOMException('No', 'NotAllowedError'))],
    ['the browser returns nothing', () => Promise.resolve(null)],
    ['another passkey answers', () => Promise.resolve(credential({ rawId: Uint8Array.of(1) }))],
    ['the answer isn’t a credential', () => Promise.resolve('credential')],
  ])('fails with PasskeyUnanswered when %s', async (_name, get) => {
    await expect(
      webAuthn(fakeCalls({ get })).evaluatePrf(RP_ID, CREDENTIAL_ID, SALT),
    ).rejects.toThrow(PasskeyUnanswered);
  });
});

describe('browserCredentials', () => {
  it('is undefined where the browser has no WebAuthn, as in jsdom', () => {
    expect(browserCredentials()).toBeUndefined();
  });

  it('calls navigator.credentials where the browser has PublicKeyCredential', async () => {
    const calls = fakeCalls();
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {
      return undefined;
    });
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, credentials: calls });

    const found = browserCredentials();
    await found?.create({ publicKey: {} as PublicKeyCredentialCreationOptions });
    await found?.get({ publicKey: {} as PublicKeyCredentialRequestOptions });

    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.get).toHaveBeenCalledTimes(1);
  });

  it('is undefined when PublicKeyCredential exists but navigator.credentials doesn’t', () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {
      return undefined;
    });

    expect(browserCredentials()).toBeUndefined();
  });
});
