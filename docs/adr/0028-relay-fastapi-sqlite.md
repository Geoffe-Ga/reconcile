# ADR-0028: The Relay Is FastAPI with SQLite

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
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

## Amendment (2026-11-10, #89)

- **Web Push uses py-vapid and httpx2, not `pywebpush`.** Pushes carry no payload (ADR-0012), so `pywebpush`'s RFC 8291 encryption, and the `requests` and `aiohttp` it brings, have nothing to do. py-vapid (MPL-2.0, used unmodified) signs each push (RFC 8292), and httpx2, which Starlette's TestClient already runs on, sends it.
- **Push adds two tables beside `blobs`,** as ADR-0019's "endpoints and wake minutes, nothing else" allows: `push_subs(mailbox, endpoint, expiry)` and `nudges(mailbox, due)`, with no push keys, timestamps or counters ([spec §6](../spec/phase-1-spec.md#6-relay-api)).
