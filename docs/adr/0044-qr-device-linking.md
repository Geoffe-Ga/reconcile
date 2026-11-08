# ADR-0044: A Second Device Links by QR Code

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-identity-recovery`, decision `multi-device`

## Decision

- **An existing, unlocked device shows a short-lived QR code. The new device scans it and receives the keys over an encrypted channel.** Both screens show a confirmation number to defeat shoulder-surfing.
- **Settings lists every linked device**, and any one can be removed. Removing a device rotates the keys it held.
- Linked devices all receive the recovery-delay notice (ADR-0043).

## Consequences

- Phase 1 includes linking (Epic 5, about 1–2 weeks), so long drafts can be written on a laptop.
- A seized second device is revoked from any other device. The app lock (ADR-0018) protects it until then.
