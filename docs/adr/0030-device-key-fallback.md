# ADR-0030: Without Passkey PRF, a Device Key Plus Mandatory Recovery

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `keys-without-prf`
- **Refines:** [ADR-0008](0008-passkeys-and-social-recovery.md); resolves spec §9 spike 2

## Decision

- **PRF is the main path.** Where the passkey supports the PRF extension, its output wraps the root key. It works with iCloud Keychain on iOS 18.4+ and macOS 15+, Google Password Manager on Android, Windows Hello on current Windows 11, and 1Password.
- **Without PRF, a non-extractable WebCrypto key held by the browser wraps the root key.** That covers Bitwarden on iOS, Dashlane, NordPass, Microsoft's Edge manager, older Windows, and iOS before 18.4 (ADR-0042).
- **Social recovery setup is mandatory before joining any group**, on both paths.
- **PRF is detected at the first sign-in, not at creation**, because some providers return nothing at creation but work on sign-in.
- **A passphrase stretched with Argon2id is an opt-in extra**, never required.
- This replaces the spec's earlier fallback (a device PIN through Argon2id).

## Consequences

- On the device-key path, unlock isn't tied to biometrics on that device. The app lock (ADR-0018) still applies.
- Wiping browser data loses the device key, and recovery restores it.
- **On iOS 18.0–18.3, PRF isn't used even when offered**, because of known bugs there that could lose data.
