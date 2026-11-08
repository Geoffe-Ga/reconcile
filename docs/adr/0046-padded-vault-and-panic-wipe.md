# ADR-0046: Hidden Groups Use a Padded Vault; Panic Wipe by Hold or Wrong Codes

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-identity-recovery`, decisions `duress-approach`, `panic-wipe`
- **Refines:** [ADR-0018](0018-device-protection-and-duress.md)

## Decision

1. **The local store is a fixed-size, padded vault from Phase 1.**
   - All group data is padded to size buckets, and random filler can't be told apart from encrypted groups.
   - Hidden groups use keys that only the real unlock derives.
   - Writes are scheduled, so timing doesn't reveal a hidden group.
2. **The duress PIN ships only after an external security review, so it is not in the pilot.** The store format is built right from the start, so nothing has to migrate.
3. **Panic wipe:**
   - Press and hold a Settings item for 3 seconds. It's also available from the app-lock screen.
   - **Opt-in, off by default:** wipe after a chosen number of wrong app-lock codes.
   - A wipe erases everything local. Recovery contacts plus the relay backup (ADR-0043) restore it.

## Consequences

- The client store design in Epic 4 implements the padded vault. Duress UI waits for the review.
- The wrong-code wipe is explained plainly where it's switched on: "A child or anyone holding your phone could trigger this."
