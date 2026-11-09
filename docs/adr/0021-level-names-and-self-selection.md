# ADR-0021: Level Names Corrected; Moving Up Is Self-Selected

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it; [ADR-0074](0074-mvp-scope-revised.md) restores part of it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-product-stack`, decision `collaborator-promotion`

## Context

ADR-0003 and earlier docs named the levels Co-Creator (follows), Member (votes), and Collaborator (votes and proposes). The user corrected this.

## Decision

1. **The levels are:**

   | Level | Follows | Votes | Creates (proposals, working copies) |
   |---|---|---|---|
   | **Member** | ✓ | | |
   | **Collaborator** | ✓ | ✓ | |
   | **Co-Creator** | ✓ | ✓ | ✓ |

2. **Moving between levels is self-selected.** Anyone admitted can be a Member. A person with voting rights from admission (invite, vouches, and the 14-day wait in ADR-0014) can choose Collaborator or Co-Creator at any time, and anyone can step down.
3. **Spam guard:** each person has at most **3 open Proposals** per group (a default each group can change). Stewards (ADR-0016) handle abuse.

## Consequences

- Code checks capabilities (`follow`, `vote`, `propose`), never level names (ADR-0003), so the rename touches only labels.
- `docs/plan/` still uses the old names. CLAUDE.md carries the mapping.
- In prose, a lowercase "member" means anyone in a group, and a capitalized **Member** means the follower level.
