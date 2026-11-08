# ADR-0024: Source-Available License

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-product-stack`, decision `license` (resolves the open question in ADR-0013)

## Decision

- **Reconcile's code is source-available:** public to read and audit, with **no right to run modified versions, redistribute, or fork** without permission.
- **Working choice: PolyForm Strict 1.0.0.** It allows noncommercial use and forbids changes and distribution. A lawyer must confirm it, or a custom license, before the first public release.
- **A contributor agreement** (assignment or broad license to the nonprofit) is required before accepting outside contributions, so the nonprofit can relicense later, for example to AGPL if a grant requires it.
- **Trademark:** register the mark (ADR-0026). It's the strongest anti-fork tool.

## Consequences

- Add `LICENSE` with the canonical license text, copied from the license steward and not retyped, when the repo is first published. Until then the repo stays private, and `package.json` and the README say `UNLICENSED` / not yet licensed.
- Grants that require OSI open source are out of reach unless the nonprofit relicenses. That's acceptable under the gift-economy model (ADR-0025).
- External security audits can still read everything.
