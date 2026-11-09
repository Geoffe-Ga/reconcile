# ADR-0057: Staging and Production; Versioned Protocol Changes; Relay Retention

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-pilot-ops`, decisions `environments`, `updates`, `retention`
- **Builds on:** [ADR-0041](0041-digitalocean-relay-hosting.md), [ADR-0043](0043-recovery-and-backup.md)

## Decision

**Environments**
- Two small DigitalOcean VMs, about $10–12 a month together.
- A merge to `main` deploys to **staging** automatically.
- **Production** deploys only when the founder pushes a release tag.
- Each VM gets its own scoped deploy key.

**Updates**
- App-only changes install in the background and apply on the next launch.
- **The validation rules change only through a new protocol version `v`, never retroactively.** Devices reject events with an unknown `v` and show "Update Reconcile to keep up with your group."
- Old events keep validating under their own version's rules. Every version has its own test vectors.

**Retention**
- Mailbox blobs: **30 days**, as already in spec §6.
- Backups: deleted **180 days** after their last refresh.

## Consequences

- Epic 2 issue 6 (deploy) covers both environments and the tag-triggered production deploy.
- The founder creates and pays for both VMs (ADR-0041).
- Validators dispatch on `v`. Vectors live in `protocol/vectors/v1/` and so on.

## Amendment (2026-11-08, decomposition details)

Backups use their own endpoint, `/v1/backup/{id}`, with the 180-day retention above. Expiry times are rounded to the day. CI smoke-tests staging after each deploy, without blocking merges ([ADR-0072](0072-protocol-details-for-decomposition.md)).
