# ADR-0008: Passkeys Plus Social Recovery, No Platform Sign-In

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `identity-root`

## Context

The onboarding slide says "Sign in with Google/FB". That would hand a platform the link between a real identity and someone's politics. Under local-first, identity is a signing key on the device. The hard part is recovery.

## Decision

- **Identity is a root keypair generated on the device.** A passkey (WebAuthn, using the PRF extension where available) unlocks it locally, so there is no password. The passkey provider syncs only the unlock credential, never the identity or any group data.
- **There is no Google or Facebook sign-in.**
- **Recovery is social.** The member chooses or invites several trusted people as **recovery contacts**. Their devices hold encrypted shares of the root key (threshold sharing, for example 3 of 5). A lost identity comes back when enough of them approve.
- **A recovery phrase is an optional fallback** for people with no one to choose yet.

**From the user's notes:** the member picks their own recovery contacts. Inviting them is also an on-ramp: "Reconcile is built on shared trust and has no password reset. Choose a few people who know you."

## Consequences

- **Recovery contacts know the member uses Reconcile**, but not which groups they're in (per-group identities, ADR-0009). Shares attach to the root key, never to a group identity.
- **Colluding contacts could take over an identity.** Mitigations: a time delay with a notice to every existing device before recovery completes, a cancel from any live device, and a threshold the member picks.
- **Passkey PRF support varies by browser.** Where it's missing, fall back to a locally encrypted key with a device PIN.
- Group recovery counts as onboarding growth, so measure it without building a central social graph. Counts stay on devices.

## Amendment (2026-11-08, four-lenses review)

Recovery contacts are framed as trust, never as growth. The last consequence above ("group recovery counts as onboarding growth") is withdrawn: nothing counts recovery-driven joins, even on devices, and the invitation copy never mentions growing Reconcile.
