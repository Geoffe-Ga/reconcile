# Decision Roadmap: Everything Left Before Spec Decomposition

- **Status:** **Complete** (2026-11-08). All seven sheets are answered and recorded in ADRs 0028–0063, and the four-lenses review in ADRs 0064–0071 ([four-lenses-review.md](four-lenses-review.md)). Spec decomposition can start.
- **Started:** 2026-11-07
- **Process:** one `/decide` sheet at a time. For each: build the sheet, answer it, record the answers (new ADRs from 0062), update `docs/spec/phase-1-spec.md`, then mark the sheet done here.

Already settled: ADRs 0001–0040 and spec §10 ("Confirmed 2026-11-07"). This roadmap covers what's still open.

| # | Sheet | Blocks | Status |
|---|-------|--------|--------|
| 1 | Stack details | every epic | **Done** 2026-11-08: ADRs 0028–0031, 0041, 0042 |
| 2 | Identity, recovery, and devices | Epic 5, Epic 3 | **Done** 2026-11-08: ADRs 0043–0046 |
| 3 | Governance edge cases | Epics 1 and 4 (the protocol) | **Done** 2026-11-08: ADRs 0047–0051 |
| 4 | Onboarding, notifications, and UX scope | Epics 3 and 6 | **Done** 2026-11-08: ADRs 0052–0055, spec §7 |
| 5 | Pilot, operations, and release | Epic 2 deploy, Epic 6 acceptance | **Done** 2026-11-08: ADRs 0056–0058 |
| 6 | Development process (plus #32) | how the issues are written and worked | **Done** 2026-11-08: ADRs 0059–0061 |
| 7 | Later phases (Phase 2 and 3) | nothing in Phase 1, but decided now so nothing is left | **Done** 2026-11-08: ADRs 0062–0063, ADR-0035 amendment |
| 8 | Four-lenses review (Eisenstein, Rushkoff, Bateson, brown) | Epics 1, 4, 6 (tally, feed, pilot) | **Done** 2026-11-08: ADRs 0064–0071 |

## 1. Stack Details

The spec planned three time-boxed spikes (§9). Their questions are answered by desk research first, and the sheet presents what the research found.

- **Merging library for Working Copies:** Automerge or Yjs (or Loro). Criteria: bundle size, iOS Safari behavior, freezing a version to a hash, encrypted delta size. Reserved as ADR-0031.
- **Passkeys without PRF:** what to do on browsers where passkeys can't derive a key. Options include a PIN-derived key, a different authenticator, or not supporting that browser. Reserved as ADR-0030.
- **Local storage and eviction:** IndexedDB or OPFS, and what to do when the browser refuses `persist()` or evicts an installed PWA's data. Reserved as ADR-0029.
- **Relay framework and storage:** FastAPI or Starlette, with SQLite or plain files. Reserved as ADR-0028.
- **Relay hosting:** provider and region. A US nonprofit (ADR-0020) means US legal exposure either way; the choice also sets cost. This spends money, so the choice is yours.
- **Supported browsers and devices** for the pilot: the minimum versions we test and promise.
- **Wire encoding** for the governance log, if the spec's choice needs confirming.

## 2. Identity, Recovery, and Devices

- **Social recovery numbers:** how many recovery contacts, how many must agree (for example 3 of 5), and how long the delay is before recovery completes, with a notice to every existing device (ADR-0008).
- **More than one device:** whether a person can link a phone and a laptop, and how.
- **Losing everything:** what happens when someone loses every device and their recovery contacts don't respond.
- **Display names:** rules for the per-group pseudonyms (ADR-0009, 0017), such as uniqueness within a group and changing a name.
- **Duress storage approach:** pick the design approach now; the external review happens before it ships (ADR-0018).
- **Panic wipe trigger:** gesture, passcode, or menu item, and what survives a wipe.

## 3. Governance Edge Cases

These become protocol rules and test vectors, so they must be fixed before Epic 1.

- **Ballot size:** the maximum number of competing versions on one ballot (ADR-0004 proposed 3).
- **Missed quorum:** whether the vote lapses, re-runs once, or extends.
- **Stewards:** how many per group, term length, how they're elected, and the bootstrap before a group has 3 voters.
- **Removing a member:** who can propose it, the vote rule, and what the removed member keeps.
- **Split petitions:** initial numbers for the 20% petition and its triggers (ADR-0015), so the protocol has defaults to tune later.
- **Ballot expiry tuning:** the range a group may set (ADR-0017 defaults to 30 days).
- **Dissolving a group:** the vote, and what happens to its Documents and logs.
- **Changing founding rules:** which rules are entrenched at genesis.

## 4. Onboarding, Notifications, and UX Scope

- **First run:** the path from an invite link to a first vote, and what a person sees with no groups yet.
- **Invite cards:** link, QR code, or both; expiry; single-use or multi-use.
- **Notifications:** which events notify, when, and how they're batched (content-free per ADR-0012).
- **Offline and conflicts:** what the app shows when offline, and how a Working Copy conflict looks.
- **Accessibility target:** for example WCAG 2.2 AA, and how it's checked.
- **Languages:** English only for the pilot, or translation-ready from day one.
- **Screen list:** confirm the spec's 11 screens (§7) as the Phase 1 scope.

## 5. Pilot, Operations, and Release

- **The pilot:** which groups from your circle, how many people, how long, and what counts as success, measured without telemetry (for example interviews and surveys).
- **Feedback channel:** where pilot testers report problems.
- **Environments:** staging and production, and who can deploy.
- **Updates:** how the PWA updates, and how the protocol versions and migrates logs.
- **Data loss stance:** the relay keeps no backups by design. Say so plainly to testers.
- **Security:** an outside review before the pilot or after, a security contact, and an incident plan.
- **Pilot paperwork:** a privacy notice and terms for the founder-owned stage (ADR-0033).

## 6. Development Process

- **Suspension vs. the removal window** ([#32](https://github.com/Geoffe-Ga/reconcile/issues/32), from review): a 7-day suspension (ADR-0016) ends before a 14-day entrenched removal vote (ADR-0049). Extend the suspension while a removal is open, raise the maximum, or allow one renewal. (Governance, but found late; it rides on sheet 6.)

- **Review and merge:** branch protection, and whether to merge without the review bot until its API key is set.
- **CI budget:** limits on private-repo Actions minutes.
- **Mutation testing scope:** decided in ADR-0061 (before a release, not a merge gate).
- **Who builds:** working the issues yourself, with agents (one at a time or a fleet), or a mix. This changes how detailed each issue must be.
- **Labels and priorities:** the label scheme for the filed issues.

## 7. Later Phases (Phase 2 and 3)

Not needed for Phase 1, but answered now so nothing is left open.

- **Fiscal sponsor:** which one, against the criteria in ADR-0033.
- **Eternal core wording:** the exact sentence for Reconcile-the-group (ADR-0035).
- **Group payee:** an elected treasurer, the fiscal sponsor, or the group's own entity (ADR-0027).
- **Money edge cases:** splits when several coalitions promote one piece, and a group balance on split or dissolution (ADR-0027).
- **Reach-cost figures:** the numbers behind the gift prompt (ADR-0025).

## Housekeeping (No Sheet Needed)

**Done 2026-11-08:** ADR-0002, ADR-0003, and ADR-0004 carry amendments pointing at their answers.

## Deliberately Deferred (Not Blocking Phase 1)

These were decided as "later", with a trigger:

- **The eternal core's wording** (ADR-0035): a dedicated drafting session before Reconcile-the-group's genesis in Phase 2.
- **The fiscal sponsor** (ADR-0062): after a successful pilot, or when money is actually needed.
- **The outside security review** (ADR-0058): when an activist group calls for it. Start booking at the first serious conversation.
- **Branch protection on main** (ADR-0060): needs GitHub Pro on a private repo, so it waits on the founder's choice to pay.
