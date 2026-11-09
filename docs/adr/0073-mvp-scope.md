# ADR-0073: MVP Scope: Build the Simple Loop First

- **Status:** Accepted; amended by [ADR-0074](0074-mvp-scope-revised.md), which restores part of what this defers and adds Phase 2 coalitions
- **Date:** 2026-11-08
- **Decided via:** the founder's direction of 2026-11-08: "I want to have a simple app come out the other end. No feature bloat. No confusing crowded UX. No esoteric bureaucracy. No overcooking. MVP status, with the 20% of the paths covered that enable 80% of the behavior…" and "simplify, chop and retain fidelity to the original vision without covering edgecases that are nearly unreachable."
- **Defers:** parts of ADRs 0002, 0003, 0006–0010, 0012, 0014–0019, 0021, 0023, 0028, 0030, 0031, 0042–0049, 0051–0055, 0057, 0059, 0060, 0064–0069 and 0072, plus spec §1–§8. Nothing is superseded.

## Context

Phase 1 as specified (ADRs 0001–0072, [phase-1-spec.md](../spec/phase-1-spec.md)) is a complete design for a group of up to about 150 people, including its governance edge cases. Building all of it before anyone uses the app would take months and would guess at what groups need. The founder asked for the smallest app that real pilot groups (3–30 people) can use, so their feedback can decide what comes back.

## Decision

The MVP is one small group governing one living Document from their own devices: invite by link, join, propose a change to one section, discuss in the group's own chat, score 0–4, and see the text change only when the consent floor holds.

**Kept unchanged:**
- local-first data with a blind relay, no accounts and no IP logs (ADR-0001, 0007, 0019)
- end-to-end encryption, and a separate identity and name per group (ADR-0009)
- invite links as the only way in, with no directory
- the consent floor (ADR-0002)
- competing versions on one ballot, up to 3 (ADR-0004, 0047)
- the eligibility snapshot (ADR-0015)
- a required reason for a 0
- open ballots inside the group (ADR-0010)
- linked chat (ADR-0011)
- the Markdown subset and sanitizer (ADR-0023)
- DESIGN.md's calm tone
- the quality gates (ADR-0061)

Each rule below is **deferred until pilot feedback asks for it**. The MVP does the simpler thing instead:

| ADRs | Deferred | The MVP does instead |
|---|---|---|
| 0003, 0021, 0017 (roster), 0072 §12 | Three involvement levels; followers can't see the roster | One level: everyone admitted reads, proposes, votes and invites. Every check still goes through one `can(state, member, capability)` helper, so levels can return without touching callers |
| 0014, 0052, 0053, 0003 (mass joins), spec §4 bootstrap | Vouches, the 14-day wait, recovery before voting, invite caps, revocation, signed expiry, QR codes, mass-join alerts | Anyone who joins through a live link votes on Proposals opened after they joined. A link lasts about 2 days (the relay drops it) |
| 0008, 0030, 0043, 0044, 0042 (notice), 0072 §13 | Passkeys, social recovery, the relay backup endpoint, QR device linking, the older-device notice | Keys live on the device. A passphrase-encrypted backup file restores groups or sets up a second device. Without one, ask for a new invite |
| 0009 (derivation, link-reveal) | A root identity with derived per-group keys; link-reveal | Independent random keys per group |
| 0018, 0046 | App lock, the padded vault, panic wipe | The phone's own lock, and one press-and-hold "Erase Reconcile from this device". Duress later needs a storage migration |
| 0015 (entrenched, eternal), 0051, 0067, spec §4 rules | Atom classes, rule classes, rules-change, dissolution, Circle and Fellowship templates | One fixed rule set: one consent floor, 7-day votes that close early once everyone has scored |
| 0010 (remove, split), 0016, 0049, 0059, 0066, 0068, 0072 §7 §11, spec key-rotate | Stewards, suspension, removal, readmission, key rotation, the reserved part-ways event | Anyone can Leave. A group that needs someone out, or wants to part ways, copies its Document into a fresh group |
| 0047 §3, 0021 §3, 0069 §1, 0072 §6 | Re-proposal cooldowns and caps, the per-person open cap, the re-open binding | One open Proposal per Atom; other wording joins it as a version. "Propose again" starts a fresh Proposal |
| 0065, 0002 (amendment) | Stand-aside; per-version notes | One optional note per ballot (≤ 280 code points), required when any score is 0 |
| 0017 (expiry), 0065 §3, 0072 §5, spec checkpoints | Ballot and note expiry; checkpoints | Ballots stay in the encrypted group log, and the join screen says so. **First privacy item to restore after the pilot** |
| 0012, 0054, 0072 §15 | Web Push and the daily digest | No push. Group home leads with "Needs your vote", and "Tell your group" shares a title-free nudge into the group's chat |
| 0064, 0048 | Quiet and Rising tabs | One list: unscored first, then soonest closing |
| 0006 (CRDT), 0031, 0023 (editor, line diffs) | Shared Yjs drafts, CodeMirror, line diffs | A private draft in a textarea with Preview, and word diffs on the ballot |
| 0006 (DAG), 0072 §1 §2, spec §4 encoding | CBOR, BLAKE3, `prev`, Lamport order, tally and checkpoint events; the author-time floor | Signed UTF-8 JSON bytes with SHA-256 ids, applied in the relay's order. Vote windows use the relay's receipt time; the author's `ts` is display only. No close or tally event |
| 0007, 0060 (shared vectors) | A Python reference implementation with shared vectors | The TypeScript engine is the only implementation, with golden vectors beside it. Python is the relay only |
| 0047, 0002 (quorum) | Quorum counted on the whole Proposal | Each version needs max(3, 30% of eligible) scorers, capped at the number eligible |
| 0045 | Unique names and renames | Names are fixed at join, and a duplicate name gets a short key suffix |
| 0019 (rotation, jitter) | Rotating per-member mailboxes; delivery jitter | One mailbox per group plus one per invite. Padding, sealed sender and no logs stay |
| 0057, 0072 §3 §16 | Staging and production, CI deploys, the update prompt | One VM, deployed by a founder-run script that smoke-tests every deploy. Unknown event versions are ignored |
| 0028 (WebSocket), 0055 (ICU), spec §7 | WebSockets, an ICU library, the personal page, the rejected-events view, relay choice | Polling while the app is visible, and one typed messages module |

### Accepted pilot risks

- **No key rotation.** Anyone who leaves, or opens a live invite link, can read the group from then on. The invite button and Leave both say so.
- **The relay is trusted for order and time.** It still can't read, forge or link anything.
- **Ballots and notes don't expire.** They're encrypted and visible only to members.
- **No recovery contacts.** A lost device without a backup file needs a new invite.

Before any group outside the founder's pilot circle uses the app, the outside review (ADR-0058) revisits these four.

## Consequences

- The MVP backlog is small: one tracer, the privacy core, the decisions that make Reconcile itself, and pilot readiness. The ADRs above stay as the design to grow back into. Each returns only when pilot feedback asks, by a new ADR that lifts its line here.
- [phase-1-spec.md](../spec/phase-1-spec.md), DESIGN.md and CLAUDE.md are cut to match by the first MVP issue.
- Code keeps the seams that make return cheap: the `can()` capability helper, and an Atom's document id.
