# ADR-0023: Atom Content Is Markdown

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-product-stack`, decision `atom-format`

## Decision

- **An Atom version's content is a CommonMark subset stored as UTF-8 text:** headings, emphasis, lists, links, block quotes, and code. No raw HTML, images, or tables in Phase 1.
- Text is normalized before hashing: NFC, LF line endings, no trailing whitespace, one final newline. The version hash (ADR-0006) is taken over the normalized bytes.
- Working copies use a **plain-text CRDT**. Editing uses **CodeMirror 6** with Markdown support and a live preview, plus a formatting toolbar so members never need to know the syntax.
- Ballots show **line-level diffs** between competing versions (ADR-0004).
- Rendering goes through a sanitizing Markdown renderer with **raw HTML disabled**, covered by XSS tests.

## Consequences

- Atom text pastes nearly unchanged into Discord, Slack, and Reddit, which helps the proposed platform integrations (ADR-0011).
- Normalization rules belong in `protocol/`, with test vectors both implementations must pass.
