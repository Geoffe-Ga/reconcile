# SPEC: The Reconcile MVP

- **Status:** The build contract for the MVP, rewritten for [ADR-0073](../adr/0073-mvp-scope.md), [ADR-0074](../adr/0074-mvp-scope-revised.md) and [ADR-0075](../adr/0075-safeguards-for-the-revised-mvp.md)
- **Date:** 2026-11-09
- **Inputs:** `docs/plan/` (product), ADRs 0001–0075 (`docs/adr/`), and the issues under epics #57–#60 (the foundation) and #82–#88 (the restored features)
- **Earlier version:** the full Phase 1 design of 2026-11-07, at commit `f4b9e2b`. An ADR that cites "spec §N" means that version's numbering.

This spec says **what the MVP builds and how**. It links to ADRs for *why* and doesn't repeat them. When this spec and an ADR disagree, the ADR wins (ADR-0075, then ADR-0074, then ADR-0073). An issue that adds or changes a contract updates this spec in the same PR.

---

## 1. Goal

Two pilot groups of 5–15 people each use Reconcile for six weeks ([ADR-0056](../adr/0056-pilot-plan.md)). One is an everyday group, such as family or friends. The other is an organizing or community group whose content isn't sensitive. Each group governs its living Documents from its own devices, with no central database:

> **Invite → Join → Read → Propose → Discuss (linked chat) → Vote → Update**

The pilot succeeds when (ADR-0056):

- each group completes the loop at least 3 times;
- at least 70% of members vote at least once;
- nobody loses their keys.

The build succeeds when:

1. **The loop runs on real devices.** Three browser profiles run it in CI through the real relay, one of them offline while it votes (#67). An installed iPhone and a second device run it against the deployed VM (#68). Before the pilot starts, at least 5 testers complete it on at least 3 devices, including an installed iPhone and desktop Chrome (ADR-0056).
2. **The relay learns nothing readable.** An e2e test scans everything the relay stored and logged after a full loop, and finds no group words, names or keys, and no client IP address (#71).
3. **Every device builds the same Document.** The same relay-ordered records fold to the same state on every device (property tests, #63).
4. **The gates pass** (§10).

The MVP has two layers:

- **The foundation** (epics #57–#60) is ADR-0073's simple loop: one level, one Document, and fixed 7-day votes. §3–§9 describe it in full.
- **The restored features** (epics #82–#88) bring back what ADR-0074 lifts, Phase 2 coalitions included, with ADR-0075's safeguards. §11 names the issues that build each one.

Protective features are real but quiet. Nothing in the UI suggests the app is for illegal activity (ADR-0018, [DESIGN.md](../../DESIGN.md)).

---

## 2. System overview

```
┌──────────── A member's device (installed PWA, TypeScript) ──────────┐
│  UI (React Aria) ──▶ engine: fold, tally, can()                     │
│                         ▲                                           │
│  store (IndexedDB): per-group keys and secret, the relay-ordered    │
│  log, the outbox, the sync cursor, private drafts                   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ sealed, padded blobs (1, 4, 16 or 64 KiB)
                         ┌─────────▼─────────┐
                         │  Relay (Python)   │  mailboxes only: each blob
                         │  FastAPI, SQLite  │  with its seq and receipt minute
                         └───────────────────┘
```

| Part | Language | What it is | ADRs |
|---|---|---|---|
| `client/` | TypeScript | The PWA: UI, engine (`src/engine`), crypto (`src/crypto`), store (`src/store`) and network (`src/net`) | 0005, 0022, 0029, 0073 |
| `reconcile/` | Python | The relay only: blind mailboxes on FastAPI and SQLite | 0007, 0019, 0028 |
| `deploy/` | Caddy, systemd, bash | One VM that serves the app and the relay from one origin, deployed by a script the founder runs (#68) | 0041, 0073 |

**One engine.** The TypeScript engine is the only implementation of the governance rules. Golden JSON vectors in `client/src/engine/vectors/`, and the fast-check properties beside them, pin its behavior (ADR-0073). Python runs the relay and nothing else.

**Boundaries,** enforced by `client/plans/architecture/.dependency-cruiser.cjs` and ESLint:

- `src/engine`, `src/crypto` and `src/store` import no React or UI code, and `src/engine` imports nothing from `src/net` (#63).
- Only `src/net/` calls `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource` (#64).
- Only `src/crypto` imports `@noble/*`, and `src/crypto` imports no other third-party package (#69) except `shamir-secret-sharing`, which only `src/crypto/shares.ts` imports (ADR-0075 §4).
- Every visible string comes from one typed messages module, `client/src/app/messages.ts` ([ADR-0055](../adr/0055-accessibility-and-languages.md) as cut by ADR-0073, #65).

### Constants

| Constant | Value | Source |
|---|---|---|
| Vote window | 7 days (10,080 relay minutes) from the relay's receipt of the Proposal. The author's `ts` plays no part | ADR-0073 |
| Window bounds | Ordinary votes 3–14 days (default 7), entrenched votes 14–28 (default 14). The proposer's choice arrives in #106 | ADR-0074 |
| Early close | Once every eligible member's latest ballot scores every version | ADR-0073 |
| Quorum, per version | min(eligible, max(3, ⌈0.3 × eligible⌉)) scorers | ADR-0073 |
| Pass (consent floor) | An average of at least 2.0, with fewer than 10% of the version's scorers giving a 0 | [ADR-0002](../adr/0002-consent-floor-vote-rule.md) |
| Versions per ballot | At most 3 | [ADR-0047](../adr/0047-ballot-cap-quorum-reproposals.md), ADR-0073 |
| Text caps | Title 120, justification 2,000 and note 280 Unicode code points, counted after NFC | [ADR-0072](../adr/0072-protocol-details-for-decomposition.md) item 4 |
| Blob sizes | Exactly 1, 4, 16 or 64 KiB (1,024, 4,096, 16,384 or 65,536 bytes) | [ADR-0019](../adr/0019-sealed-sender-relay.md), ADR-0073 |
| Largest record | 64,000 bytes, so any record fits in one invite chunk | #71 |
| Blob retention | 30 days | [ADR-0057](../adr/0057-environments-updates-retention.md) |
| Invite envelope | Kept about 2 days: `ttl_days=1`, which the relay's day rounding turns into 24–48 hours | ADR-0073 (#73) |
| Mailbox ids | 43 base64url characters (32 bytes, unpadded) | ADR-0019, ADR-0073 (#62, #71) |
| Relay time | Whole minutes since the Unix epoch (`received`, `now`) | ADR-0073 (#62) |

---

## 3. Identity and keys

[ADR-0009](../adr/0009-per-group-identities.md), as ADR-0073 cut it: every membership has its own random keys, with no root identity behind them.

- **Signing keys** (#69). Create group and Join each make a fresh Ed25519 keypair, stored with that group's records only. An event's `author` is the public key in unpadded base64url (43 characters). The secret key stays in the store: the actions read it there to sign, and no screen is handed it. Store version 2 brought these keys in and deleted the stub era's unsigned data on upgrade, with no migration.
- **Records** (#69). A record is `publicKey (32 bytes) ‖ signature (64) ‖ event bytes`. The signature covers UTF-8 `reconcile/v1/event` ‖ `0x00` ‖ event bytes. `sign(ctx, secretKey, msg)` and `verify(ctx, publicKey, sig, msg)` in `src/crypto/sign.ts` take the tag as a typed parameter, and an invite token signs under its own tag, `reconcile/v1/invite-token` (#73). Verification calls `ed25519.verify(sig, msg, pub, { zip215: false })`, never the library default, which accepts non-canonical encodings and small-order keys. The outbox and the log hold records, and a record's verdict is kept per page load by the SHA-256 of its bytes, so a re-fold doesn't verify it again.
- **Group secret** (#71). Genesis makes 32 random bytes that only members hold. The group's other values derive from it with HKDF-SHA-256, an empty salt and 32 bytes of output:
  - the mailbox id, in unpadded base64url, with info `reconcile/v1/mailbox`;
  - the seal key, with info `reconcile/v1/seal-key`.
- **Seal** (#64, #71). XChaCha20-Poly1305 under the seal key, with the mailbox id as associated data. A blob is a 24-byte nonce, then the ciphertext of (a 4-byte big-endian length ‖ the payload ‖ zeros), then a 16-byte tag, in the smallest of the four sizes that fits. A payload is at most 65,492 bytes. A blob that fails to open is skipped.
- **Invite seed** (#73). Copy invite link makes a random 32-byte seed, and the invite mailbox and key derive from it (infos `reconcile/v1/invite-mailbox` and `reconcile/v1/invite-key`). The link is `${origin}/#join/${seed}`, so the seed never reaches a server. Until then, the tracer's link (#65, marked `STUB(invite)`) carries the group's mailbox id and stub secret instead: `${origin}/#/join/${mailbox}.${secret}`, each 43 base64url characters.
- **Names** (#69; [ADR-0045](../adr/0045-names-in-groups.md) as cut by ADR-0073). A name is fixed at join. When two members' names match after NFC, trimming and lowercasing, each shows ` · ` and the first 4 hex characters of the SHA-256 of its public key. Names render inside `<bdi>`.
- **Backup file** (#78; [ADR-0043](../adr/0043-recovery-and-backup.md) and [ADR-0044](../adr/0044-qr-device-linking.md) as cut by ADR-0073). One passphrase-sealed file holds every group's keys, secret and log, and nothing is uploaded.
  - The key is scrypt (N = 2^17, r = 8, p = 1, 32 bytes) over the NFC passphrase and a random 16-byte salt.
  - The seal is XChaCha20-Poly1305, with the header (`RCB1`, the scrypt parameters, the salt and the nonce) as associated data.
  - Restoring it brings the groups back, or sets up a second device that votes as the same person.
- **Library rule.** Audited libraries only: `@noble/curves`, `@noble/hashes` and `@noble/ciphers`, plus `shamir-secret-sharing` for recovery shares (ADR-0075 §4). **No hand-rolled cryptography.** Randomness comes only from `randomBytes` or `crypto.getRandomValues`.

Restored (§11): passkey unlock (#95), a second device by scanning a code (#96), the relay backup (#97), recovery contacts (#109, #118), and per-member encryption keys with a new group key on leave or removal (#98).

---

## 4. Events

ADR-0006, as ADR-0073 cut it: signed UTF-8 JSON, applied in the relay's order.

### Envelope

```json
{"v": 1, "type": "proposal", "group": "<group id>", "author": "<public key>", "ts": 1762650000000, "body": {}}
```

- The author serializes the event once with `JSON.stringify` to UTF-8. Those exact bytes are signed, sent and hashed, and nobody re-encodes them.
- The event id is the unpadded base64url SHA-256 of those bytes.
- `ts` is the author's clock in milliseconds, for display only.
- Genesis carries `group: ""`, because it can't contain its own hash. The group id is the id of the mailbox's first valid genesis, and every other event carries it.
- Text is NFC-normalized before signing. Atom text also goes through `normalizeAtomText` (#70): lone surrogates become U+FFFD, CRLF and CR become LF, trailing spaces and tabs leave each line, and the text ends in exactly one LF. Blank text becomes `""`. The fold never re-normalizes received text, because browsers ship different Unicode tables.

### The fold

`fold(records, relayNow)` turns a mailbox's records, in relay order, into one `GroupState`: the group id (`group`, its genesis id, or null before one), the group's name and chat link, the Document title, members, Atoms, Proposals with their versions and ballots, outcomes, and `ignored` (#63, #69). For each record, the fold:

1. verifies the signature before it parses the event, and requires `author` to equal the record's key. A record that fails lands in `ignored` with `id: null` and claims no event id, so a forged copy of a real event never shadows it;
2. drops a repeated event id, so the first copy keeps its seq and receipt time;
3. ignores an event whose `v` isn't 1 or whose `group` isn't the genesis id (unknown versions are ignored, ADR-0073);
4. ignores an event from a non-member, except that person's own `join`: `can()` is false for anyone who isn't a member;
5. checks the event's rules against the state before it. An event that breaks a rule lands in `ignored` and changes nothing.

### Foundation event types

| Type | Body | Valid when | Built by |
|---|---|---|---|
| `genesis` | `{name, chat?, founder, title, atoms}`: the group name, an optional chat link, the founder's name, the Document title and its Atoms | it is the first valid event in the mailbox | #63 |
| `join` | `{name, token?}`: the joiner's name, and the inviter's token | the author isn't a member yet | #63 (the token: #73) |
| `proposal` | `{atom, title, why, text, link?}`: the target Atom (an add carries `target` instead, #75), the title, the justification, the proposed text and an optional discussion link | the author holds `propose`, the Atom exists and has no open Proposal (#72), the title is 1–120 code points, and the justification is at most 2,000 | #63 |
| `version` | `{proposal, text}` | the author holds `propose`, and the Proposal is open with fewer than 3 versions | #72 |
| `vote` | `{proposal, scores, note?}`: a score from 0 to 4 for each version it names (at least one), and one note | the author is eligible and holds `vote`, every score names a version already on the Proposal, the note is at most 280 code points and isn't blank when any score is 0, and the relay received the ballot before the deadline and before any early close | #63 |
| `leave` | `{}` | the author is a member | #77 |

The founder becomes a member at genesis. Genesis Atoms get the ids `${genesisId}.${i}`, and every Atom keeps a document id, the genesis id, which #92 builds on.

### Proposals and ballots

- **Versions** ([ADR-0004](../adr/0004-competing-versions-go-to-ballot.md), #72). A Proposal's own text is version 1, and its id is the Proposal's id. A `version` event's id is its own event id. Versions keep relay order. An Atom has at most one open Proposal, so new wording joins it as a version.
- **Targets** (#75). An edit names an `atom`. An add carries `target: {kind: "add", after: <atom id> | null}` instead, and the new Atom's id is the Proposal's id. An edit whose version text is `""` removes the Atom, and the fold then ignores later Proposals on it.
- **Eligibility** ([ADR-0015](../adr/0015-anti-capture.md), #77). The eligible voters are the members at the Proposal's place in relay order: people who joined before it and hadn't left. A later join or leave never changes an open Proposal's eligible set, quorum or early close.
- **Deadline.** The Proposal's `received` plus 10,080 minutes.
- **Ballots.** A voter's latest valid ballot replaces their earlier one in full. A ballot that names a version not yet on the Proposal is ignored, and so is a ballot received after the deadline or the close. An ignored ballot never replaces the voter's earlier one.
- **Close.** A Proposal closes early at the first ballot after which every eligible member's latest ballot scores every version; `closedAt` is that ballot's `received`. Otherwise it closes once `relayNow` reaches the deadline. A new version restarts the wait for an early close.
- **Apply.** Only a closed Proposal's outcome is final. A final pass sets the target Atom's text, or adds or removes the Atom. Final passes apply in order of close time (`closedAt`, or else the deadline), with ties broken by the Proposal's relay order, so every device builds the same Document.
- **Leave** (#77). After `leave`, `can()` refuses the author everything, so the fold ignores their later events. Ballots received before the leave still count, and the leaver's Proposals and versions stay on the ballot.

### Capabilities

`can(state, member, capability)` is the only permission check, and it's false for non-members (#63). The foundation has one level, which holds `read`, `propose`, `vote`, `invite` and `see-roster` (ADR-0073). Code never compares level names. #90 brings back three levels behind the same helper.

---

## 5. Tally

`tally({eligible, versions: [{id, scores}]})` returns `pass` with the winning version, `fail` or `lapse` (#63). It uses integers only: no floats, division or rounding. For each version, `n` is its number of scorers, `sum` their total, and `zeros` the number of 0s.

1. **Quorum** (ADR-0073). A version is at quorum when `n ≥ 1`, `n ≥ min(eligible, 3)` and `10·n ≥ 3·eligible`. That equals min(eligible, max(3, ⌈0.3 × eligible⌉)) scorers. Each version needs its own quorum.
2. **Pass** (ADR-0002). A version at quorum passes when `sum ≥ 2·n` and `10·zeros < n`.
3. **Winner** (ADR-0004). Among passing versions, the higher average wins (compare `sumA·nB` with `sumB·nA`), then fewer zeros, then the earlier version.
4. **Outcome.** If no version is at quorum, the vote lapses. If some are at quorum and none passes, it fails.

The vectors in `client/src/engine/vectors/` pin the edges:

- an average of exactly 2.0 passes, and exactly 10% zeros fails;
- a 2-member group passes with 2 of 2 ballots;
- at 11 eligible, 3 scorers lapse and 4 meet quorum; at 15 eligible, 4 lapse and 5 meet it;
- a three-way tie goes to the earliest version;
- a late version that only 2 of 10 eligible members score can't win, because it never reaches quorum (#72).

A lapse reads "Not enough people weighed in. This isn't a no." ([ADR-0069](../adr/0069-lapses-celebration-relational-pilot.md)), and Propose again starts a fresh Proposal with a fresh window (#74). The engine exposes each version's scorers, sum, zeros and quorum, and its pass flags, so the consent meter reads them live and `src/app` holds no threshold numbers (#74).

Restored (§11): the entrenched bar (#94), removal's own bar (#115), and priority votes (#107).

---

## 6. Relay API

#62 builds it: FastAPI on Uvicorn, with SQLite in WAL mode ([ADR-0028](../adr/0028-relay-fastapi-sqlite.md)), behind Caddy on one VM ([ADR-0041](../adr/0041-digitalocean-relay-hosting.md), #68). The relay stores opaque blobs by mailbox id and returns them in order with their receipt minute. The unguessable mailbox id is the only capability: there are no accounts or tokens (ADR-0073).

| Method | Path | What it does |
|---|---|---|
| `PUT` | `/v1/mailbox/{id}?ttl_days=N` | Stores one raw `application/octet-stream` blob and returns `201 {"seq": n}` |
| `GET` | `/v1/mailbox/{id}?after=S&limit=L` | Returns `{"records": [{"seq", "received", "data"}], "now", "instance"}` |
| `GET` | `/v1/health` | Returns `{"status": "ok"}` |

- **PUT.** The id matches `^[A-Za-z0-9_-]{43}$`, the body is exactly 1,024, 4,096, 16,384 or 65,536 bytes, and `ttl_days` is 1–30. `Content-Length` is required and at most 65,536, and the relay checks it before reading. Anything else gets a 4xx and stores nothing. Once the database and its WAL pass `RECONCILE_RELAY_MAX_DB_BYTES` (default 1 GiB), a PUT gets `507 {"error": "storage_full"}`.
- **GET.** `after` is at least 0 (default 0), and `limit` is 1–100 (default 100). Records come in ascending seq order, after `after`, unexpired, with `data` in standard base64. An unknown mailbox returns an empty list, never a 404. The relay reads `now` before it selects, so every record a response leaves out has `received` ≥ `now`.
- **Order and time.** `received` and `now` are relay minutes, ⌊Unix seconds / 60⌋. `seq` only grows, even after a purge empties a mailbox. `instance` is 16 random bytes made with the database, so a client can tell when it meets a fresh relay. The relay is trusted for this order and time (ADR-0073), and for nothing else.
- **Storage.** One table, `blobs(mailbox, seq, blob, received, expiry)`, plus a `meta` row for `instance`. `expiry` is the UTC day of receipt plus `ttl_days` plus 1, and a row expires once today reaches it. A GET skips expired rows, and a daily purge deletes them. Any new column needs an ADR.
- **Never.** Errors are a constant `{"error": "<code>"}` that never echoes input. There are no docs routes, no debug route, no CORS (the app and relay share one origin) and no request logs. The outermost ASGI middleware sets `scope["client"]` to `None` and deletes forwarding headers before routing. Uvicorn runs one worker with `--no-access-log --no-proxy-headers --no-server-header`.

Restored routes: Web Push under `/v1/push/` (#89), and the relay backup at `/v1/backup/{id}` (#97). Each issue adds its rows to this table.

---

## 7. Sync

#64, #71 and #73 build it.

- **Mailboxes.** Each group has one mailbox, derived from its group secret (§3), and each invite gets a short-lived one (ADR-0073). Group events are posted with `ttl_days=30`, so the relay keeps them 30 days (ADR-0057).
- **Polling.** While the app is visible, sync runs every 3 seconds, and at once on focus or when the browser comes back online. After a failure it doubles its wait, up to 30 seconds; coming back online resets the wait (#168). There's no WebSocket.
- **Each pass:**
  1. posts the outbox in order, removing an entry only after a 2xx, so an event made offline survives a reload and goes out exactly once;
  2. GETs after the cursor, paging until a page holds fewer than `limit` records, opens each blob, skips one that won't open, and appends each record that verifies and whose event id isn't in the log yet;
  3. saves the cursor, `relayNow`, `instance` and the time of the last successful sync.
- **A new `instance`** resets the cursor to 0 and re-posts the outbox. Dedupe by event id keeps any event from folding twice.
- **Folded state uses relay records only.** An event in the outbox shows as pending and never in folded state (#66). While it waits, its screen reads "Sending…" if the last sync reached the relay, and "Saved on this device. It will send when you're back online." once a sync has failed; then "Sent" once it leaves the outbox.
- **Joining with full history** (#73). An invite envelope is a header blob followed by chunk blobs, each sealed under the invite key and posted with `ttl_days=1`.
  - The header is JSON `{groupSecret, preview: {groupName, inviterName, documentTitle, excerpt}, token, chunkCount}`. The excerpt is the first Atom as plain text, cut to 280 code points.
  - Chunks carry the relay-accepted log in seq order, as `seq (8 bytes) ‖ received (8) ‖ length (4) ‖ record`. `received` travels with each record, because deadlines depend on it.
  - A newcomer imports the entries through the same verify, dedupe and fold path, so they see the whole history even after the relay has purged it. A device already in the group merges in the entries it lacks.
- **Catching up** (#73). When a sync succeeds more than 28 days after the previous one, the device sets a flag, and Group home says "Some history may be missing on this device. Open a new invite link from your group to catch up." Only a merge clears it.
- **Requests.** `src/net/relay.ts` calls `/v1` on the same origin with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'` and `cache: 'no-store'`. The service worker never caches `/v1` (#76).
- **Install first** ([ADR-0029](../adr/0029-install-first-indexeddb.md), #76). On iOS, nothing creates keys until the app runs from the Home Screen. Then the app calls `navigator.storage.persist()`, and says so when the browser may still clear its data.
- **Updates** install in the background and apply on the next launch, with no prompt (ADR-0057 as cut by ADR-0073, #76).

---

## 8. Screens

Built with React Aria Components and styled only from [DESIGN.md](../../DESIGN.md) tokens ([ADR-0022](../adr/0022-react-vite-react-aria.md)). Every string comes from the messages module. Screens meet WCAG 2.2 AA, and axe runs on each one in unit tests and in the Chromium and WebKit e2e runs (ADR-0055, #65, #67). Routes are hash routes, with no router library (#65): `#/` Start, `#/create`, `#/join/{payload}` (Join, which replaces the entry with `#/join` once it reads the payload), `#/g/{groupId}` Group home, `#/g/{groupId}/doc` Document view, `#/g/{groupId}/propose/{atomId}` the composer, and `#/g/{groupId}/p/{proposalId}` a Proposal and its ballot (#66). Sending a Proposal replaces the composer's entry with the Proposal's. A group is stored and routed under its group id, so every device uses the same one. Tab titles never carry a group's words, because browser history keeps them.

1. **First run** (#76). An iOS browser outside the installed app shows an install guide, plus an invite link's preview with a Copy button. Everywhere, the pilot notice comes before any key exists. It covers what's stored, what the relay sees (a device's IP address while it connects, without logging it; when messages arrive; their size class; which mailboxes a device checks), that data can be lost, and that this is a test (ADR-0056).
2. **Start** (#65, #76, #77, #78). The groups on this device, Create group, a field to paste an invite link, and Restore a backup.
3. **Create group** (#65, #71). Group name, your name, an optional chat link, a Document title and the Document text, which splits into Atoms at blank lines. A chat link must be `http:` or `https:`. A founding Document over 64,000 bytes is refused before anything is queued.
4. **Join** (#73). "From <inviter>'s invite", then the preview as plain text, a name field with the hint "This name is only shown in this group. It doesn't have to be your real name.", and the line "People in this group will see the name you choose and how you vote." An expired or damaged link says "This invite link has expired or is damaged. Ask someone in your group for a new one." and fetches nothing.
5. **Group home** (#65, #66, #74, #77, #78). In order:
   - **Needs your vote:** open Proposals you're eligible for and haven't fully scored, closing soonest first;
   - the other open Proposals, by closing date;
   - the Document;
   - **Decided:** closed Proposals, newest first, each opening its result;
   - **People.**

   It also holds Copy invite link with its warning (§9), Join discussion (the latest Proposal's link, or else the group's), "Can't reach the relay right now. Last synced {time}." while polling fails, the catch-up line, and a quiet card that suggests a backup.
6. **Document view** (#65, #70, #75). Each Atom renders through `<AtomText>` in the document style, with Propose a change (or Add your version), Propose removing this section, Add a section here between Atoms, and Copy as Markdown.
7. **Composer** (#66, #70, #72, #74). A title (at most 120), a why (at most 2,000), the new text in Write and Preview tabs, and a discussion link prefilled with the latest one. Limits count code points with `nfcLength`. The draft stays private on this device, saved as the person types, until they propose or discard it. On a lapsed Proposal, Propose again opens a fresh composer with the same target, title, why, link and version texts.
8. **Proposal and ballot** (#66, #72, #74, #77).
   - The title and why, then each version as a word diff against the current text, with its own five score pills, "0 · Strongly opposed" through "4 · Strongly supportive".
   - One note per ballot. It's required when any score is 0, and labelled "What would make this a 3 for you?" when the person gives a 1 and no 0.
   - A countdown with the absolute deadline in a `<time>` element, Join discussion (the Proposal's own link, or else the group's latest), and a consent meter for each version.
   - Screens count down on the device's estimate of relay time: the last relay `now` plus the device time since that sync, or the device clock before any sync, so a device clock set to the wrong date can't move a deadline. Once that estimate reaches the deadline the ballot is disabled; the outcome shows only once the fold says the Proposal has closed (#66).
   - Someone who joined after the Proposal opened reads "You joined after this opened, so you can't vote on it." and sees no pills.
   - After sending a Proposal or a version, Tell your group shares fixed text with no title (§9).
9. **Result** (#74). The outcome sentence comes first.
   - A pass shows the new text full width and thanks its authors by name, with no counts, streaks or confetti.
   - Then each version's totals, individual ballots and notes under a disclosure, and "Voting ran <start> – <end>" in relay time.
   - A lapse offers Propose again. A ballot that arrived late tells its author it wasn't counted.
   - No result offers a part-ways action ([ADR-0068](../adr/0068-part-ways.md)).
10. **People** (#65, #73, #77). Every member's name, "invited by <name>", and Leave this group. The Leave dialog says plainly that the group's keys don't change, until #98 replaces that sentence.
11. **Settings** (#78). Save a backup (the passphrase twice, with "Nobody can recover this passphrase for you."), Restore, and Erase Reconcile from this device behind a 3-second press and hold.

The restored features add their own screens (§11).

---

## 9. Privacy rules

Every issue, foundation or restored, keeps these. The threat model is [`12_Security_Privacy_Threat_Model.md`](../plan/12_Security_Privacy_Threat_Model.md).

- **No accounts and no IP logs.** The relay drops client addresses and forwarding headers before any route runs. Caddy discards its logs, and the VM keeps its journal in memory only (#62, #68). Whoever runs the relay can still see connecting IP addresses and timing live, and the pilot notice says so.
- **Padded, sealed blobs.** Everything a device sends the relay is a sealed blob of one of the four sizes, under a mailbox id derived from a secret only members hold. The author and the signature sit inside the seal (ADR-0019).
- **The relay is trusted only for order and time** (ADR-0073). It can't read, forge or link anything it stores.
- **Secrets stay after `#`.** Invite seeds and group secrets travel only in the URL fragment, and the app removes them from the address bar once read (#65, #73, #76). Beside Copy invite link: "Anyone who opens this link in the next 2 days can read everything this group has written and voted on, and what comes next. Send it directly to the people you're inviting."
- **Open ballots, inside the group only** ([ADR-0010](../adr/0010-open-ballots-with-exit.md)). Everyone in the group sees each other's names and ballots, and nobody outside it sees either. Every level can read ballots and vouches until the hidden roster returns (ADR-0075 §5).
- **Shares carry no content.** Tell your group sends fixed text, a deadline and the app's address. It never carries a title, Document text, a group name or a link fragment (#77).
- **Nothing third-party.** There are no analytics, telemetry, third-party scripts or third-party fonts. The app calls only the relay, plus the browser's push service once a person turns push on (#99), and a Discord webhook for a group that turned its bot on by Proposal (#119).
- **Script defense.** The CSP `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (#68) and the Markdown sanitizer (#70) are the main defense against injected script stealing keys.
- **Local data.** Leave deletes every record of the group from the device once the relay has the leave (#77). Erase deletes all of Reconcile's data on the device and makes no network call (#78).
- **ADR-0074's restored protections:** a new group key whenever someone leaves or is removed, with per-member encryption keys (#98); mailboxes that rotate weekly (#110); and ballots and notes that expire 30 days after a decision, leaving a signed result (#111). Until those merge, the foundation runs with ADR-0073's accepted risks: keys don't rotate, ballots don't expire, and there are no recovery contacts. The invite warning and the Leave dialog say so.
- **Accepted pilot risks,** which the outside review covers ([ADR-0058](../adr/0058-security-review-on-demand.md), #132):
  - the relay is trusted for order and time (ADR-0073);
  - coalition keys don't rotate, and push shows the relay some metadata (ADR-0074);
  - anyone holding a coalition seat secret can block a motion or act in the coalition, push and polling show the relay which groups share a phone, and colluding recovery contacts can skip the wait (ADR-0075).

---

## 10. Quality gates

The gates are [ADR-0061](../adr/0061-quality-gates.md)'s, and [CLAUDE.md](../../CLAUDE.md) lists them. Security-critical code merges on green under them (ADR-0075 §6).

| Area | Gate |
|---|---|
| Python relay | `./scripts/check-all.sh`: at least 90% line and 85% branch coverage, 95% docstring coverage, mypy strict, complexity at most 10, and bandit and pip-audit clean |
| TypeScript client | `client/scripts/check-all.sh`: ESLint 9 (strict, a11y, complexity at most 10), Prettier, `tsc -b`, Vitest with at least 90% lines and 85% branches, dependency-cruiser boundaries, and `npm audit` |
| Engine contract | Every golden vector in `client/src/engine/vectors/` passes. fast-check shows that the outcome doesn't depend on ballot order, that folding the same records twice gives equal state, and that a pass changes only its target Atom (#63) |
| End to end | Playwright (Chromium and WebKit), with axe on every screen, runs the loop through the real relay whenever `client/` or `reconcile/` changes (`./scripts/check-all.sh --e2e`, #67) |
| Privacy | The relay-learns-nothing e2e (#71) and the no-IP tests (#62, #68) |
| Deploy | `deploy/check.sh` validates the Caddyfile and the systemd units in CI (#68) |
| Every PR | TDD, `./scripts/precommit-changed.sh`, green CI and the review bot's verdict |
| Before a release | Mutation testing, aiming for 80%. Recommended, not a merge gate |
| Before groups outside the founder's circle | The outside security review (ADR-0058, #132) |

---

## 11. Restored features

ADR-0074 brings these back at the depth it sets, and ADR-0075 adds safeguards to several of them. Each row names the issues that build the feature. Each of those issues adds its contract to this spec in the same PR: its own subsection here, or rows and rules in §3–§9.

| Feature (ADR-0074 level) | What the MVP adds | Built by |
|---|---|---|
| Onboarding and joining (4) | The founding Document readable before joining, and a first-run guide; 2 vouches and a 14-day wait before voting, with a bootstrap until 3 people hold voting rights | #91, #101 |
| Sign-in, devices and recovery (4) | Passkey unlock; a second device by scanning a code, with no device list; an encrypted relay backup; recovery contacts (3 of 5 by default) with a fixed 72-hour wait | #95, #96, #97, #109, #118 |
| Personal page (2) | A personal mission statement on your device, and a read-only share link | #93, #105 |
| Groups and involvement levels (4) | Many groups on one device; Member, Collaborator and Co-Creator levels, self-chosen and checked only through `can()`; stewards with a 7-day suspension; removal by vote | #77, #90, #102, #115 |
| Documents and Atoms (5) | Several Documents per group; section history and a change log; reordering and heading-only sections; entrenched and eternal sections; founding rules with ordinary and entrenched bars; dissolution with read-only archives | #92, #104, #103, #116, #94, #108 |
| Proposals (2) | Nothing beyond the foundation: private drafts with Preview, word diffs, and up to 3 versions on one ballot | #70, #72 |
| Discussion bridge (4) | Ready-made messages for each moment; a Discord bot that posts content-free nudges; a Discord thread per Proposal with a join button; the bot turned on and off by Proposal | #113, #119, #123, #117 |
| Voting (3) | A window the proposer sets within the class's bounds; priority votes over 2–7 options | #106, #107 |
| Notifications and followers (3) | Opt-in, content-free Web Push, "closing soon" included; Members as followers; Dispatches sent by a Co-Creator or carried by a passed Proposal | #89, #99, #112 |
| Coalitions (4) | Reconciling two or more groups by a vote in each; a coalition mission statement decided group by group; front doors; coalition followers; an encrypted coalition room; nesting up to 3 levels; Dispatches that rise by vote | #100, #114, #120, #121, #124, #125, #122, #126, #127 |
| Privacy and safety (3) | Per-member encryption keys and a new group key on leave or removal; weekly mailboxes; ballots and notes that expire 30 days after a decision | #98, #110, #111 |

### Rules the restored features share

These come from ADR-0074's "Rules this needs":

- **Windows** (#94, #106). Ordinary votes run 3–14 days (default 7) and entrenched votes 14–28 (default 14). The deadline is fixed in relay time when the Proposal opens, and early close still applies.
- **Bars** (ADR-0015, #94). Entrenched sections, dissolution and widening an opt-in pass at an average of at least 3.0 with under 5% zeros. Removal has its own bar (below).
- **Rules are fixed at genesis** with ADR-0067's Fellowship defaults (#94). The one exception is the opt-ins that [ADR-0040](../adr/0040-group-opt-ins-are-governed.md) governs, the chat bot and the front door: a rules Proposal widens them at the entrenched bar and narrows them at the ordinary bar (#117).
- **Coalitions form by private, group-to-group invitation,** with no public index, and nest up to 3 levels (#100, #122).
- **One more network destination:** a Discord webhook, only for a group that turned its bot on by Proposal. The URL lives only in the encrypted group state (#119).
- **Recovery uses a random backup key,** and contacts hold Shamir shares of it (#97, #109).

### ADR-0075's safeguards

- **Stewards and removal** (§3; #90, #101, #102, #106, #115):
  - A suspension never shrinks the electorate. Eligibility ignores suspensions (#90's `wouldVote`), and a suspended member can vote once the suspension ends, if the vote is still open.
  - A steward holds at most one active suspension, and a steward facing an open recall can't suspend or narrow. The 30-day guard between suspensions of one person runs from the end of the last one.
  - A removal passes when `sum ≥ 3·n` and either `zeros ≤ 1` or `20·zeros < n`, so a single 0 never blocks it. Removal votes run a fixed 14 days, so a suspension that a removal vote extends lasts at most 21 days.
  - "Voting members" means the people who hold voting rights, whatever level they chose, counted by #101's `votingRightsCount`. The bootstrap and the steward thresholds both use it.
  - **Steward seats** (#102): 1 seat under 6 voting members and 2 from 6, with staggered 6-month terms ([ADR-0049](../adr/0049-stewards-and-removal.md)). That's the Fellowship default. A Circle keeps 1 seat until it reaches 10 voting members (ADR-0067, ADR-0072 item 8), but Circles stay deferred (§12), so every MVP group gets the Fellowship seats.
- **Opt-ins** (§3, §5; #117, #121). A steward's narrowing is valid only beside the same steward's open off-Proposal, and lasts until that Proposal closes. `isWider` compares only what outsiders can see or reach, so replacing a webhook or rotating a front door's keys is an ordinary change.
- **Push** (§2; #89, #99, #110). Push is off by default, with one switch per group. The switch's disclosure says that whoever runs the relay can see that one phone is in each group where push is on. This is an accepted risk, and #130 revisits it.
- **Recovery** (§4; #78, #96, #97, #109, #118).
  - The random backup key travels in the backup file and in the second-device link bundle, so a restored or linked device keeps the relay backup fresh.
  - The 72-hour wait runs on each contact's device, in relay time from the relay's receipt of that contact's alert.
  - The picker says "Pick people you'd trust with all your groups at once.", and that a contact picked in two groups can tell both names are the same person.
  - Colluding contacts can skip the wait. This is an accepted risk, and #131 revisits it.
- **Coalitions** (§1, §5; #100, #124, #126).
  - A promoted Dispatch counts as passed in its origin group only when that group's own fold holds the passed Proposal with the same id, title, text and ceiling.
  - A coalition speaks only through passed motions.
  - Following a coalition posts nothing, so followers can't see each other.
  - Anyone holding a seat secret can block a motion or act in the coalition. This is an accepted risk, and #129 revisits it.
- **Dissolved archives** (§5; #108). No relay time arrives after a dissolve, so each device clears the archive's ballots and notes 30 days after it, by its own clock. This is the one place device time decides anything.

---

## 12. Deferred

Each item here waits for pilot feedback, and returns only through a new ADR that lifts it (ADR-0073). These are the items ADR-0074 still lists as deferred:

- **The roster hidden from Members** ([ADR-0017](../adr/0017-need-to-see-and-expiry.md), [ADR-0072](../adr/0072-protocol-details-for-decomposition.md) item 12). Until it returns, every level can read the roster, ballots and vouches (ADR-0075 §5).
- **Invite caps, revocation and QR invites** ([ADR-0053](../adr/0053-multi-use-invites.md), [ADR-0014](../adr/0014-invite-and-vouch-admission.md)). A link admits anyone while its envelope lives on the relay.
- **The older-device notice** ([ADR-0042](../adr/0042-broad-device-support.md)).
- **App lock, the padded vault, panic wipe and duress** ([ADR-0018](../adr/0018-device-protection-and-duress.md), [ADR-0046](../adr/0046-padded-vault-and-panic-wipe.md)). The phone's own lock and Erase Reconcile from this device stand in. Duress will need a storage migration.
- **Derived identities and link-reveal** ([ADR-0009](../adr/0009-per-group-identities.md)). Independent random keys per group stand in.
- **Genesis templates, and rules changes beyond the opt-ins** ([ADR-0067](../adr/0067-genesis-templates.md), [ADR-0051](../adr/0051-dissolution-and-rule-classes.md)): the Circle and Chapter templates, the Circle-to-Fellowship switch, rule provenance, and tuning any other rule by vote. When it returns, the switch is the one rule change that skips the `rules-change` Proposal loop, and that's deliberate: every device derives it from the log when a Circle reaches 10 voting members, and it leaves alone every rule a Proposal set ([ADR-0051](../adr/0051-dissolution-and-rule-classes.md)'s 2026-11-09 amendment).
- **Readmission and parting ways** ([ADR-0066](../adr/0066-readmission.md), [ADR-0050](../adr/0050-splitting.md), [ADR-0068](../adr/0068-part-ways.md)): the `readmit` target and the `part-ways-petition` event. Copy as Markdown into a fresh group stands in.
- **Re-proposal cooldowns and caps** ([ADR-0047](../adr/0047-ballot-cap-quorum-reproposals.md), [ADR-0069](../adr/0069-lapses-celebration-relational-pilot.md)): the 14-day cooldown after a failure, the 3-in-180-days cap, the per-person open cap, and re-opens with twice the window. One open Proposal per Atom stands in.
- **Stand-aside and per-version notes** ([ADR-0065](../adr/0065-stand-aside-and-ballot-notes.md)). One note per ballot stands in.
- **The daily digest and scheduled Dispatches** ([ADR-0054](../adr/0054-digest-notifications.md), [ADR-0012](../adr/0012-content-free-push.md)). Needs your vote and opt-in push stand in.
- **The Quiet and Rising tabs** ([ADR-0064](../adr/0064-feed-tabs-quiet-and-rising.md), [ADR-0048](../adr/0048-feed-surfacing.md)). One list stands in.
- **Shared CRDT drafts, CodeMirror and line diffs** ([ADR-0006](../adr/0006-signed-log-plus-crdt.md), [ADR-0031](../adr/0031-yjs-working-copies.md), [ADR-0023](../adr/0023-markdown-atoms.md)): Yjs Working Copies with shareable URLs. Private drafts and word diffs stand in.
- **The binary encoding** ([ADR-0006](../adr/0006-signed-log-plus-crdt.md), [ADR-0072](../adr/0072-protocol-details-for-decomposition.md) items 1–2): CBOR, BLAKE3, `prev` links, Lamport order, the author-time floor, and `tally` and `checkpoint` events. Signed JSON in relay order stands in.
- **The Python reference implementation** ([ADR-0007](../adr/0007-thin-python-relay.md), [ADR-0060](../adr/0060-how-phase-1-is-built.md), ADR-0075 §6): a Python validator and tally sharing test vectors with the client. The TypeScript engine and its golden vectors stand in.
- **Unique names** ([ADR-0045](../adr/0045-names-in-groups.md)): renames, "formerly X" and lookalike detection. Key suffixes stand in.
- **Per-member mailboxes and delivery jitter** ([ADR-0019](../adr/0019-sealed-sender-relay.md)). One mailbox per group, rotating weekly after #110, stands in.
- **Staging and production, and WebSockets** ([ADR-0057](../adr/0057-environments-updates-retention.md), [ADR-0028](../adr/0028-relay-fastapi-sqlite.md)): CI deploys, the update prompt and the staging smoke run. One VM and polling stand in.

ADR-0074's clarifications and ADR-0073's table also leave these out:

- ADR-0030's non-extractable device key and mandatory recovery, and [ADR-0052](../adr/0052-newcomer-onboarding.md)'s recovery before voting.
- Expiring the text of removal Proposals and suspension reasons (ADR-0072 item 5), and lowering a promotion ceiling once voting opens ([ADR-0037](../adr/0037-holonic-promotion.md)).
- Reconcile-the-group, the covenant ([ADR-0013](../adr/0013-covenant-on-reach.md)) and Reconcile-wide broadcast, so nothing waits on the eternal core's wording ([ADR-0035](../adr/0035-reconcile-group-minimal-eternal-core.md)).
- An ICU message library (ADR-0055), the rejected-events view, and a choice of relay.
- Proposals that span several Atoms, editing a Document's title, and export formats other than Markdown (#75).
- The gift prompt and money ([ADR-0025](../adr/0025-gift-economy.md), [ADR-0063](../adr/0063-money-rules.md)), which belong to Phase 3.
