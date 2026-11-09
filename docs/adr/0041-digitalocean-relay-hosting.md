# ADR-0041: The Pilot Relay Runs on a DigitalOcean VM We Terminate TLS On

- **Status:** Accepted
- **MVP:** the relay runs as a systemd service on one VM, not as a container, until it needs another host (the 2026-11-09 amendment below, and [ADR-0073](0073-mvp-scope.md)).
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

## Amendment (2026-11-09): The MVP Relay Runs as a systemd Service, Not a Container

The second consequence above, "The relay ships as a container, so moving hosts is cheap", doesn't hold for the MVP. The rest of the decision stands: one small Droplet in a US region, our own Caddy terminating TLS with logging off, and the founder holding the account. [ADR-0073](0073-mvp-scope.md) sets the scope this follows: one VM, no staging, no CI deploys and no deploy key in GitHub. [ADR-0074](0074-mvp-scope-revised.md) keeps one VM.

**How the relay runs.** The deploy for [#68](https://github.com/Geoffe-Ga/reconcile/issues/68) ([PR #146](https://github.com/Geoffe-Ga/reconcile/pull/146)) puts the app and the relay on one VM:
- Caddy terminates TLS, discards every log, serves the app, and passes `/v1/` to the relay on `127.0.0.1`.
- `reconcile-relay.service` runs Uvicorn from a venv at `/opt/reconcile/venv`, as its own `reconcile` user, with no access log. systemd hardens it with `NoNewPrivileges`, `ProtectSystem=strict` and `UMask=0077`.
- A daily timer purges expired blobs.
- The founder deploys with `deploy/deploy.sh` from their own machine. It builds, syncs, installs and restarts, then smoke-tests the deploy.

**Why not a container.** #68's Constraints defer containers past the MVP, along with staging, CI deploys and deploy keys in GitHub. On one VM, a container only adds work: an image to build and move, and a container runtime to patch and keep from logging to disk. What it buys is a cheap host move, and the MVP plans none.

**What it costs.** Moving hosts isn't cheap any more. A new VM, or a rebuilt one, needs the one-time setup in `deploy/README.md` run again by hand, from the Droplet and DNS through Caddy, the `reconcile` user and the venv, before `deploy.sh` can run.

**When containers come back.** A new ADR reconsiders them once the relay needs to run anywhere but this one VM:
- **a second host**, such as staging returning with [ADR-0057](0057-environments-updates-retention.md)'s two VMs and CI deploys;
- **a new host**, such as a move to another Droplet or another provider.

That ADR weighs a container against running the setup again. Whatever it chooses, Caddy's and the relay's logs stay off.
