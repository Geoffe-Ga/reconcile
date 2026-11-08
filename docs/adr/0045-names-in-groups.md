# ADR-0045: Names in a Group Are Freely Chosen, Unique, and Changes Show

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-identity-recovery`, decision `display-names`
- **Refines:** [ADR-0009](0009-per-group-identities.md), [ADR-0017](0017-need-to-see-and-expiry.md)

## Decision

- **A person chooses any name in each group.** It must be unique within that group. At join, a hint says: "This name is only shown in this group. It doesn't have to be your real name."
- **Changing a name is allowed, and the group sees "formerly X".** That stops anyone switching names mid-vote to confuse people. The history expires on the same schedule as ballots (ADR-0017).

## Consequences

- New log event (Epic 1): `rename`, carrying the new name. Validation rejects a name already in use in the group.
