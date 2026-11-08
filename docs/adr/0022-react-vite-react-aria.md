# ADR-0022: React + Vite, React Aria Components, and DESIGN.md

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-product-stack`, decision `frontend-framework`, `ui-kit`

## Decision

- **The client is React 19, built as a single-page app with Vite.** There is no server rendering: it's local-first (ADR-0001, 0005).
- **Tooling:** Vitest and Testing Library for tests, Playwright for the end-to-end loop, ESLint 9 flat config with typescript-eslint and the React plugins, StrykerJS with the Vitest runner, and `npm audit` in the gate. The code is ESM throughout.
- **Components:** React Aria Components (unstyled, accessible), styled only from the tokens in [`DESIGN.md`](../../DESIGN.md).
- **Design system:** `DESIGN.md` at the repo root, an original mix drawn from [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) analyses at the user's request: an earth palette after Oura, editorial serif hierarchy after Wired, friendly controls after Wise, plus Public Sans.
- **Boundary rule:** `client/src/engine`, `client/src/crypto`, and `client/src/store` are plain TypeScript with **no React imports**. dependency-cruiser enforces this, so the core outlives any UI framework.
- **Fonts are self-hosted** (`@fontsource`). The app makes no third-party network calls.

## Consequences

- Accessibility target: WCAG 2.2 AA. The ballot and key screens get dedicated accessibility tests (axe in Playwright).
- The placeholder Jest/ESLint 8/CommonJS scaffold from `green init` is replaced.
