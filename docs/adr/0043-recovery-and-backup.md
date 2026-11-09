# ADR-0043: Recovery Numbers, a Fixed 72-Hour Wait, and an Encrypted Backup

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-identity-recovery`, decisions `recovery-threshold`, `recovery-delay`, `lost-everything`
- **Refines:** [ADR-0008](0008-passkeys-and-social-recovery.md), [ADR-0030](0030-device-key-fallback.md)

## Decision

1. **Each person chooses their recovery contacts and threshold**, from 2 of 3 up to 5 of 7. **The default is 3 of 5**, prefilled. Re-splitting is allowed at any time.
2. **Recovery waits a fixed 72 hours** after enough contacts approve. During the wait, every linked device (ADR-0044) is notified and can cancel. The wait isn't adjustable.
3. **An encrypted backup lives on the relay.**
   - The device keeps a backup of its groups, Working Copies, and personal Documents on the relay, under a random mailbox id that isn't linked to any identity.
   - Only the root key decrypts it, and recovery contacts restore the root key, so there's no new secret to remember.
   - Backups are padded to size buckets and updated on a schedule, not on every change, so size and timing don't reveal activity.

## Consequences

- **The relay stores more data.** Backups expire if not refreshed for a set period, proposed at 180 days (sheet 5 confirms retention).
- **A yearly gentle check-in** asks people to confirm their contacts are still reachable.
- **Spec §3's optional BIP39-style recovery phrase is dropped.** The sheet rejected a printable code, because paper codes get lost or found. *Assumption, stated rather than asked:* the same reasoning applies to a phrase.
- Phase 1 builds the backup alongside recovery (Epic 5).

## Amendment (2026-11-08, decomposition details)

Backups use their own relay endpoint, `/v1/backup/{id}`, with 180-day retention ([ADR-0072](0072-protocol-details-for-decomposition.md)).
