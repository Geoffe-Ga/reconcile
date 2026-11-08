# ADR-0050: "Split," Not "Fork": 20% Within 14 Days

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-governance-edges`, decision `fork-numbers` (chose `20pct-14d`, with the founder's note)
- **Refines:** [ADR-0015](0015-anti-capture.md), [ADR-0010](0010-open-ballots-with-exit.md)

## Decision

- **The governance act is called a *split*, not a *fork*,** everywhere: UI, docs, and protocol (`split-petition`). From the founder's note: "The stigma attached to the word will help discourage it. Forking is a positive move in open source communities; splitting is something you don't do unless you really need to."
- **A split petition needs signatures from 20% of voting members, gathered within 14 days of a trigger.** The triggers are unchanged from ADR-0015:
  - an entrenched Atom changed;
  - removals or suspensions affecting at least 10% of members within 30 days;
  - a stewards' decision that the petitioners appeal and lose.
- **Signatures stay sealed until 20% is reached**, so a petition doesn't expose a faction before it qualifies.
- Leaving stays open to anyone, at any time.

## Consequences

- "Fork" survives only where it means forking *code* (ADR-0013, ADR-0024).
- Phase 1 reserves and rejects `split-petition`. The flow is Phase 2. Members choosing whom to follow after a split is Phase 3.
