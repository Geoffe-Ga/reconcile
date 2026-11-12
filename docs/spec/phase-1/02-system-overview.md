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
- Only `src/net/` calls `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource` (#64). The service worker lives there too (`src/net/serviceWorker.ts`, #76).
- Only `src/crypto` imports `@noble/*`, and `src/crypto` imports no other third-party package (#69) except `shamir-secret-sharing`, which only `src/crypto/shares.ts` imports (ADR-0075 §4).
- Every visible string comes from one typed messages module, `client/src/app/messages.ts` ([ADR-0055](../../adr/0055-accessibility-and-languages.md) as cut by ADR-0073, #65).

### Constants

| Constant | Value | Source |
|---|---|---|
| Vote window | The whole days the proposer chose, or the default of the Proposal's class, from the relay's receipt of the Proposal: 7 days (10,080 relay minutes) for an ordinary change, 14 days (20,160) for an entrenched one. The author's `ts` plays no part | ADR-0073, ADR-0074 (#94, #106) |
| Window bounds | Ordinary votes 3–14 days (default 7), entrenched votes 14–28 (default 14), both bounds included | ADR-0074 (#106) |
| Early close | Once every eligible member's latest ballot scores every version | ADR-0073 |
| Quorum, per version | min(eligible, max(3, ⌈0.3 × eligible⌉)) scorers | ADR-0073 |
| Pass (consent floor) | An average of at least 2.0, with fewer than 10% of the version's scorers giving a 0: the ordinary bar | [ADR-0002](../../adr/0002-consent-floor-vote-rule.md) |
| Entrenched bar | An average of at least 3.0, with fewer than 5% of the version's scorers giving a 0 | [ADR-0015](../../adr/0015-anti-capture.md) §2 (#94) |
| Versions per ballot | At most 3 | [ADR-0047](../../adr/0047-ballot-cap-quorum-reproposals.md), ADR-0073 |
| Text caps | Title 120, justification 2,000 and note 280 Unicode code points, counted after NFC | [ADR-0072](../../adr/0072-protocol-details-for-decomposition.md) item 4 |
| Blob sizes | Exactly 1, 4, 16 or 64 KiB (1,024, 4,096, 16,384 or 65,536 bytes) | [ADR-0019](../../adr/0019-sealed-sender-relay.md), ADR-0073 |
| Largest record | 64,000 bytes, so any record fits in one invite chunk | #71 |
| Blob retention | 30 days | [ADR-0057](../../adr/0057-environments-updates-retention.md) |
| Invite envelope | Kept about 2 days: `ttl_days=1`, which the relay's day rounding turns into 24–48 hours | ADR-0073 (#73) |
| Mailbox ids | 43 base64url characters (32 bytes, unpadded) | ADR-0019, ADR-0073 (#62, #71) |
| Relay time | Whole minutes since the Unix epoch (`received`, `now`) | ADR-0073 (#62) |

---
