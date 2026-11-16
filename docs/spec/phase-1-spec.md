# SPEC: The Reconcile MVP

- **Status:** The build contract for the MVP, rewritten for [ADR-0073](../adr/0073-mvp-scope.md), [ADR-0074](../adr/0074-mvp-scope-revised.md) and [ADR-0075](../adr/0075-safeguards-for-the-revised-mvp.md)
- **Date:** 2026-11-09
- **Inputs:** `docs/plan/` (product), ADRs 0001–0075 (`docs/adr/`), and the issues under epics #57–#60 (the foundation) and #82–#88 (the restored features)
- **Earlier version:** the full Phase 1 design of 2026-11-07, at commit `f4b9e2b`. An ADR that cites "spec §N" means that version's numbering.

This spec says **what the MVP builds and how**. It links to ADRs for *why* and doesn't repeat them. When this spec and an ADR disagree, the ADR wins (ADR-0075, then ADR-0074, then ADR-0073). An issue that adds or changes a contract updates this spec in the same PR.

---

Each section lives in its own file under [`phase-1/`](phase-1/), with its number unchanged, so a citation such as §4 still holds. Edit the section's file, not this index; change the index only when a heading changes.

## 1. Goal

[`phase-1/01-goal.md`](phase-1/01-goal.md)

## 2. System overview

[`phase-1/02-system-overview.md`](phase-1/02-system-overview.md)

## 3. Identity and keys

[`phase-1/03-identity-and-keys.md`](phase-1/03-identity-and-keys.md)

## 4. Events

Its introduction is in [`phase-1/04-events.md`](phase-1/04-events.md), and each subsection below has a file of its own.

### Envelope

[`phase-1/04-events/01-envelope.md`](phase-1/04-events/01-envelope.md)

### The fold

[`phase-1/04-events/02-the-fold.md`](phase-1/04-events/02-the-fold.md)

### Foundation event types

[`phase-1/04-events/03-foundation-event-types.md`](phase-1/04-events/03-foundation-event-types.md)

### Proposals and ballots

[`phase-1/04-events/04-proposals-and-ballots.md`](phase-1/04-events/04-proposals-and-ballots.md)

### Stewards and suspensions

[`phase-1/04-events/05-stewards-and-suspensions.md`](phase-1/04-events/05-stewards-and-suspensions.md)

### Removal

[`phase-1/04-events/06-removal.md`](phase-1/04-events/06-removal.md)

### Opt-ins

[`phase-1/04-events/07-opt-ins.md`](phase-1/04-events/07-opt-ins.md)

### Dissolution

[`phase-1/04-events/08-dissolution.md`](phase-1/04-events/08-dissolution.md)

### Chat bot

[`phase-1/04-events/09-chat-bot.md`](phase-1/04-events/09-chat-bot.md)

### Front door

[`phase-1/04-events/10-front-door.md`](phase-1/04-events/10-front-door.md)

### Dispatches

[`phase-1/04-events/11-dispatches.md`](phase-1/04-events/11-dispatches.md)

### Vouches and the wait before voting

[`phase-1/04-events/12-vouches-and-the-wait-before-voting.md`](phase-1/04-events/12-vouches-and-the-wait-before-voting.md)

### Encryption keys and a new group key

[`phase-1/04-events/13-encryption-keys-and-a-new-group-key.md`](phase-1/04-events/13-encryption-keys-and-a-new-group-key.md)

### Recovery shares

[`phase-1/04-events/14-recovery-shares.md`](phase-1/04-events/14-recovery-shares.md)

### Coalitions

[`phase-1/04-events/15-coalitions.md`](phase-1/04-events/15-coalitions.md)

### Capabilities

[`phase-1/04-events/16-capabilities.md`](phase-1/04-events/16-capabilities.md)

## 5. Tally

[`phase-1/05-tally.md`](phase-1/05-tally.md)

## 6. Relay API

[`phase-1/06-relay-api.md`](phase-1/06-relay-api.md)

## 7. Sync

[`phase-1/07-sync.md`](phase-1/07-sync.md)

## 8. Screens

[`phase-1/08-screens.md`](phase-1/08-screens.md)

## 9. Privacy rules

[`phase-1/09-privacy-rules.md`](phase-1/09-privacy-rules.md)

## 10. Quality gates

[`phase-1/10-quality-gates.md`](phase-1/10-quality-gates.md)

## 11. Restored features

[`phase-1/11-restored-features.md`](phase-1/11-restored-features.md)

## 12. Deferred

[`phase-1/12-deferred.md`](phase-1/12-deferred.md)
