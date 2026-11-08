# Claude Code Project Context: Reconcile

---

## 📖 What This Project Is

**Reconcile** is a platform for **collaborative, democratically governed document editing**. It helps groups that disagree about most things become "strange bedfellows" and act on whatever they genuinely share. It serves everyday communities (families, fan communities, recovery fellowships, workplaces) as well as movements: see [`docs/use-cases.md`](docs/use-cases.md).

The short version: **GitHub pull requests + democratic voting + a mission-statement layer + a coalition graph.**

> ⚠️ "Reconcile" here means *reconciling people and groups*, **not** financial or data reconciliation. There are no transactions, ledgers, or record-matching in this domain.

The product source of truth is **[`docs/plan/`](docs/plan/)**. **Level names changed on 2026-11-07** ([ADR-0021](docs/adr/0021-level-names-and-self-selection.md)): `docs/plan/` still uses the old meanings, where "Co-Creator" meant follower and "Collaborator" meant the creating level. Use the table below. In prose, a lowercase "member" means anyone in a group, and a capitalized **Member** means the follower level. Read [`02_What_Is_Reconcile.md`](docs/plan/02_What_Is_Reconcile.md) and [`03_Core_Entities.md`](docs/plan/03_Core_Entities.md) before designing anything. Those docs deliberately leave the stack and architecture open. Record each architecture decision as an ADR. Don't assume one.

### Domain Vocabulary (use these terms exactly)

| Term | Meaning |
|------|---------|
| **Co-Creator** | A user who writes, proposes, discusses, and votes: the creating level of a group |
| **Collaborator** | A user who votes on Proposals but doesn't propose |
| **Member** | A follower of a Co-Creator, Organization, or Coalition. Gets notifications but doesn't govern |
| **Organization** | Any community (a Discord server, a movement, a Facebook group) that keeps shared living documents |
| **Coalition** | An umbrella entity formed when Organizations **reconcile**. It has a jointly authored mission statement |
| **Document** | A living, revisable text (personal, organizational, or coalition-level), such as a Mission Statement |
| **Atom** | The unit of change in a Document: a section, clause, paragraph, or value statement |
| **Proposal** | A proposed change to an Atom, like a pull request. It has a title, a justification, and the proposed content. Formerly "Pitch" (renamed 2026-11-07); the verb is *propose* |
| **Working Copy** | A checked-out draft that autosaves and has a shareable URL. Returning it may surface **Conflicts** |
| **Vote** | Governance on a Proposal. Voters score it 0–4 within a time window. It passes on a **consent floor**: average ≥ 2.0 and fewer than 10% scoring 0 ([ADR-0002](docs/adr/0002-consent-floor-vote-rule.md)). Competing versions of an Atom all go on the ballot ([ADR-0004](docs/adr/0004-competing-versions-go-to-ballot.md)) |
| **Dispatch** | A notification a Co-Creator (or a Proposal) sends to followers. Formerly the working name "Push" |
| **Involvement Level** | A person's level in a group: **Member** (follows), **Collaborator** (votes), or **Co-Creator** (votes and creates). Moving between levels is self-selected once admitted. Code checks capabilities, never level names ([ADR-0003](docs/adr/0003-three-tier-involvement-levels.md), [ADR-0021](docs/adr/0021-level-names-and-self-selection.md)) |

### Core Loops

- **Document editing:** View → Proposal → Discuss → Vote → Update ([04](docs/plan/04_Workflows_Document_Editing.md), [07](docs/plan/07_Voting_and_Governance.md))
- **Coalition forming:** View → Proposal → Discuss → Vote (both groups) → Reconcile ([05](docs/plan/05_Workflows_Reconciling_Groups.md))
- **Outer loop:** published or updated Documents notify Members ([08](docs/plan/08_Notifications_and_Pushes.md))

The canonical Document is not the last thing someone typed. **It is the last edit that survived governance.**

### Non-Negotiable Design Constraint: Defend Against Weaponization

Reconcile can easily turn into a **database of people, their ideologies, and their associations**. That list would be valuable to hostile states, extremists, data brokers, and harassers. See [`12_Security_Privacy_Threat_Model.md`](docs/plan/12_Security_Privacy_Threat_Model.md). Every feature must account for this:

- **Data minimization:** collect the least identifying data needed
- **Compartmentalization:** avoid a single global, enumerable "list of everyone"
- **Privacy-preserving discovery:** group membership and coalition graphs must not be trivially enumerable
- **Consent and reversibility:** affiliation and following are explicit and can be undone
- **Safe defaults** for vulnerable participants, plus **anti-capture** governance mechanics
- Treat membership lists, voting records, coalition graphs, and identity-to-ideology links as **high-risk data**

**Reconcile is local-first** ([ADR-0001](docs/adr/0001-local-first-trust-model.md)). Canonical data lives on members' devices, and any server is a relay that can't read or enumerate membership, affiliation, or votes. Never add a central database of members, affiliations, or votes. Discovery is relational (through people you already share a group with), never a global directory. The stack is a TypeScript PWA client ([ADR-0005](docs/adr/0005-pwa-client.md)), a signed governance log plus CRDT drafts ([ADR-0006](docs/adr/0006-signed-log-plus-crdt.md)), and a thin Python relay ([ADR-0007](docs/adr/0007-thin-python-relay.md)). Each membership has its own identity ([ADR-0009](docs/adr/0009-per-group-identities.md)).

### Roadmap (conceptual; see [14](docs/plan/14_Roadmap_Open_Questions.md))

- **Phase 0:** settle definitions, ethics, and privacy principles
- **Phase 1:** single-Organization MVP: onboarding, personal page, create/join an org, documents, proposal → vote → update, notifications
- **Phase 2:** Coalition MVP: discovery, reconciliation proposal, dual voting, coalition documents
- **Phase 3:** outer-loop activation: the Member experience, scheduled Dispatches, calls to action

**Settled decisions** are in [`docs/adr/`](docs/adr/README.md). Read them before designing anything.

**Still open:** [docs/spec/decision-roadmap.md](docs/spec/decision-roadmap.md) lists every remaining decision, sheet by sheet. **Spec decomposition and issue filing wait until it is complete.** Among them:
- which fiscal sponsor ([ADR-0033](docs/adr/0033-legal-entity-staging.md)) and the exact eternal-core wording ([ADR-0035](docs/adr/0035-reconcile-group-minimal-eternal-core.md))
- group payee options ([ADR-0027](docs/adr/0027-supporters-and-coalition-tip-share.md)), fork petition thresholds, and the duress storage design ([ADR-0018](docs/adr/0018-device-protection-and-duress.md))
- don't publish the repo or add a LICENSE until publication ([ADR-0024](docs/adr/0024-source-available-license.md))

When work depends on one of these, flag it instead of silently picking an answer.

---

## 📋 Critical Principles

**Details: [.claude/docs/principles.md](.claude/docs/principles.md)**

1. **Use project scripts, not direct tools.** Run `./scripts/*`.
2. **Don't duplicate content (DRY).** Link to the canonical source, especially `docs/plan/`.
3. **No shortcuts.** Fix root causes and never bypass quality checks.
4. **Stay Green.** Never request review with failing checks.
5. **Quality first:** ≥90% coverage, complexity ≤10, ≥80% mutation score.
6. **Work from the project root** and use relative paths.
7. **Verify before every commit:** `./scripts/check-all.sh` must exit 0.

**The 4 Gates:** (1) `./scripts/check-all.sh` passes · (2) CI is green · (3) mutation score ≥80% · (4) code review LGTM

---

## 🎯 Quality Standards

**Details: [.claude/docs/quality-standards.md](.claude/docs/quality-standards.md)**

| Metric | Threshold | Tool |
|--------|-----------|------|
| Code coverage | ≥90% | pytest-cov |
| Branch coverage | ≥85% | pytest-cov |
| Docstring coverage | ≥95% | interrogate |
| Mutation score | ≥80% | mutmut (Python), Stryker (client) |
| Cyclomatic complexity | ≤10 per function | radon / xenon |
| Security vulnerabilities | 0 critical/high | bandit, pip-audit, npm audit |

**One set of rules.** CI runs the same scripts (`./scripts/check-all.sh --python` / `--client`) plus `pre-commit run --all-files`, with the exact tool versions pinned in `requirements-dev.txt`, `client/package-lock.json`, and `client/.nvmrc`. Thresholds and scope live in `pyproject.toml` and the client config, never in `ci.yml`. Change a rule there, once. Run checks with `.venv` active (`python3 -m venv .venv && pip install -r requirements-dev.txt -e .`).

---

## 🏗️ Current Layout

The repo is freshly scaffolded. The only code is a hello-world entry point.

```
reconcile/
├── docs/plan/            # Product definition (source of truth; local only, gitignored)
├── docs/adr/             # Accepted architecture decisions
├── docs/prompts/         # Working prompts (local only, gitignored)
├── docs/spec/            # Specifications (phase-1-spec.md feeds spec-decomposition)
├── plans/                # Working implementation plans
├── client/               # TypeScript PWA (green-init scaffold; see client/CLAUDE.md)
├── reconcile/            # Python package: relay + protocol reference (main.py is a placeholder)
├── DESIGN.md             # Visual system and voice (client tokens and /decide sheets read it)
├── tests/                # pytest suite
├── scripts/              # Quality gate scripts (check-all, test, lint, …)
├── .claude/docs/         # Detailed dev guidance (principles, workflow, testing, tools)
├── .claude/skills/       # Project skills (<name>/SKILL.md)
├── .github/workflows/    # ci.yml, code-review.yml
├── pyproject.toml        # Tool configuration
├── requirements*.txt     # Runtime / dev dependencies
└── .pre-commit-config.yaml
```

Domain modules (Documents, Atoms, Proposals, Votes, Organizations, Coalitions, notifications) don't exist yet. Add them through ADR-backed design. Don't scaffold them speculatively.

---

## 🔄 Development Workflow

**Details: [.claude/docs/workflow.md](.claude/docs/workflow.md)**

```bash
git checkout -b feature/proposal-model
# TDD: failing test → minimum code → refactor
./scripts/format.sh
./scripts/check-all.sh          # must exit 0
git commit -m "feat(proposal): add Proposal entity with justification (#12)"
gh pr create --fill
```

### Primary Commands

```bash
./scripts/check-all.sh   # checks for every area the change touches (Python, client); --all forces both
./scripts/test.sh        # tests + coverage
./scripts/lint.sh        # linting
./scripts/typecheck.sh   # mypy
./scripts/format.sh      # auto-format
./scripts/security.sh    # bandit, pip-audit
./scripts/mutation.sh    # mutation testing
```

### Example Domain Test (Hypothesis)

```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers(min_value=0, max_value=4), min_size=1))
def test_vote_outcome_is_order_independent(scores: list[int]) -> None:
    """A Proposal's outcome must not depend on ballot order."""
    assert tally(scores) == tally(list(reversed(scores)))
```

---

## 🚨 Common Mistakes

**Details: [.claude/docs/troubleshooting.md](.claude/docs/troubleshooting.md)**

1. Skipping local quality checks
2. Lowering thresholds instead of writing tests
3. Invoking tools directly instead of using `./scripts/*`
4. Commenting out failing tests
5. Adding `# noqa` without a justification or issue reference
6. **Domain-specific:** treating "reconcile" as data/financial reconciliation, or adding features that expose membership or affiliation data without checking them against the threat model

---

## 📚 Skills

Project skills live in `.claude/skills/<name>/SKILL.md`. The set is deliberately small, curated from `../well-worn-tools` and `../creek-tools` for this project's current stage. Add a skill when there's real work for it, not in advance.

| Stage | Skills |
|-------|--------|
| Decide | [decide](.claude/skills/decide/SKILL.md) (interactive decision sheet), [architectural-decisions](.claude/skills/architectural-decisions/SKILL.md) (for the open stack and trust-model choices) |
| Plan | [spec-decomposition](.claude/skills/spec-decomposition/SKILL.md) (`docs/plan/` → epics and issues), [tracer-code](.claude/skills/tracer-code/SKILL.md) (wire the Phase 1 loop end to end first) |
| Build | [stay-green](.claude/skills/stay-green/SKILL.md), [testing](.claude/skills/testing/SKILL.md), [mutation-testing](.claude/skills/mutation-testing/SKILL.md), [max-quality-no-shortcuts](.claude/skills/max-quality-no-shortcuts/SKILL.md), [bug-squashing-methodology](.claude/skills/bug-squashing-methodology/SKILL.md) |
| Secure | [security](.claude/skills/security/SKILL.md) (required for identity, membership, or vote data), [cve-remediation](.claude/skills/cve-remediation/SKILL.md) |
| Ship | [git-workflow](.claude/skills/git-workflow/SKILL.md), [review-diff](.claude/skills/review-diff/SKILL.md) (self-review before the PR), [await-claude-review](.claude/skills/await-claude-review/SKILL.md), [address-feedback](.claude/skills/address-feedback/SKILL.md), [ci-debugging](.claude/skills/ci-debugging/SKILL.md) |

### Review Verdicts

`.github/workflows/code-review.yml` posts one comment per review as `github-actions[bot]`. The comment starts with `<!-- reconcile-review pr=N -->` and ends with `## Verdict: LGTM | CHANGES_REQUESTED | COMMENTS`. Trust a verdict only from that author, with that marker, unedited by anyone else, and posted after the current HEAD.

- `LGTM`: merge on green CI.
- `CHANGES_REQUESTED`: fix with TDD, push once, and wait for the new verdict.
- `COMMENTS`: **never iterate.** File each actionable finding as a follow-up issue labeled `P0` through `P3` by severity, then merge on green CI. `P0` covers security, data loss, crashes, and privacy leaks. `P3` covers nits.
- Any other value: don't merge; surface it to the user.

The procedure is in `address-feedback`. The workflow, `await-claude-review`, and `address-feedback` must change together.

---

## Appendix: Delegating to Subagents

Give each subagent:

1. **The task and why it matters.** Name the relevant `docs/plan/` module(s).
2. **Context:** files, related issues, ADRs, and the domain vocabulary above.
3. **Privacy impact:** what personal, affiliation, or voting data the change touches, checked against the threat model.
4. **Acceptance criteria:** `./scripts/check-all.sh` exits 0, coverage ≥90%, mutation score ≥80%, mypy strict passes, security scan is clean, public APIs are documented, and an ADR exists if an architectural decision was made.
5. **Open questions:** any TBD product decision the task depends on, flagged explicitly.
