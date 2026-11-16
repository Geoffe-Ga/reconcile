## 10. Quality gates

The gates are [ADR-0061](../../adr/0061-quality-gates.md)'s, and [CLAUDE.md](../../../CLAUDE.md) lists them. Security-critical code merges on green under them (ADR-0075 §6).

| Area | Gate |
|---|---|
| Python relay | `./scripts/check-all.sh`: at least 90% line and 85% branch coverage, 95% docstring coverage, mypy strict, complexity at most 10, and bandit and pip-audit clean |
| TypeScript client | `client/scripts/check-all.sh`: ESLint 9 (strict, a11y, complexity at most 10), Prettier, `tsc -b`, Vitest with at least 90% lines and 85% branches, dependency-cruiser boundaries, `npm audit`, and no git-ignored source file (`scripts/tracked.sh`) |
| Engine contract | Every golden vector in `client/src/engine/vectors/` passes. fast-check shows that the outcome doesn't depend on ballot order, that folding the same records twice gives equal state, and that a pass changes only its target Atom (#63) |
| End to end | Playwright (Chromium and WebKit), with axe on every screen, runs the loop through the real relay whenever `client/` or `reconcile/` changes (`./scripts/check-all.sh --e2e`, #67) |
| Privacy | The relay-learns-nothing e2e (#71): after a loop with canaries in every field, the stopped relay's database, WAL, shared memory and log hold no canary, name, key or tester IP in any encoding, and do hold its control blob. Plus the no-IP tests (#62, #68) |
| Deploy | `deploy/check.sh` validates the Caddyfile and the systemd units in CI (#68) |
| Every PR | TDD, `./scripts/precommit-changed.sh`, green CI and the review bot's verdict |
| Before a release | Mutation testing, aiming for 80%. Recommended, not a merge gate |
| Before groups outside the founder's circle | The outside security review (ADR-0058, #132) |

---
