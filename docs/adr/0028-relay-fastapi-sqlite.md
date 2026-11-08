# ADR-0028: The Relay Is FastAPI with SQLite

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `relay-stack`
- **Builds on:** [ADR-0007](0007-thin-python-relay.md), [ADR-0019](0019-sealed-sender-relay.md)

## Decision

- **FastAPI on Uvicorn**, always run with `--no-access-log`. Request validation and API docs come with it.
- **Blobs live in SQLite** (WAL mode), with an `expires_at` index and a periodic `DELETE` for expiry. Storing blobs as files was rejected because file times and directory listings leak structure, and atomic expiry is harder.
- Long-polling is the fallback when a WebSocket drops.

## Consequences

- Epic 2 issue 4 ("no logs, no IPs") must test that nothing is written on a request: not by Uvicorn, not by the reverse proxy (ADR-0041), not by the app.
- Web Push goes out through `pywebpush` (MPL-2.0, used unmodified, so it's fine in a source-available project), with content-free payloads (ADR-0012).
