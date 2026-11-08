# ADR-0005: The Client Is an Installable Web App (PWA)

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `client-platform`

## Context

Under local-first (ADR-0001) the client holds the canonical data, so the client platform is the product. We weighed a PWA, React Native, and Tauri 2.

## Decision

**The client is a TypeScript Progressive Web App** that installs to the home screen and works offline. No app-store distribution is required, so Apple and Google can't remove Reconcile in a hostile jurisdiction.

## Consequences

- **Storage eviction is the top risk.** Browsers can evict origin storage. The client must request persistent storage (`navigator.storage.persist()`), warn when it's denied, and keep every group's data replicated on other members' devices and in the relay's encrypted mailboxes, so no device holds the only copy.
- **iOS constraints shape features.** Web push on iOS needs the app installed to the home screen (iOS 16.4+), and background sync is limited. Dispatch delivery (ADR-0012) must tolerate both.
- **Python is not the client language.** Python is for the relay (ADR-0007) and for protocol reference code and test vectors.
- **Reversible later:** the UI can be wrapped (Capacitor, Tauri) if a native shell becomes necessary. The sync and crypto core stays the same.
