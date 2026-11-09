# Reconcile Client (TypeScript PWA)

This is the member-device app: UI, group engine, keyring, and encrypted local store. **Read the root [`CLAUDE.md`](../CLAUDE.md) first.** Its domain vocabulary, the "Defend Against Weaponization" constraint, and the ADRs all apply here unchanged.

- **What to build:** [`docs/spec/phase-1-spec.md`](../docs/spec/phase-1-spec.md): its Identity and keys, Events, Tally, Relay API, Sync, Screens and Privacy rules sections describe the foundation, and Restored features names the issue that builds each later feature
- **Why:** ADR-0073 and ADR-0074 (MVP scope: what to build now, and how deep), ADR-0075 (its safeguards), ADR-0005 (PWA), 0006 (signed log), 0008 (keys and recovery), 0009 (per-group identities), 0017 (visibility), 0018 (device protection), 0022 (React + Vite + React Aria), and 0023 (Markdown Atoms) in [`docs/adr/`](../docs/adr/README.md)
- **Look and voice:** [`DESIGN.md`](../DESIGN.md). `src/styles/tokens.css` mirrors it: change DESIGN.md first.
- **Contract:** governance logic must pass the golden JSON vectors in `src/engine/vectors/` and the fast-check properties beside them. The TypeScript engine is the only implementation ([ADR-0073](../docs/adr/0073-mvp-scope.md))

## Commands

Run from `client/`, or run `./scripts/check-all.sh` from the repo root, which runs this gate when `client/` changed.

```bash
npm ci
./scripts/check-all.sh   # lint, format, typecheck, tests + coverage, architecture, npm audit
./scripts/mutation.sh    # Stryker (Vitest runner), ≥80%; recommended before a release, not a merge gate
npm run dev              # local dev server
npm run build            # production build
```

## Client rules

- **No hand-rolled cryptography.** Use audited `@noble/*` libraries (spec, Identity and keys), plus `shamir-secret-sharing`, imported only by `src/crypto/shares.ts` ([ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) §4).
- **Nothing readable leaves the device.** Anything sent to the relay is a sealed, padded, encrypted blob (ADR-0019).
- **No analytics, telemetry, or third-party scripts.** The app calls only the relay, the browser's push service (#99), and Discord webhooks for groups that opted in by Proposal (#119).
- **Quiet safety:** protective features live in Settings and aren't promoted (ADR-0018).

## Toolchain

- **Stack:** React 19, Vite, TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), and React Aria Components
- **Testing:** Vitest + Testing Library (globals off: import `describe`/`it`/`expect` from `vitest`); Playwright is planned for the end-to-end loop
- **Linting:** ESLint 9 flat config with `strictTypeChecked`, jsx-a11y strict, and complexity ≤ 10
  - ESLint stays on 9 until `eslint-plugin-jsx-a11y` supports 10
- **Coverage:** ≥ 90% lines, ≥ 85% branches, enforced in `vite.config.ts`
- **Architecture:** `plans/architecture/.dependency-cruiser.cjs`
  - `src/engine`, `src/crypto`, and `src/store` may not import React or UI code
  - network libraries belong in `src/net/` only
- **Audit:** `npm audit --audit-level=moderate`
  - `package.json` `overrides` pin `minimatch` and `qs` to patched releases. Remove an override once its upstream package ships the fix
- **Fonts:** self-hosted through `@fontsource-variable/*`, never fetched from a third party

Detailed generic guidance is in [`.claude/docs/`](.claude/docs/).
