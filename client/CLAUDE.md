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
./scripts/check-all.sh   # lint, format, typecheck, tests + coverage, architecture, npm audit, tracked sources
./scripts/e2e.sh         # the end-to-end loop in Chromium and WebKit, through the real relay
./scripts/mutation.sh    # Stryker (Vitest runner), ≥80%; recommended before a release, not a merge gate
npm run dev              # local dev server
npm run build            # production build
```

### End-to-end loop

`e2e/loop.spec.ts` is the tracer loop: three browser profiles create a group, join it from the invite link, propose, vote (one of them offline) and see the Update. axe runs on every screen they visit, and any CSP violation fails the run. `e2e/versions.spec.ts` runs competing versions on a phone and a desktop, and `e2e/leave.spec.ts` Tell your group and Leave (#77). `e2e/relay-learns-nothing.spec.ts` (#71) runs a loop with a canary in every field, stops the relay, and scans the raw bytes of its database, WAL, shared memory and log for any canary, key or the testers' IP address, in every encoding (`e2e/support/scan.ts`). Its control blob must turn up, so the scan can't pass by reading nothing. `e2e/invite-history.spec.ts` (#73) passes a Proposal, deletes the group's oldest relay rows, genesis included, from the relay's SQLite file with `node:sqlite`, and checks that a newcomer joining from a fresh link sees the same Document and people. It also captures every request and fails on any group secret, invite seed or invite key in a path, query or body. `e2e/backup.spec.ts` (#78) saves a backup through the download path, scans the file for canaries and keys in every encoding, restores it on two fresh profiles that then vote as one person, and `e2e/erase.spec.ts` erases a seeded profile, capturing every request, and checks the reloaded app shows first run with no records. These specs share `e2e/support/fixtures.ts`: its `relay` fixture runs the real relay for each test, its `openProfile` fixture fails the test on any CSP violation in any profile and answers every request a profile sends to Discord itself, keeping each in `openProfile.discord`, so no test posts to Discord (#119), and `expectAccessible` runs axe with contrast on. `e2e/ios-scroll-lock.spec.ts` builds `e2e/ios-modal/`, a test-only page with one React Aria Modal, into a temp directory and serves it with `vite preview` and the app's config, until a screen of the app opens a modal (#153).

- **Run it** with `./scripts/e2e.sh`, never bare `npx playwright test`. The script picks two free loopback ports (`E2E_WEB_PORT`, `RECONCILE_RELAY_PORT`) and puts the relay's database (`RECONCILE_RELAY_DB`) and its stdout and stderr (`E2E_RELAY_LOG`) in a temp directory it deletes afterwards. It builds the app, then runs Playwright, whose config starts `vite preview` (which sends the deploy CSP). Each test starts `../scripts/relay.sh` itself and stops it when it ends (`e2e/support/fixtures.ts`), because Playwright can't stop a `webServer` mid-run and the scan needs a stopped relay.
- **Browsers:** install them once with `npx playwright install chromium webkit` (on Linux, add `--with-deps`). On a machine where WebKit won't install, `E2E_PROJECTS=chromium ./scripts/e2e.sh` runs Chromium alone and says so. CI always runs both.
- **Arguments** go to `playwright test`: `./scripts/e2e.sh --project=chromium --headed`, or `--trace on` to debug. A run that matches no test fails.
- **Gate:** the repo root's `./scripts/check-all.sh` runs it whenever `client/`, `reconcile/`, `requirements.txt` or `scripts/relay.sh` changed, and CI's `e2e` job runs `./scripts/check-all.sh --e2e`. It stays out of this directory's `check-all.sh`, so the client gate needs no browser.
- **Rules:** keep `bypassCSP` off, and don't add a test-only relay mode or route, or time travel (`page.clock`): the relay runs exactly as `relay.sh` starts it.
- **Beside the loop** (#76): `offline.spec.ts` (Chromium only) reloads offline under the service worker, `ios-gate.spec.ts` opens iPhone profiles at the install gate, and `csp.spec.ts` brings the worker up under the deploy CSP and checks that the page connects only to its own origin and Discord's webhook path (#119), from `e2e/support/connect.ts`, the one file outside `src/net/` that may call `fetch`. `push.spec.ts` (#99) runs in Chromium itself rather than its headless shell, which has no notifications: it checks Settings › Notifications under the deploy CSP, then delivers pushes straight to the service worker over the DevTools protocol, with no push service, and reads in the worker that each shows only "Something new in Reconcile". Every new profile accepts the pilot notice first (`acceptNotice` in `e2e/support.ts`).

## Client rules

- **No hand-rolled cryptography.** Use audited `@noble/*` libraries (spec, Identity and keys), plus `shamir-secret-sharing`, imported only by `src/crypto/shares.ts` ([ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) §4).
- **Nothing readable leaves the device.** Anything sent to the relay is a sealed, padded, encrypted blob (ADR-0019).
- **No analytics, telemetry, or third-party scripts.** The app's only network calls go to the relay and, once a group has turned its bot on by Proposal, that group's Discord webhook (#119). Only `src/net/relay.ts`, `src/net/push.ts` (the relay's push routes, #99) and `src/net/discord.ts` call `fetch`, and the deploy CSP's `connect-src` allows nothing but the app's own origin and `https://discord.com/api/webhooks/`. Push (#99) needs no CSP change: the browser talks to its own push service, and the page only calls `pushManager` through `src/platform/pushPort.ts`.
- **Push carries nothing** (#99, ADR-0012). Every notification is exactly "Something new in Reconcile" with the tag `reconcile` and no other option (`src/sw/notify.ts`), push request bodies hold only `endpoint` or `not_before`, and registrations and nudges take their mailbox only from `mailboxAt` (`src/store/mailbox.ts`). Tests use `src/test/fakePush.ts`, never a real push service.
- **Quiet safety:** protective features live in Settings and aren't promoted (ADR-0018).
- **First run gates keys.** Nothing makes keys behind the iOS install gate or before the pilot notice (`src/app/FirstRunGate.tsx`, spec §8.1). The service worker is `src/net/serviceWorker.ts`, built to `/sw.js` by `plugins/serviceWorker.ts`; it never caches `/v1`, and its push and notification-click handlers come from `src/sw/notify.ts` (#99).
- **Keep the CSP clean.** The deploy CSP (spec §9) blocks inline `<style>` elements, `style` attributes in markup and `data:` URLs. React's `style` prop is fine: it sets styles through the CSSOM. React Aria's pressable `<style>` is claimed in `index.html`, and `src/styles/pressable.css` ships its rule instead; `src/styles/pressable.test.tsx` fails if React Aria changes it (#150). Its iOS scroll-lock `<style>` has no id, so the CSP allows that one text by its hash in `style-src-elem`; `src/styles/scrollLockStyle.test.tsx` fails if React Aria changes it, and `e2e/ios-scroll-lock.spec.ts` opens a Modal as an iPhone under the CSP (#153). Never add `'unsafe-inline'`.

## Toolchain

- **Stack:** React 19, Vite, TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), and React Aria Components
- **Testing:** Vitest + Testing Library (globals off: import `describe`/`it`/`expect` from `vitest`), and Playwright with `@axe-core/playwright` for the end-to-end loop (`e2e/`, `tsconfig.e2e.json`)
- **Linting:** ESLint 9 flat config with `strictTypeChecked`, jsx-a11y strict, and complexity ≤ 10
  - ESLint stays on 9 until `eslint-plugin-jsx-a11y` supports 10
- **Coverage:** ≥ 90% lines, ≥ 85% branches, enforced in `vite.config.ts`
- **Architecture:** `plans/architecture/.dependency-cruiser.cjs`
  - `src/engine`, `src/crypto`, and `src/store` may not import React or UI code
  - network libraries belong in `src/net/` only
  - only `src/crypto` imports `@noble/*`, and `src/crypto` imports no other third-party package
- **Tracked sources:** `scripts/tracked.sh` fails when git ignores anything in `client/` but tool output, because CI's checkout wouldn't have it (the root's Python `build/` rule once hid `client/build/`, #76)
- **Audit:** `npm audit --audit-level=moderate`
  - `package.json` `overrides` pin `minimatch` and `qs` to patched releases. Remove an override once its upstream package ships the fix
- **Fonts:** self-hosted through `@fontsource-variable/*`, never fetched from a third party

Detailed generic guidance is in [`.claude/docs/`](.claude/docs/).
