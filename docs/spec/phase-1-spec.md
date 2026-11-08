# SPEC: Reconcile Phase 1, the Single-Organization MVP

- **Status:** Draft for decomposition
- **Date:** 2026-11-07
- **Inputs:** `docs/plan/` (product), ADRs 0001–0051 (`docs/adr/`)
- **Feeds:** `spec-decomposition` → issue drafts in `docs/plan/git-issues/` (local only, gitignored)

This spec says **what to build first and how**. It links to ADRs for *why* and doesn't repeat them. When this spec and an ADR disagree, the ADR wins; fix the spec.

---

## 1. Goal

One Organization of 3 to about 150 people can run the core loop on their own devices, with no central database:

> **Invite → Join → View → Proposal → Discuss (linked chat) → Vote → Update**

All of it must hold up against the threat model: the relay learns nothing readable, a member who leaks data exposes only what their level could see, and a seized phone is protected.

### Audience and tone

Reconcile is friendly to anarchists, "the OS for anarcho-syndicalism" ([ADR-0018](../adr/0018-device-protection-and-duress.md)), and also to any group that wants to govern itself democratically. Protective features are real but quiet. Nothing in the UI suggests the app is for illegal activity.

### Success criteria

1. **A full loop on real devices.** A pilot group from the user's own circle (decided 2026-11-07 on the `2026-11-07-reconcile-product-stack` sheet), at least 5 testers on at least 3 devices (including iOS Safari as an installed PWA, and desktop Chrome) creates an Organization, invites members, proposals an Atom change, votes, and sees the canonical Document update on every device, including one that was offline during the vote.
2. **The relay learns nothing.** An automated test captures everything the relay stores and logs during a full loop and asserts that it contains no plaintext, no long-lived identity keys, and no sender identities.
3. **Tallies are deterministic.** The same set of governance events gives the same canonical Document on every device, whatever order they arrive in (property tests).
4. **Repo quality gates pass.** Python: ≥90% coverage, ≥80% mutation score, complexity ≤10. TypeScript: the equivalents in §8.

### Non-goals for Phase 1

These are listed so no one builds them early:

- Coalitions, reconciling two groups, and dual voting (Phase 2)
- Any discovery beyond an invite link (Phase 2)
- Reconcile-the-group, the covenant's reach enforcement, holonic promotion (Phase 2+)
- The Reconcile-hosted coalition room ([ADR-0011](../adr/0011-debate-venues.md), Phase 2)
- Platform integrations such as Discord or WhatsApp bots ([ADR-0011](../adr/0011-debate-venues.md), [ADR-0039](../adr/0039-integrations-per-group-opt-in.md); Phase 3)
- Scheduled or recurring Dispatches and the Member experience (Phase 3)
- The split petition flow ([ADR-0015](../adr/0015-anti-capture.md)). The log reserves the event type, but there's no UI
- Tiered visibility ([ADR-0017](../adr/0017-need-to-see-and-expiry.md), after the MVP)
- Duress login ([ADR-0018](../adr/0018-device-protection-and-duress.md)). App lock and panic wipe are in scope. Duress waits until hidden storage passes review
- Anonymous or secret ballots ([ADR-0010](../adr/0010-open-ballots-with-exit.md))

---

## 2. System Overview

```
┌──────────── Member device (PWA, TypeScript) ────────────┐
│ UI ── Group engine ── Governance log (signed, hashed)    │
│          │                └─ validator + tally            │
│          ├─ Working copies (CRDT)                         │
│          ├─ Keyring (root key, per-group keys, app lock)  │
│          └─ Encrypted local store (IndexedDB)             │
└───────────────┬──────────────────────────────────────────┘
                │ sealed, padded, encrypted blobs
        ┌───────▼────────┐        ┌──────────────────────┐
        │ Relay (Python) │──wake──▶ Web Push (no content) │
        │ mailboxes only │        └──────────────────────┘
        └────────────────┘
```

| Component | Language | ADRs |
|---|---|---|
| `client/` PWA: UI (React + React Aria), group engine, keyring, store | TypeScript | 0005, 0006, 0008, 0009, 0017, 0018, 0022, 0023 |
| `protocol/`: event schemas, canonical encoding, test vectors | JSON Schema + vectors, shared | 0006, 0019 |
| `reconcile/` relay and protocol reference implementation | Python | 0007, 0019 |

**Repo layout (assumption).** The repo stays a single repository. The existing Python package `reconcile/` becomes the relay and the reference validator. `client/` is added with its own toolchain. `protocol/` holds the test vectors that **both** implementations must pass, which is how they stay in step.

---

## 3. Identity and Keys

Per [ADR-0008](../adr/0008-passkeys-and-social-recovery.md) and [ADR-0009](../adr/0009-per-group-identities.md):

- **Root identity:** an Ed25519 signing keypair and an X25519 key-agreement keypair, generated on the device. They never leave it unencrypted.
- **Unlock:** a passkey through WebAuthn, using the PRF extension to derive the key that encrypts local storage. Without PRF (or on iOS below 18.4): a non-extractable device key, plus social recovery set up before joining any group; an Argon2id passphrase is opt-in only ([ADR-0030](../adr/0030-device-key-fallback.md)).
- **Per-group identity:** for each group, a fresh keypair derived deterministically from the root key and a random per-group salt stored locally. Display names are pseudonyms and differ per group by default ([ADR-0017](../adr/0017-need-to-see-and-expiry.md)).
- **Linking:** an explicit `link-reveal` act, scoped to one group, recorded only on the member's device. Phase 1 only needs the data model and a stub UI, since links matter once there are several groups.
- **Social recovery:**
  - The member chooses N recovery contacts and a threshold T, from 2 of 3 up to 5 of 7 (default 3 of 5), and the root key is split with Shamir secret sharing ([ADR-0043](../adr/0043-recovery-and-backup.md)).
  - Shares are encrypted to each contact's per-recovery key and travel through the relay.
  - Recovery requires T approvals **and** a fixed 72-hour delay, during which every linked device is notified and can cancel.
  - An encrypted backup of groups, drafts, and personal Documents lives on the relay under an unlinkable mailbox id, padded and updated on a schedule; only the recovered root key decrypts it.
- **Devices:** a second device links by a short-lived QR code with a confirmation number; Settings lists and revokes devices ([ADR-0044](../adr/0044-qr-device-linking.md)).
- **Names:** freely chosen per group, unique within it; a `rename` shows "formerly X" until ballot expiry ([ADR-0045](../adr/0045-names-in-groups.md)).
- **Local store:** a fixed-size padded vault from Phase 1; the duress PIN waits for an external review. Panic wipe: press and hold in Settings, plus an opt-in wipe after wrong app-lock codes ([ADR-0046](../adr/0046-padded-vault-and-panic-wipe.md)).
- **Library rule:** use audited libraries only: `@noble/curves`, `@noble/hashes`, `@noble/ciphers` and a reviewed Shamir implementation on the client; PyNaCl on the relay. **No hand-rolled cryptography.**

---

## 4. Governance Log

Per [ADR-0006](../adr/0006-signed-log-plus-crdt.md).

### Event envelope

```json
{
  "v": 1,
  "group": "<group id: hash of the genesis event>",
  "type": "<event type>",
  "author": "<per-group public key>",
  "prev": ["<hash>", "..."],
  "lamport": 42,
  "ts": "<author's clock, advisory only>",
  "body": { },
  "sig": "<Ed25519 signature over the canonical encoding>"
}
```

- **Canonical encoding:** deterministic CBOR (RFC 8949 §4.2). The event id is the BLAKE3 hash of that encoding.
- `prev` makes the log a hash-linked DAG, so concurrent events are allowed. The total order is (`lamport`, event id).
- **Validation is total and deterministic.** Every device runs the same validator. An event is valid only if every rule below holds against the state produced by the events that precede it in the total order. Invalid events are kept but ignored, and they're shown in a "rejected" view for auditing.

### Phase 1 event types

| Type | Body | Who may author it (capability, [ADR-0003](../adr/0003-three-tier-involvement-levels.md)) |
|---|---|---|
| `genesis` | group name, founding rules (defaults below), founder key | the founder |
| `invite` | invite id, the invitee's one-time key hash, expiry | `invite` (voting levels: Collaborator and Co-Creator; Members can't invite) |
| `join` | invite id, new member key, display name | the holder of the invite |
| `vouch` | the vouched-for member's key | `vouch` (voting members) |
| `level-change` | member, new level | the member themselves. Moving to Collaborator or Co-Creator requires voting rights from admission ([ADR-0014](../adr/0014-invite-and-vouch-admission.md), [ADR-0021](../adr/0021-level-names-and-self-selection.md)) |
| `proposal` | `target` (`{kind: atom \| new-atom \| removal \| steward \| rules, …}`), title, justification, version hashes, window, Atom class | `propose` (Co-Creator) |
| `version` | proposal id, content hash of a competing version ([ADR-0004](../adr/0004-competing-versions-go-to-ballot.md)) | `propose` |
| `vote` | proposal id, `{version hash: score 0–4}`, `{version hash: reason}` (required for every 0) | `vote`, plus being eligible at the snapshot |
| `tally` | proposal id, winning version hash or `none`, totals, ballot commitment | anyone; validators recompute it, and only a correct tally is valid |
| `suspend` / `unsuspend` | member, reason, expiry ≤ 7 days | `steward` |
| `remove` | member, the passed proposal id | follows a passed removal Proposal |
| `leave` | — | the member |
| `rename` | new display name, unique in the group ([ADR-0045](../adr/0045-names-in-groups.md)) | the member |
| `removal-response` | removal proposal id, response text (one per removal) | the member being removed ([ADR-0049](../adr/0049-stewards-and-removal.md)) |
| `dissolve` | the passed proposal id, `wipe` flag | follows a passed dissolution Proposal at the entrenched bar ([ADR-0051](../adr/0051-dissolution-and-rule-classes.md)) |
| `steward-elect` | member | follows a passed Proposal |
| `key-rotate` | new group key epoch, wrapped keys per member | any Co-Creator, required after `remove` |
| `rules-change` | changed rule fields | follows a passed Proposal at the bar for that rule's class |
| `checkpoint` | totals and ballot commitments for expired proposals, plus the hash of the log prefix it summarizes | any voting member's device, produced when ballots expire ([ADR-0017](../adr/0017-need-to-see-and-expiry.md)) |
| `split-petition` | **reserved**, rejected in Phase 1 ([ADR-0050](../adr/0050-splitting.md)) | — |

### Default founding rules

All of these can be changed through `rules-change`.

| Rule | Default | Source |
|---|---|---|
| Vouches required to vote | 2 | [ADR-0014](../adr/0014-invite-and-vouch-admission.md) |
| Wait before voting | 14 days from `join` | ADR-0014 |
| Pass rule (ordinary Atom) | average ≥ 2.0 and fewer than 10% zeros | [ADR-0002](../adr/0002-consent-floor-vote-rule.md) |
| Pass rule (entrenched Atom) | average ≥ 3.0, under 5% zeros, window × 2 | [ADR-0015](../adr/0015-anti-capture.md) |
| Eternal Atom | can't be the target of a valid `proposal` | ADR-0015 |
| Eligibility | voting members as of the `proposal` event's position in the order | ADR-0015 |
| Default vote window | 7 days (14 for entrenched) | confirmed 2026-11-07 |
| Quorum | at least 3 ballots and 30% of eligible voters | confirmed 2026-11-07 |
| Reason for a 0 | required: a `vote` scoring any version 0 must carry a non-empty reason for that version | confirmed 2026-11-07 |
| Ballot visibility | open until the tally plus 30 days, then devices keep only totals and the commitment | [ADR-0017](../adr/0017-need-to-see-and-expiry.md) |
| Suspension maximum | 7 days | [ADR-0016](../adr/0016-suspend-then-vote.md) |
| Versions per ballot | at most 3 (fixed) | [ADR-0047](../adr/0047-ballot-cap-quorum-reproposals.md) |
| Missed quorum | the vote lapses with outcome `none` | ADR-0047 |
| Re-proposing the same content | 14-day cooldown after a lapse or failure; at most 3 times in 180 days | ADR-0047 |
| Stewards | 2 seats, staggered 6-month terms (1 seat under 6 voting members); founder holds a seat until the election that opens at 3 voting members; recall by ordinary Proposal | [ADR-0049](../adr/0049-stewards-and-removal.md) |
| Removal | entrenched bar; the target isn't eligible but may post one `removal-response` | ADR-0049 |
| Split petition (Phase 2) | 20% of voting members within 14 days of a trigger; signatures sealed until met | [ADR-0050](../adr/0050-splitting.md) |
| Dissolution | entrenched bar; read-only archives by default, optional wipe | [ADR-0051](../adr/0051-dissolution-and-rule-classes.md) |
| Ballot expiry range | 7–90 days (default 30) | ADR-0051 |
| Rule classes | entrenched: pass rules, quorum, eligibility, removal, stewards and suspension, dissolution, entrenchment; ordinary: everything else | ADR-0051 |

**Bootstrap rule (confirmed 2026-11-07).** A group with fewer than 3 voting members can't satisfy vouching or quorum. Until it reaches 3, the founder's invitees count as vouched and voting immediately. The `genesis` event records this, and it switches off automatically and permanently.

### Tally

The tally is a pure function with signature `tally(proposal, eligible_voters, votes) → outcome`:

1. Take each eligible voter's most recent valid `vote` made before the window closed.
2. For each version, compute the average and the share of zeros, and test them against the Atom class's pass rule. If quorum isn't met, the outcome is `none` and the vote lapses (ADR-0047).
3. If no version passes, the outcome is `none`. If one passes, it wins. If several pass, apply the **tie rule:** highest average, then the lowest share of zeros, then the earliest `version` event (confirmed 2026-11-07).
4. The ballot commitment is a Merkle root over the sorted `(voter, scores)` pairs.

Only a valid `tally` with a winner changes the canonical Document. The tally must be implemented in **both** Python (reference) and TypeScript, and must agree on every vector in `protocol/vectors/tally/`.

---

## 5. Documents, Atoms, and Working Copies

- **Document:** an ordered list of Atom ids plus metadata, all held in governance state. Its canonical content at any moment is each Atom's winning version hash, resolved through a content-addressed blob store.
- **Atom:** has an id, a class (`ordinary`, `entrenched`, or `eternal`), and a canonical version hash. Adding an Atom is a Proposal whose target is a new Atom id.
- **Atom content:** normalized CommonMark-subset Markdown ([ADR-0023](../adr/0023-markdown-atoms.md)), edited in CodeMirror 6 with a toolbar and live preview, rendered through a sanitizing renderer with raw HTML disabled.
- **Working copy:** a plain-text Yjs document behind an engine interface, frozen to the hash of its normalized text ([ADR-0031](../adr/0031-yjs-working-copies.md)) that a Co-Creator checks out from a canonical version. It autosaves locally and syncs encrypted.
  - **"Shareable URL"** means a capability link that only group members can open, never a public URL. The link carries a working-copy id; the key comes from the group keyring.
  - **"Returning" a working copy** freezes its content into a version hash and attaches it to a Proposal, creating one with a `proposal` event or adding to one with a `version` event.
- **Conflicts:** if the canonical version moved since checkout, or another open Proposal targets the same Atom, the versions go side by side on one ballot ([ADR-0004](../adr/0004-competing-versions-go-to-ballot.md)).

---

## 6. Sync and the Relay

Per [ADR-0007](../adr/0007-thin-python-relay.md) and [ADR-0019](../adr/0019-sealed-sender-relay.md).

### Group encryption (assumption for Phase 1)

- A symmetric group key per epoch (XChaCha20-Poly1305).
- Each epoch key is wrapped to every member's per-group X25519 key inside `key-rotate`.
- Rotation happens on `remove` and on `leave`.
- MLS (RFC 9420) is the planned replacement once groups grow past about 150 members. Flag it for external review before any public launch.

### Mailboxes

- Every member has rotating inbox mailbox ids derived from a group secret and the epoch.
- Members post events and CRDT updates as blobs addressed to the group's mailboxes.
- The relay never sees which member owns which mailbox.

### Relay HTTP API (Python)

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/v1/mailbox/{id}` | Store one padded, sealed blob (size buckets of 1, 4, 16, and 64 KiB) |
| `GET` | `/v1/mailbox/{id}?after={cursor}` | Fetch blobs. The request is authorized by a mailbox capability token, not an account |
| `POST` | `/v1/push/{id}` | Register a Web Push subscription for a mailbox |
| `GET` | `/v1/health` | Liveness check |

**Rules:**

- No accounts and no request logging. IP addresses are dropped before any application code sees them, and a test verifies this.
- Blobs are kept for 30 days by default.
- Wake-up pushes are batched with 0–60 seconds of random jitter.
- **Framework:** FastAPI on Uvicorn with access logs off, blobs in SQLite (WAL) with an expiry index ([ADR-0028](../adr/0028-relay-fastapi-sqlite.md)). Hosted on a DigitalOcean VM where we terminate TLS ([ADR-0041](../adr/0041-digitalocean-relay-hosting.md)).

### Sealed sender

The envelope on the wire contains only the mailbox id and the ciphertext. The author's identity sits inside the encryption.

### Offline and replication

- Every device keeps the full log and the canonical Documents for its groups.
- On iOS the app must be installed to the Home Screen before it creates keys. Keys, logs, and Working Copies live in IndexedDB. After installing, the client calls `navigator.storage.persist()` and shows the result ([ADR-0029](../adr/0029-install-first-indexeddb.md)).
- Supported: iOS/iPadOS 16.4+ (installed), Android 10+ with current Chrome, current desktop browsers, with a plain, non-blocking notice on devices below iOS 18.4 or Android 13 ([ADR-0042](../adr/0042-broad-device-support.md)).

---

## 7. Client (PWA)

### Screens for Phase 1

Built with React Aria Components and styled only from [`DESIGN.md`](../../DESIGN.md) tokens ([ADR-0022](../adr/0022-react-vite-react-aria.md)). The ballot, consent meter, and Atom badges follow DESIGN.md's component notes. The gift prompt is Phase 3 ([ADR-0025](../adr/0025-gift-economy.md), [ADR-0027](../adr/0027-supporters-and-coalition-tip-share.md)).

These follow `docs/plan/09` with the ADR changes applied:

1. **Welcome and identity:** create the identity with a passkey, then choose recovery contacts. Skipping is allowed, with a reminder banner that keeps returning.
2. **Personal page:** a pseudonymous display name and an optional personal mission statement. It's local only and shared per group by choice.
3. **Create Organization:** name, founding rules (defaults shown, advanced settings collapsed), and the first Document.
4. **Invite:** generate an invite link or QR code. The UI suggests a video call or meeting as a "vibe check" before vouching ([ADR-0014](../adr/0014-invite-and-vouch-admission.md)).
5. **Group home:**
   - Documents, open Proposals, and members. followers (Members) don't see the roster ([ADR-0017](../adr/0017-need-to-see-and-expiry.md)).
   - A linked-chat field, which can hold any URL ([ADR-0011](../adr/0011-debate-venues.md)).
6. **Document view:** Atoms with class badges (entrenched or eternal) and history.
7. **Working copy editor:** CRDT editing, with "Return as Proposal" and "Add as competing version" actions.
8. **Proposal and ballot:**
   - Title, justification, and the versions side by side.
   - A 0–4 score per version, with labels from `docs/plan/07`.
   - A countdown and the linked-chat button.
   - **No split action anywhere** ([ADR-0015](../adr/0015-anti-capture.md)).
9. **Result:** the outcome, the totals, and individual ballots while the 30-day window lasts.
10. **People:** vouch, change your level, and leave. Stewards also get suspend.
11. **Settings:**
    - Security: app lock and its timeout, and panic wipe, explained calmly. Duress login is absent in Phase 1.
    - Push opt-in, relay choice, and the recovery phrase.

### Notifications

There are no scheduled Dispatches in Phase 1. Pushes carry no content and only wake the app. Once the app has decrypted the events locally, it shows a local notification for:

- a new Proposal
- a vote closing within 24 hours
- a completed vote
- a new member

### App lock and panic wipe

These follow [ADR-0018](../adr/0018-device-protection-and-duress.md).

- The local store is encrypted with the unlock-derived key, so locking the app discards the key from memory.
- Panic wipe deletes IndexedDB, caches, and the push subscription. Data comes back afterwards from the root-key restore plus the group logs held by other members.

---

## 8. Quality Gates

| Area | Gate |
|---|---|
| Python relay and reference code | The existing `./scripts/check-all.sh`: ≥90% coverage, ≥80% mutation score (mutmut), mypy strict, complexity ≤10, bandit and pip-audit clean |
| TypeScript client | **In place:** `client/scripts/check-all.sh` runs ESLint 9 (strict, a11y, complexity ≤ 10), Prettier, `tsc -b`, Vitest with ≥90% lines and ≥85% branches, dependency-cruiser boundaries, and `npm audit`. Stryker (≥80%) runs on main. **To add:** Playwright with axe for the end-to-end loop |
| Protocol | Both implementations pass every vector in `protocol/vectors/`, checked in CI |
| Property tests | Hypothesis (Python) and fast-check (TypeScript) cover tally order independence, validator determinism, and the effect of eligibility snapshots |
| Privacy | The "relay learns nothing" test (§1) and the "logs contain no IP addresses" test run in CI |
| Security review | External review of §3 (keys and recovery) and §6 (group encryption and sealed sender) before any group outside the test cohort uses it |

---

## 9. Spikes

All three spikes were answered by desk research on 2026-11-07 and decided on the `2026-11-08-reconcile-stack-details` sheet: the merging library ([ADR-0031](../adr/0031-yjs-working-copies.md)), passkey PRF coverage ([ADR-0030](../adr/0030-device-key-fallback.md)), and storage persistence ([ADR-0029](../adr/0029-install-first-indexeddb.md)). What's left is measurement, not choice: check the Yjs bundle size in our build and verify behavior on the ADR-0042 device matrix.

---

## 10. Open Questions

**Confirmed 2026-11-07:**
- quorum: at least 3 ballots and 30% of eligible voters
- tie rule: highest average, then fewest zeros, then earliest
- vote window: 7 days, or 14 for entrenched Atoms
- the bootstrap rule
- a required reason for every 0 score
- the license: source-available ([ADR-0024](../adr/0024-source-available-license.md))
- moving between levels: self-selected after admission, with at most 3 open Proposals per person ([ADR-0021](../adr/0021-level-names-and-self-selection.md))

Also confirmed: `invite` belongs to the voting levels, every `proposal` carries a `target` kind, and expired ballots compact into a signed `checkpoint`.

**Nothing open blocks Phase 1.**

Decided for later phases (ADRs 0032–0040): code hosting, legal staging, payment rail, Reconcile-the-group's founding, group-by-group coalition votes (no coalition-wide individual ballots), holonic promotion, optional front-door discovery, per-group integrations, and group opt-ins decided by Proposal.

Still open, **not needed for Phase 1**: which fiscal sponsor (ADR-0033), the exact eternal-core wording (ADR-0035), group payee options (ADR-0027), split petition thresholds in practice, and the duress storage design.

## 11. Suggested Epics (Input for `spec-decomposition`)

They are listed in tracer-code order. The first item in each epic is its skeleton.

1. **Protocol and reference engine (Python):** event schemas, canonical encoding, validator, tally, and test vectors.
2. **Relay (Python):** a mailbox API with stubs, then storage, sealed sender, padding, wake-ups, and the no-logs tests.
3. **Client skeleton (TypeScript PWA):** all 11 screens wired to mock state, with the PWA shell installable offline.
4. **Client engine:** the TypeScript validator and tally passing the shared vectors, the governance log, and the encrypted store.
5. **Identity and safety:** root keys, passkey unlock, per-group keys, recovery, app lock, and panic wipe.
6. **The end-to-end loop:** sync through the relay, working copies, ballots, and tallies updating the canonical Document across devices, plus notifications.

The first demoable milestone is a skeleton that runs **one Proposal through to an Update between two browser profiles**, with stub crypto and the real relay. After that, each epic replaces stubs with the real implementation.
