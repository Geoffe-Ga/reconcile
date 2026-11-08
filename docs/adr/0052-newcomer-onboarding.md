# ADR-0052: Newcomers Preview First, Join Provisionally, and Finish Recovery Within the Voting Wait

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-onboarding-ux`, decisions `first-contacts` (chose `both`), `first-run` (chose `preview-first`)
- **Refines:** [ADR-0030](0030-device-key-fallback.md), [ADR-0043](0043-recovery-and-backup.md), [ADR-0014](0014-invite-and-vouch-admission.md)

## Decision

**First run**
1. An invite link opens a **preview card** with the group's name, a mission excerpt, and the inviter's pseudonym in that group. The preview travels inside the encrypted invite payload, not on a server.
2. Install to the Home Screen (iOS; ADR-0029), create a passkey, and choose a name (ADR-0045).
3. Recovery setup (below), then join.
4. During the 14-day wait, the newcomer reads Documents and Proposals and sees a warm countdown to voting.

**First recovery contacts**
- **The inviter counts as the first recovery contact**, and the newcomer joins right away.
- **They invite other contacts from outside the app**, by text, email, or any chat. A recovery contact installs Reconcile only to hold a share. They join no group, and no group or roster sees them.
- **The newcomer must reach their chosen threshold within 14 days**, which is also the wait before voting. Voting rights arrive only once recovery is complete as well, so ADR-0030's rule holds by the time someone can vote.

## Consequences

- A contact-only install path: install, passkey, and accept a share. Nothing else.
- For up to 14 days, a newcomer depends on the inviter's share plus the relay backup (ADR-0043).
- Validation: `level-change` to a voting level also needs a recovery-complete attestation from the member's own device. *Assumption, stated rather than asked:* this is a signed self-attestation, because recovery contacts must not appear in the group log.
