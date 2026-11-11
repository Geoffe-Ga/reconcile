/**
 * WebAuthn, for passkey unlock (#95; ADR-0008, ADR-0030). This is the only
 * file that reaches `navigator.credentials` (ESLint fails on it anywhere
 * else), and every call goes through an injectable {@link CredentialCalls},
 * so tests hand in a fake authenticator.
 *
 * A passkey here proves nothing to a server: there is none. Reconcile uses it
 * only for its PRF output, which derives the key the device's secrets are
 * sealed under (`crypto/keyVault.ts`). So the challenge is random and never
 * checked, and the password manager learns only the site's host, the name
 * "Reconcile", and the user name "Reconcile key" over a random user id:
 * nothing about any group or person.
 *
 * - **Tap 1** ({@link WebAuthn.createCredential}) makes the passkey. iOS
 *   allows one WebAuthn call per tap, so the first time asks twice. Some
 *   providers say nothing about PRF at creation, or say it wrongly, so any
 *   PRF answer from `create()` is ignored (ADR-0030).
 * - **Tap 2 and each unlock** ({@link WebAuthn.evaluatePrf}) ask that one
 *   passkey, with user verification required, to evaluate PRF on a salt. The
 *   output counts only when it is exactly 32 bytes and the authenticator data
 *   says the user was verified (flag 0x04). The browser's copy is zeroed once
 *   read.
 *
 * A cancel, an error, or an answer from another credential rejects with
 * {@link PasskeyUnanswered}, which is never a verdict on PRF.
 */

/** The two calls the app makes of `navigator.credentials`. */
export interface CredentialCalls {
  create(options: CredentialCreationOptions): Promise<unknown>;
  get(options: CredentialRequestOptions): Promise<unknown>;
}

/** What the passkey's password manager sees as the site's name. */
const RP_NAME = 'Reconcile';

/** The passkey's user name and display name: the same for everyone, naming no one. */
const USER_NAME = 'Reconcile key';

/** COSE algorithms, in order of preference: Ed25519, ES256, RS256. */
const ALGORITHMS = [-8, -7, -257] as const;

/** The random user id's and challenge's length. */
const RANDOM_BYTES = 32;

/** The PRF output's only usable length. */
const PRF_BYTES = 32;

/** Where the flags byte sits in the authenticator data: after the 32-byte rpIdHash. */
const FLAGS_AT = 32;

/** The authenticator data's User Verified flag. */
export const UV_FLAG = 0x04;

/** Thrown when the passkey made nothing, didn't answer, or another one answered. */
export class PasskeyUnanswered extends Error {
  /** Say the passkey didn't answer. */
  constructor() {
    super('The passkey didn’t answer.');
    this.name = 'PasskeyUnanswered';
  }
}

/** Reconcile's passkey calls. */
export interface WebAuthn {
  /**
   * Tap 1: makes a passkey for `rpId` and returns its credential id.
   *
   * @throws {PasskeyUnanswered} when no passkey was made.
   */
  createCredential(rpId: string): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Tap 2 and each unlock: the passkey `credentialId`'s 32-byte PRF output
   * for `salt`, or null when it gave none that counts.
   *
   * @throws {PasskeyUnanswered} when it didn't answer, or another passkey did.
   */
  evaluatePrf(
    rpId: string,
    credentialId: Uint8Array,
    salt: Uint8Array,
  ): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** `length` random bytes from the platform's CSPRNG. */
function random(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Whether `value` is an object, so its fields can be read. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A view of the bytes in `value` when it is an ArrayBuffer or a view of one, or null. */
function bytesIn(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** The credential id in a browser's answer, copied, or null when it holds none. */
function idOf(answer: unknown): Uint8Array<ArrayBuffer> | null {
  const raw = isObject(answer) ? bytesIn(answer.rawId) : null;
  return raw === null || raw.length === 0 ? null : Uint8Array.from(raw);
}

/** Whether `a` and `b` hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Whether the answer's authenticator data says the user was verified. */
function userVerified(answer: Record<string, unknown>): boolean {
  const response = answer.response;
  const data = isObject(response) ? bytesIn(response.authenticatorData) : null;
  return ((data?.[FLAGS_AT] ?? 0) & UV_FLAG) === UV_FLAG;
}

/** The browser's own copy of the PRF output in `answer`, or null. */
function prfIn(answer: Record<string, unknown>): Uint8Array | null {
  const results = answer.getClientExtensionResults;
  if (typeof results !== 'function') return null;
  const outputs = (results as () => AuthenticationExtensionsClientOutputs).call(answer);
  return bytesIn(outputs.prf?.results?.first);
}

/**
 * The 32-byte PRF output in `answer`, copied, when the user was verified;
 * null otherwise. Whatever the browser held is zeroed either way.
 */
function usablePrf(answer: Record<string, unknown>): Uint8Array<ArrayBuffer> | null {
  const held = prfIn(answer);
  if (held === null) return null;
  const output = held.length === PRF_BYTES && userVerified(answer) ? Uint8Array.from(held) : null;
  held.fill(0);
  return output;
}

/** The options for tap 1: exactly what #95 names, and nothing about any group. */
function creationOptions(rpId: string): CredentialCreationOptions {
  return {
    publicKey: {
      rp: { id: rpId, name: RP_NAME },
      user: { id: random(RANDOM_BYTES), name: USER_NAME, displayName: USER_NAME },
      challenge: random(RANDOM_BYTES),
      pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      extensions: { prf: {} },
    },
  };
}

/** The options for tap 2 and each unlock: one passkey, verified, evaluating PRF on `salt`. */
function requestOptions(
  rpId: string,
  credentialId: Uint8Array,
  salt: Uint8Array,
): CredentialRequestOptions {
  return {
    publicKey: {
      rpId,
      challenge: random(RANDOM_BYTES),
      allowCredentials: [{ type: 'public-key', id: Uint8Array.from(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: Uint8Array.from(salt) } } },
    },
  };
}

/** What `call` resolves to, or {@link PasskeyUnanswered} when it rejects. */
async function answered(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch {
    throw new PasskeyUnanswered();
  }
}

/** Reconcile's passkey calls over `calls`. */
export function webAuthn(calls: CredentialCalls): WebAuthn {
  return {
    async createCredential(rpId) {
      const id = idOf(await answered(() => calls.create(creationOptions(rpId))));
      if (id === null) throw new PasskeyUnanswered();
      return id;
    },
    async evaluatePrf(rpId, credentialId, salt) {
      const answer = await answered(() => calls.get(requestOptions(rpId, credentialId, salt)));
      const id = idOf(answer);
      if (!isObject(answer) || id === null || !same(id, credentialId)) {
        throw new PasskeyUnanswered();
      }
      return usablePrf(answer);
    },
  };
}

/** The browser's `navigator.credentials`, or undefined where it has no WebAuthn. */
export function browserCredentials(): CredentialCalls | undefined {
  if (typeof globalThis.PublicKeyCredential !== 'function') return undefined;
  const { credentials } = navigator as Partial<Navigator>;
  if (credentials === undefined) return undefined;
  return {
    create: (options) => credentials.create(options),
    get: (options) => credentials.get(options),
  };
}
