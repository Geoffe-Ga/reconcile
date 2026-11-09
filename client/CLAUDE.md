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
./scripts/e2e.sh         # the end-to-end loop in Chromium and WebKit, through the real relay
./scripts/mutation.sh    # Stryker (Vitest runner), ≥80%; recommended before a release, not a merge gate
npm run dev              # local dev server
npm run build            # production build
```

### End-to-end loop

`e2e/loop.spec.ts` is the tracer loop: three browser profiles create a group, join it from the invite link, propose, vote (one of them offline) and see the Update. axe runs on every screen they visit, and any CSP violation fails the run.

- **Run it** with `./scripts/e2e.sh`, never bare `npx playwright test`. The script picks two free loopback ports (`E2E_WEB_PORT`, `RECONCILE_RELAY_PORT`) and puts the relay's database (`RECONCILE_RELAY_DB`) in a temp directory it deletes afterwards. It builds the app, then runs Playwright, whose config starts `../scripts/relay.sh` and `vite preview` (which sends the deploy CSP) and stops both.
- **Browsers:** install them once with `npx playwright install chromium webkit` (on Linux, add `--with-deps`). On a machine where WebKit won't install, `E2E_PROJECTS=chromium ./scripts/e2e.sh` runs Chromium alone and says so. CI always runs both.
- **Arguments** go to `playwright test`: `./scripts/e2e.sh --project=chromium --headed`, or `--trace on` to debug. A run that matches no test fails.
- **Gate:** the repo root's `./scripts/check-all.sh` runs it whenever `client/` or `reconcile/` changed, and CI's `e2e` job runs `./scripts/check-all.sh --e2e`. It stays out of this directory's `check-all.sh`, so the client gate needs no browser.
- **Rules:** keep `bypassCSP` off, and don't add a test-only relay mode or route, or time travel (`page.clock`): the relay runs exactly as `relay.sh` starts it.

## Client rules

- **No hand-rolled cryptography.** Use audited `@noble/*` libraries (spec, Identity and keys), plus `shamir-secret-sharing`, imported only by `src/crypto/shares.ts` ([ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) §4).
- **Nothing readable leaves the device.** Anything sent to the relay is a sealed, padded, encrypted blob (ADR-0019).
- **No analytics, telemetry, or third-party scripts.** The app calls only the relay, the browser's push service (#99), and Discord webhooks for groups that opted in by Proposal (#119).
- **Quiet safety:** protective features live in Settings and aren't promoted (ADR-0018).
- **Keep the CSP clean.** The deploy CSP (spec §9) blocks inline `<style>` elements, `style` attributes in markup and `data:` URLs. React's `style` prop is fine: it sets styles through the CSSOM. React Aria's pressable `<style>` is claimed in `index.html`, and `src/styles/pressable.css` ships its rule instead; `src/styles/pressable.test.tsx` fails if React Aria changes it (#150).

## Toolchain

- **Stack:** React 19, Vite, TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), and React Aria Components
- **Testing:** Vitest + Testing Library (globals off: import `describe`/`it`/`expect` from `vitest`), and Playwright with `@axe-core/playwright` for the end-to-end loop (`e2e/`, `tsconfig.e2e.json`)
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
