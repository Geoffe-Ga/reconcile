# ADR-0006: Governance Is a Signed Log; Draft Text Is a CRDT

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `data-sync`

## Context

Document text needs smooth concurrent merging. Governance facts (membership, proposals, votes, level changes) need to be signed, ordered, and auditable. The canonical Document is the last edit that survived governance, so governance must control what reaches it.

## Decision

**Two layers:**

1. **Governance log:** an append-only, hash-linked log of signed events per group (join, level change, proposal, vote, tally, removal, split). Every member's device validates every event against the group's rules before accepting it.
2. **Working copies:** draft text lives in a CRDT (Automerge or Yjs; choose in the spec after a spike). A CRDT can never change the canonical Document directly.

**Only a valid tally event that passes the consent floor (ADR-0002) moves the canonical Document.** It names the exact version (by content hash) that won.

## Consequences

- A malicious peer can write garbage into a CRDT draft but can't forge governance. Peers reject unsigned or rule-breaking events.
- Concurrent governance events (two tallies, a vote that arrives after a removal) need a deterministic ordering and validation rule. This is the core of the protocol spec and needs property tests.
- The event format is versioned from day one so ballots can change later (ADR-0010).

## Amendment (2026-11-08, decomposition details)

Time in the log is the author's `ts`, which can't be earlier than any parent's. A vote counts only if it is in the tally's causal past, and the first valid tally of a Proposal is canonical ([ADR-0072](0072-protocol-details-for-decomposition.md)).
