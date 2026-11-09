# ADR-0068: "Part Ways," Not "Split"

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-four-lenses`, decision `structure` → `part-ways`. The same decision's other chosen option, `templates`, is [ADR-0067](0067-genesis-templates.md).
- **Amends:** [ADR-0050](0050-splitting.md) (its naming and rationale; the numbers stand), [ADR-0010](0010-open-ballots-with-exit.md), [ADR-0015](0015-anti-capture.md)

## Context

ADR-0050 named the exit "split" because the stigma would discourage it. Bateson's lens called that a double bind: the rules make a group's text unchangeable in places, then shame the only collective way out. adrienne maree brown and Eisenstein made the same point. The founder chose to reverse the stigma decision.

## Decision

- **The governance exit is called *parting ways*** everywhere: UI, docs, and protocol (`part-ways-petition`, replacing `split-petition`).
- **The triggers and numbers from ADR-0050 and ADR-0015 are unchanged:** 20% of voting members within 14 days of a trigger, signatures sealed until 20% is reached.
- **Parting is done with care:**
  - each new group's history opens with a short closing note both sides can see, offered (never required) as an ordinary Proposal before the parting completes;
  - both groups are offered a coalition on the Atoms they still share (Phase 2, ADR-0036).
- **Friction still comes from the trigger, not the name.** The UI still never puts parting ways on a vote result.
- "Fork" still means only forking *code* (ADR-0013, ADR-0024).

## Consequences

- `CLAUDE.md`'s vocabulary, `DESIGN.md`, the spec, and the translation glossary (ADR-0055) use "part ways". ADRs written before this one still say "split"; read it as "part ways".
- Phase 1 reserves and rejects `part-ways-petition`. The flow is Phase 2.
