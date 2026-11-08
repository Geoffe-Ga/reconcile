# ADR-0001: Local-First Trust Model with Relational Discovery

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-phase-0`, decision `trust-model`

## Context

Reconcile records which people belong to which groups, what those groups stand for, and how members vote. A central store of that data is a ready-made list of people indexed by ideology and association. It would be valuable to hostile states, extremists, data brokers, and harassers, and one breach, subpoena, or rogue insider would expose everyone.

We considered three trust models:

| Option | Breach blast radius | Discovery | Phase 1 cost |
|---|---|---|---|
| Central server | Everyone | Trivial | Baseline |
| Federated instances | One instance | Protocol work | +20–30% |
| **Local-first** | One device | Limited, relational | 2–3× |

## Decision

**Reconcile is local-first.** Canonical data (documents, memberships, pitches, votes) lives on members' devices and syncs between peers. Any server we run is a relay or store-and-forward node. It must not be able to read, enumerate, or reconstruct membership, affiliation, or voting data.

**Discovery is peer-to-peer and relational, not a global directory.** The working idea: you discover groups through people you already share a group or coalition with ("coalition-mate discovery"), so the network grows outward along existing trust rather than through a searchable index of everyone.

We accept a harder build in exchange for never creating the central list.

## Proposed, Not Yet Decided: Holonic Promotion

The user proposed this alongside the decision. It's recorded here so it shapes the design, but it is **not** a commitment yet.

- Any member can write an article or essay. Groups vote to promote it to the coalition above them, and each coalition votes again, so a piece rises through an expanding circle of nested groups (holons).
- **Reconcile itself is the outermost group.** Its users collaboratively edit Reconcile's own mission, vision, and values through the normal Pitch → Vote loop. It can broadcast to the entire user base the articles that cleared every level below it.
- Reach is earned through governance at each level, not through engagement metrics.

## Consequences

- **Vote integrity needs cryptography.** With no trusted server, ballots must be signed and tallies verifiable by the members who hold them. This is the highest-risk engineering item. Use proven libraries and get an external review.
- **Sync needs a proven CRDT or merge layer.** Documents and Atoms are edited concurrently on different devices.
- **Offline works by default**, including direct reconciliation in person (the "local rally" scenario from the original critique).
- **Discovery is deliberately limited.** Growth follows real relationships. That is slower, by design.
- **Phase 1 costs more.** It must still deliver a single-Organization MVP, so keep the first slice to one group syncing among its members.

## Tensions to Resolve Before Building Discovery or Promotion

These come from the decision itself and must be settled in follow-up ADRs:

1. **Coalition-mate discovery leaks associations.** Showing me "groups your coalition mates belong to" tells me which other groups those mates are in, which is the association data this ADR exists to protect. Options include per-group "discoverable" opt-in, showing that a group is reachable without revealing which mate links to it, and k-anonymity thresholds before a group appears.
2. **Holonic promotion needs a broadcast path.** Reaching the whole user base in a local-first system means a gossip or relay layer. It has to deliver to everyone without anyone learning who received it.
3. **The outermost group is a capture target.** If Reconcile-the-group can broadcast to everyone, controlling its governance is very valuable. It needs the strongest anti-capture rules of any group, and its member list (effectively every user) must stay non-enumerable.
4. **Promotion math is undefined.** Open questions: does each level apply the consent floor (ADR-0002) with its own quorum? Does a level vote as a bloc or by individual members? How are members who belong to several groups prevented from voting the same piece up twice?

## Related

- ADR-0002 (vote pass rule) applies at every level of holonic promotion.
- ADR-0003 (involvement levels) governs who may vote at each level.

## Amendment (2026-11-07)

Holonic promotion is decided in [ADR-0037](0037-holonic-promotion.md): each level decides, the author sets a ceiling, and votes travel with the Dispatch on the voter's own device. Opt-in front doors ([ADR-0038](0038-optional-discovery.md)) are the only public discovery, and they never list people.
