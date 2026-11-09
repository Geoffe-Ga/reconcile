# ADR-0007: A Thin Python Relay

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `relay`

## Context

Peers are offline at different times, and browsers can't reach each other directly without help. ADR-0001 requires that any server be unable to read or enumerate membership, affiliations, or votes.

## Decision

**We run a small Python service that stores and forwards encrypted blobs by opaque mailbox id** and sends content-free wake-ups (ADR-0012). It has no accounts, no member table, and no plaintext. It doubles as the executable protocol reference, with test vectors the TypeScript client must pass.

## Consequences

- **Metadata is the residual risk.** IP addresses and timing can show who talks to whom. Minimum: no request logging by default, short blob retention, and mailbox ids that rotate. Whether to add sealed sender, padding, or Tor is open in the security and moderation sheet.
- Anyone can run a relay. Groups can choose or self-host one, so seizing ours doesn't stop the network.
- The relay is stateless enough to rebuild from scratch. Losing it loses no canonical data.
