/**
 * A fake `navigator.credentials` for tests (#95): one authenticator that
 * makes passkeys and, when asked, evaluates PRF the way a real one does, as a
 * keyed hash of the salt under a secret only that passkey holds. It keeps
 * every options object it was handed, so a test can read exactly what the
 * app asked for.
 */
import { sha256 } from '../crypto/hash';
import type { CredentialCalls } from '../platform/webauthn';

/** How the fake answers. Each field can change between calls. */
export interface FakeAuthenticatorSettings {
  /** The PRF output's length when asked, or null for none at all (default 32). */
  prfBytes: number | null;
  /** Whether the authenticator data sets the UV flag (default true). */
  verified: boolean;
  /** Whether `create()` also returns PRF output, which the app must ignore (default false). */
  prfOnCreate: boolean;
  /** Whether the next calls reject, as a cancelled prompt does (default false). */
  cancels: boolean;
}

/** The fake, what it was asked, and its settings. */
export interface FakeAuthenticator {
  readonly calls: CredentialCalls;
  readonly created: CredentialCreationOptions[];
  readonly asked: CredentialRequestOptions[];
  readonly settings: FakeAuthenticatorSettings;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The bytes in a buffer source. */
function bytesOf(source: BufferSource | undefined): Uint8Array {
  if (source === undefined) return new Uint8Array(0);
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

/** The passkey a `get()` asks for, and the salt it asks PRF to evaluate. */
function requested(options: CredentialRequestOptions): { id: Uint8Array; salt: Uint8Array } {
  const publicKey = options.publicKey;
  return {
    id: bytesOf(publicKey?.allowCredentials?.[0]?.id),
    salt: bytesOf(publicKey?.extensions?.prf?.eval?.first),
  };
}

/** Authenticator data: the rpIdHash, the flags (UP, and UV when verified), and a counter. */
function authenticatorData(verified: boolean): ArrayBuffer {
  const data = new Uint8Array(37);
  data[32] = verified ? 0x05 : 0x01;
  return data.buffer;
}

/** A credential as the browser hands one back. */
function answer(id: Uint8Array, prf: Uint8Array | null, verified: boolean) {
  const outputs = prf === null ? {} : { prf: { results: { first: Uint8Array.from(prf).buffer } } };
  return {
    rawId: Uint8Array.from(id).buffer,
    response: { authenticatorData: authenticatorData(verified) },
    getClientExtensionResults: () => outputs,
  };
}

/** A new fake authenticator; `settings` overrides its defaults. */
export function fakeAuthenticator(
  settings: Partial<FakeAuthenticatorSettings> = {},
): FakeAuthenticator {
  const current: FakeAuthenticatorSettings = {
    prfBytes: 32,
    verified: true,
    prfOnCreate: false,
    cancels: false,
    ...settings,
  };
  const secrets = new Map<string, Uint8Array>();
  const created: CredentialCreationOptions[] = [];
  const asked: CredentialRequestOptions[] = [];
  const prfOf = (id: Uint8Array, salt: Uint8Array, length: number): Uint8Array => {
    const full = sha256(Uint8Array.of(...(secrets.get(hex(id)) ?? []), ...salt));
    return Uint8Array.from({ length }, (_, i) => full[i % full.length] ?? 0);
  };
  const calls: CredentialCalls = {
    create(options) {
      created.push(options);
      if (current.cancels) return Promise.reject(new DOMException('Cancelled.', 'NotAllowedError'));
      const id = crypto.getRandomValues(new Uint8Array(16));
      secrets.set(hex(id), crypto.getRandomValues(new Uint8Array(32)));
      const prf = current.prfOnCreate ? prfOf(id, new Uint8Array(32), 32) : null;
      return Promise.resolve(answer(id, prf, current.verified));
    },
    get(options) {
      asked.push(options);
      if (current.cancels) return Promise.reject(new DOMException('Cancelled.', 'NotAllowedError'));
      const { id, salt } = requested(options);
      const { prfBytes } = current;
      const prf = prfBytes === null || !secrets.has(hex(id)) ? null : prfOf(id, salt, prfBytes);
      return Promise.resolve(answer(id, prf, current.verified));
    },
  };
  return { calls, created, asked, settings: current };
}
