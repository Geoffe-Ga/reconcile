# ADR-0018: App Lock, Panic Wipe, and an Opt-In Duress Login

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `device-seizure` (the user's own approach)

## Context

A member's device holds their groups, member lists, and recent ballots. Border checks, arrests, and abusive partners all mean an adversary holding the phone.

**Positioning, from the user's notes:** Reconcile should be **friendly to anarchists, "the OS for anarcho-syndicalism"**, without looking like a tool only for illegal activity. Protective features exist, but they stay quiet.

## Decision

- **App lock:** a separate passkey or PIN, with auto-lock after inactivity. On by default.
- **Panic wipe:** wipes local data, which can be restored from other members and recovery contacts (ADR-0008).
- **Duress login: off by default, never promoted in onboarding, and found only in Settings.** Once enabled:
  - the member marks each group and coalition as **shown** or **hidden under duress**;
  - a duress PIN opens the **real profile minus the hidden groups**, not a fake decoy, so it holds up to inspection;
  - entering the duress PIN can also quietly wipe the hidden groups' keys.

## Consequences

- Per-group identities (ADR-0009) make this clean: hidden groups are separate keys, stored in a container that only the real unlock opens.
- **Storage must not reveal that a hidden container exists.** Its size and presence must look like ordinary padding. This is the hardest engineering item here and needs an external review.
- Hidden groups should keep syncing in the background without showing up in the duress view or in notifications.
