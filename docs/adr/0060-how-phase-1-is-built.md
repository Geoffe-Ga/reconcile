# ADR-0060: Agents Build in Waves; Green Merges; main Is Protected; Labels

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-dev-process`, decisions `who-builds`, `crypto-review` (chose `green-only`), `branch-protection`, `labels`

## Decision

- **Agents work the backlog in small waves**, 2–4 at a time, within the machine limits in the founder's global working rules. The founder steers: answers escalations, tests on devices, and watches merges.
- **Green is enough to merge, including security-critical code.** A PR merges when the gates pass (ADR-0061), with no separate human sign-off. The founder chose this knowingly. Before an outside review (ADR-0058), the safeguards are:
  - audited libraries only (`@noble/*`);
  - shared protocol test vectors that the Python and TypeScript implementations must both pass;
  - the review bot;
  - CI's security scans.
- **main is protected.** No direct pushes. A PR must pass the `CI gate` job (which fails if any job that ran failed) and the `claude-review` job before merging.
- **Issue labels:**
  - area: `protocol`, `relay`, `client`, `identity`, `e2e`
  - type: `epic`, `spec-decomposition`, `tracer`, `spike`
  - priority: `P0`–`P3`
  - plus `security-critical` and `blocked`

## Consequences

- No human reads the key-handling code before the outside review. Keep the list of security-critical paths current, so that review can start quickly.
- An urgent fix goes through a PR like anything else.
- The filing script applies labels when the issues are filed. Agents set `blocked` when they hit a dependency.
