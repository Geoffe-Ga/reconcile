# ADR-0041: The Pilot Relay Runs on a DigitalOcean VM We Terminate TLS On

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `hosting`
- **Builds on:** [ADR-0020](0020-us-nonprofit-zero-knowledge.md), [ADR-0033](0033-legal-entity-staging.md)

## Decision

- **A small DigitalOcean Droplet in a US region**, about $4–6 a month.
- **We terminate TLS ourselves** (Caddy, with logging off), so no platform proxy sees members' IP addresses. Fly.io was rejected for this reason: its edge proxy sees client IPs, and its proxy log retention is undocumented.
- DigitalOcean publishes a transparency report twice a year.
- During the founder-owned pilot (ADR-0033 stage 1), the founder holds the account and pays.

## Consequences

- We patch the OS: unattended upgrades and a minimal image.
- The relay ships as a container, so moving hosts is cheap.
- **Creating the account and paying for it is the founder's action.** Nothing is provisioned until the deploy issue (Epic 2 issue 6).
