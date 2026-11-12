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
- **Push adds two tables beside `blobs`,** as ADR-0019's "endpoints and wake minutes, nothing else" allows: `push_subs(mailbox, endpoint, expiry)` and `nudges(mailbox, due)`, with no push keys, timestamps or counters ([spec §6](../spec/phase-1/06-relay-api.md)).

## Amendment (2026-11-10, #141)

- **Each mailbox has a byte cap, beside the relay's.** A blob PUT that would take its mailbox's unexpired blobs past `RECONCILE_RELAY_MAX_MAILBOX_BYTES` (default 64 MiB) gets `507 {"error": "mailbox_full"}` and stores nothing, so one flooder, or one runaway client, can't fill the relay for every group. The relay's own cap (`storage_full`, 1 GiB) stays and is checked first. Both are checked on the declared length before the body is read, and the mailbox cap again just before the insert, so uploads in flight together can't carry a mailbox past it.
- **The founder decided this on 2026-11-10:** a per-mailbox byte cap and nothing more. There's no per-IP state, which ADR-0019 rules out, no cap on new mailboxes a day, and no rate limit at Caddy. Mailbox ids cost nothing, so the cap slows a flooder who spreads over many ids rather than stopping one; that stays an accepted pilot risk (ADR-0073) on the one watched VM (#68).
- **Why 64 MiB.** ADR-0056's pilot is 5–15 people for six weeks. Take a deliberately busy group of 15: two Proposals a day, each with a second version, and every member scoring each Proposal twice. In 30 days that's 120 Proposal and version blobs and 1,800 ballots. With every one in the largest bucket it can fill (64 KiB for a Proposal or version, the largest record; 4 KiB for a ballot with a full note), the month comes to about 14.6 MiB, so 64 MiB is over four times the worst case. In typical buckets (16 KiB and 1 KiB) it's about 3.6 MiB. #73's invite mailbox holds a group's whole log for a day or two, and the same group's six weeks is about 20 MiB at worst. 64 MiB is also 1/16 of the relay's cap.
- **One index, no new column.** `blobs_by_mailbox_size (mailbox, expiry, length(blob))` lets SQLite sum a mailbox's unexpired bytes from the index without reading a blob. Through `(mailbox, seq)`, a PUT to a full mailbox of 1 KiB blobs read all 65,536 rows, about 90 ms each, so a header-only request could hold the one worker. With the index it's about 6 ms on Ubuntu 24.04's SQLite 3.45, well under a GET of 100 records of 64 KiB (about 50 ms).
- **Long-lived groups.** An invite carries the whole log, so a group that lives far past the pilot could outgrow 64 MiB: at the busy group's typical rate, after about a year and a half. Raise the setting then, or revisit the cap when #73's envelope needs it.

## Amendment (2026-11-10, #97)

- **Backups get their own table and route,** as ADR-0043 §3 and [ADR-0072](0072-protocol-details-for-decomposition.md) items 13 and 14 set out: `PUT` and `GET /v1/backup/{id}`, and `backups(id, blob, expiry)` beside `blobs` ([spec §6](../spec/phase-1/06-relay-api.md)).
- **What a row holds.** The 43-character id, which a device derives from its random backup key and nothing else, so it is linked to no mailbox, member or group; one padded blob of 64 KiB, 256 KiB, 1 MiB, 4 MiB or 16 MiB; and the UTC day it expires, 181 days after the day of its last write. There is no receipt time, and the table is `WITHOUT ROWID`, like the push tables, so no hidden counter orders backups by when each first arrived. A write replaces the row, and `secure_delete` zeroes the old blob's pages, so no earlier copy stays once the WAL is checkpointed. An index on `expiry` lets the daily purge find expired rows without reading a blob.
- **The same refusals as a blob PUT.** The id rule, `Content-Length` checked before a byte is read (at most 16 MiB here), the media type, the privacy middleware and the constant error bodies are #62's, and the relay's 1 GiB `storage_full` cap applies. The per-mailbox cap (#141) counts blobs only: a backup is one row per id, replaced in place. There is no DELETE in the MVP; a backup goes when it expires.
- **What the relay still learns.** That an opaque blob of one of five sizes is a backup, written at most once a day, and, live, the connecting IP address, which it doesn't keep. Uploads come from the same address as the device's group syncs, so whoever watches the relay live can tie the backup to those groups ([ADR-0075](0075-safeguards-for-the-revised-mvp.md) §2's accepted risk). Detecting a relay that serves an older backup, sharing one backup between linked devices, conditional writes and compression are deferred past the MVP.
