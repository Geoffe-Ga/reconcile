# Relay changes for the public shelf (spike #427)

This is the relay side of [amendment-0077.md](amendment-0077.md) §2, for the recommended `storage` answer (`write-keys`). The appendix gives the deltas if the founder picks `signed-shelf` or `plain-mailbox` instead.

**In one line:** the relay gains **public mailboxes**. Anyone can read one by its id, and only whoever holds the write key it is hashed from can add to it or delete from it. There's no new table, no new column, no signature check, no parsing and no per-IP state. Everything else in spec §6 stays as it is.

## Today (for reference)

`reconcile/relay/app.py` serves `PUT`/`GET /v1/mailbox/{id}`, `PUT`/`GET /v1/backup/{id}`, the four push routes and `/v1/health`. `store.py` keeps `blobs(mailbox, seq, blob, received, expiry)`, `push_subs`, `nudges`, `backups` and `meta`. A mailbox id is the only capability: whoever knows it can read **and** write. That's right for sealed group mailboxes, whose ids derive from a secret. It's wrong for a mailbox everyone must be able to read, because then everyone could also write to it.

## The id rule

```
id = base64url_unpadded(SHA-256(utf8("reconcile/v1/public-id") ‖ 0x00 ‖ utf8(key)))
```

- `key` is the 43-character write key exactly as it appears in the path: `^[A-Za-z0-9_-]{43}$`, the mailbox id rule. The relay hashes the ASCII characters and never decodes them, so there's no canonical-form check to get wrong. A non-canonical spelling just names a different, empty mailbox.
- `id` is 43 characters, so it fits every existing id check.
- Stored rows use `mailbox = "public:" + id` in the existing `blobs` table. No mailbox, push or backup route can name that value, because each one's id rule has no colon. That keeps public mailboxes out of reach of every existing write path, so the only way to write one is to hold its write key.
- A shared vector, `tests/vectors/public-id.json` (also read by `client/src/net/relay.test.ts`), pins three keys and their ids, computed with Python's `hashlib`.

## Routes

### `PUT /v1/public/{key}?ttl_days=N`

Stores one raw `application/octet-stream` blob in the public mailbox `id(key)` and returns `201 {"seq": n}`.

- **Checks**, in this order, each with the constant error bodies spec §6 already uses. Nothing is stored on a refusal.
  - `key`: the mailbox id rule, else `400 invalid_mailbox`.
  - `ttl_days`: 1–30 (default 30), else `400 invalid_ttl`.
  - Media type and `Content-Length`: exactly as a mailbox PUT. The body is 1,024, 4,096, 16,384 or 65,536 bytes, checked before a byte is read.
  - `storage_full` (1 GiB) first. Then `public_full`: `507 {"error": "public_full"}` when the mailbox's unexpired bytes plus this blob would pass `RECONCILE_RELAY_MAX_PUBLIC_BYTES` (default 524,288 = 512 KiB). This is checked on the declared length, and again just before the insert, as #141 does for mailboxes.
  - `wake` is refused (`400 invalid_wake`): the shelf is pull only (ADR-0077 §1).
- **Stores** one `blobs` row: `("public:" + id, seq, blob, received, expiry)`, with `received` = the relay minute after the body has arrived and `expiry` = UTC day + `ttl_days` + 1, exactly as `_Mailboxes.put` stamps them.
- **Doesn't store** the write key, or anything else from the request.
- **Retention:** `ttl_days`, at most 30, then the existing daily purge.

### `DELETE /v1/public/{key}/{seq}`

Deletes the row with that `seq` in `"public:" + id(key)`, if there is one, and always returns `204`.

- **Checks:** `key` by the mailbox id rule; `seq` 1–2⁶³−1 in at most 19 digits (the `after` rule), else `400 invalid_seq`. There's no body.
- **Effect:** `DELETE FROM blobs WHERE mailbox = ? AND seq = ?`. `secure_delete` (already on) zeroes the pages, and the WAL checkpoint drops the old frames.
- **Always 204,** whether a row existed or not, so the route answers no question about the mailbox to anyone. The writer already knows what it holds.
- **Retention:** none. This is how a takedown removes bytes rather than only hiding them.

### `GET /v1/public/{id}?after=S&limit=L`

Returns `{"records": [{"seq", "received", "data"}], "now", "instance"}` from `"public:" + id`, exactly as `GET /v1/mailbox/{id}` does: unexpired records, in ascending seq, with `now` read before the select.

- **Checks:** the mailbox id rule on `id`, plus the `after` and `limit` rules.
- An unknown id returns an empty list, never a 404.
- The client always starts at `after=0` and pages through the whole mailbox, so `after` never shows when a device last read.

### Unchanged

`PUT`/`GET /v1/mailbox/{id}`, backups, push and health. None of them reads or writes a `public:` row. Push can't register under a public id, because `/v1/push/{id}` takes a mailbox id, which can't carry the prefix.

## Settings

- `RECONCILE_RELAY_MAX_PUBLIC_BYTES`: a positive integer, default 524,288. It's read the way `RECONCILE_RELAY_MAX_MAILBOX_BYTES` is (`settings.py`).
- **Why 512 KiB.** A level's honest month is about 10 entries × up to 3 records each (first, a longer `above`, a new door) × 4 KiB, which is about 120 KiB. At the worst-case 16 KiB bucket, an 80 + 500 + 120 code-point record escaped to 6 bytes each, it's about 480 KiB. The roll's mailbox holds at most a few 64 KiB rolls, since the steward deletes the one each new roll replaces.
- The mailbox cap (#141) counts only non-public rows. The relay's 1 GiB cap counts everything.

## The shelf's mailboxes

| Mailbox | Write key held by | Read id known by | Holds | Kept |
|---|---|---|---|---|
| The roll | the steward's computer only (`scripts/shelf-steward`) | every app build (a constant) | the steward-signed roll; old copies deleted by the steward | 30 days per copy; re-posted at least every three weeks |
| One per listed level | every device of that level: its members, or its coalition's participants; a former member until the key changes | everyone, from the roll's `levels[].read` | that level's signed entry and retire records | each record until 30 days after its level's pass |

## Storage, written out

```sql
-- No schema change. One more value space in an existing column:
--   blobs.mailbox = 'public:' || <43-char id>
-- The existing indexes serve every query:
--   blobs_by_mailbox (mailbox, seq)                       -- GET and DELETE
--   blobs_by_mailbox_size (mailbox, expiry, length(blob)) -- public_full
--   blobs_by_expiry (expiry)                              -- purge
```

ADR-0028's "any new column needs an ADR" is met by the amendment, and no column is added. `store.py` gains `delete(mailbox, seq)`, and `_Mailboxes`' room check takes the cap for its namespace.

## Why the relay still can't enumerate membership, affiliation or votes

- **Nothing private moves.** Groups, coalitions, invites, doors, backups and push keep their sealed blobs, weekly ids and tables. A public mailbox is never derived from a private one: its write key comes from HKDF of the level's secret under its own label (amendment §1), and its id is a one-way hash of that key. So the relay can't tie a level's public mailbox to its weekly group mailboxes from what it stores.
- **What the relay holds that's readable** is exactly what the shelf shows: words a level voted to publish, that level's name, its open door's address, the shelf keys of the levels below and above it that also published, and the relay minute its shelf line passed. That's all public by the level's own vote. It holds no person's name or key, no ballot, no total, no member count and no roster.
- **The roll** is opaque keys, ids and name commitments, so even the relay's copy of it isn't a directory of groups. Names are readable only beside words a level chose to publish.
- **No per-IP state, no counters, no rate limits, no logs.** That's the privacy middleware, `--no-access-log`, and #141's founder decision, all unchanged.
- **Reads are uniform.** Every device reads the roll and then every listed mailbox, whole, from `after=0`, and devices outside any group do the same. So a GET says nothing about who reads or which groups they're in.
- **What it does learn, and keeps:** the minute each public record arrived and left. Both are public anyway: the record carries `passed`, and a takedown is visible to every reader.
- **What it learns live, and doesn't keep:** the address of a device that PUTs or DELETEs under a level's write key. The same address polls that device's weekly group mailboxes, so whoever watches the relay live can tie those mailboxes to the level's public name. That's the one new linkage. It's named in the amendment's accepted pilot risks, beside ADR-0075 §2's polling.

## Tests the relay change needs (for #431's relay half)

- **The id rule** matches the vector. A PUT to `key` is readable at `id(key)` and nowhere else. A mailbox GET at `id(key)` sees nothing, and a mailbox PUT at `id(key)` lands in a different row space that the public GET never returns.
- **No write without the key:** no route writes or deletes a `public:` row without its key. This is a property test over the mailbox, push and backup routes.
- **Sizes, TTL and media type** are refused exactly as for a mailbox PUT. `wake=1` is refused.
- **`public_full`** at the cap's edge, with uploads in flight together, mirroring #141's tests. The mailbox cap ignores public rows.
- **DELETE:** it removes exactly one row, answers 204 for a missing seq or a wrong key, and the stopped database's bytes no longer hold the deleted blob's canary after a checkpoint.
- **No logs or state:** nothing is written on a request beyond the row (#62's existing check, extended to the new routes). `scope["client"]` stays `None`.

---

## Appendix: if the founder picks another `storage` option

### `signed-shelf`: one shelf the relay checks

- `PUT /v1/shelf`: one record ≤ 16 KiB, framed as `kind (1) ‖ key (32) ‖ entry (32) ‖ sig (64) ‖ len (2) ‖ body`. The relay verifies Ed25519 with `cryptography`, which is already pinned. It refuses a key the current roll doesn't list, a retired or suspended key, and a roll not signed by `RECONCILE_RELAY_SHELF_STEWARD_KEY` or not newer than the stored one.
- **Storage:** new tables `shelf(entry, key, blob, received, expiry)` (one row per entry and key, replaced on PUT), `shelf_keys(key, retired)` and `shelf_roll(version, blob)`.
- **Limits:** at most 10 live rows per key (the 11th evicts the oldest), and a global row cap.
- `GET /v1/shelf?after&limit` returns the roll and every record in one response.
- **Cost:** the relay parses public records and holds the steward's public key, which ties the relay operator to the shelf's policy. It's also about three times the code on a security-critical service, and it needs its own ADR text for the tables. The privacy argument above holds unchanged.

### `plain-mailbox`: no relay change in the pilot

- Entries go to a well-known weekly mailbox, `HKDF("reconcile/v1/shelf-week", week)` from a constant in the app, and the roll to another. The existing PUT and GET are used as they are.
- **Cost:** anyone who reads the app's code can fill that week's mailbox with 64 MiB. That's refused for the group's own records (`mailbox_full`), and every reader's phone downloads it. Takedown can't remove bytes (there's no DELETE), only post a record that readers honour.
- It is an accepted pilot risk in the shape of #366/#435, with public mailboxes built on the same trigger: before outside groups publish, or the outside review.
