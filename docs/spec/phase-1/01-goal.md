## 1. Goal

Two pilot groups of 5–15 people each use Reconcile for six weeks ([ADR-0056](../../adr/0056-pilot-plan.md)). One is an everyday group, such as family or friends. The other is an organizing or community group whose content isn't sensitive. Each group governs its living Documents from its own devices, with no central database:

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

Protective features are real but quiet. Nothing in the UI suggests the app is for illegal activity (ADR-0018, [DESIGN.md](../../../DESIGN.md)).

---
