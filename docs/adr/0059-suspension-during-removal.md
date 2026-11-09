# ADR-0059: A Suspension Lasts Until an Open Removal Vote Ends

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-dev-process`, decision `suspension-window`; resolves issue #32 (found by the review of PR #30)
- **Refines:** [ADR-0016](0016-suspend-then-vote.md), [ADR-0049](0049-stewards-and-removal.md)

## Decision

- A steward suspension still lasts **at most 7 days** on its own.
- **If a removal Proposal against the suspended member opens during the suspension, the suspension continues until that vote ends.** If the removal passes, `remove` follows. If it fails or lapses, the suspension ends at once.
- Stewards can't lengthen a suspension themselves. Only an open removal vote, which any voting member can see, extends it.

## Consequences

- A suspension can last up to about 21 days in total: 7 days plus a 14-day entrenched removal window opened on the last day.
- Validation: `suspend`'s expiry is computed as the later of its own expiry and the close of any open removal Proposal against that member. Test vectors cover a removal opened on day 6, a failed removal, and no removal.
