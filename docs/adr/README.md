# Architecture Decision Records

Settled decisions about how Reconcile works. Before designing anything, check here. Don't re-open an accepted decision without a new ADR that supersedes it.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-local-first-trust-model.md) | Local-first trust model with relational (peer-to-peer) discovery. Holonic promotion: see 0037. | Accepted |
| [0002](0002-consent-floor-vote-rule.md) | A vote passes when the average is ≥ 2.0 and fewer than 10% score 0 | Accepted |
| [0003](0003-three-tier-involvement-levels.md) | Three fixed involvement levels, checked through capabilities so per-group roles can come later | Accepted |
| [0004](0004-competing-versions-go-to-ballot.md) | Every competing version of an Atom goes on the ballot | Accepted |
| [0005](0005-pwa-client.md) | The client is an installable TypeScript web app (PWA) | Accepted |
| [0006](0006-signed-log-plus-crdt.md) | Governance is a signed, append-only log; draft text is a CRDT; only a passed tally moves the canonical Document | Accepted |
| [0007](0007-thin-python-relay.md) | A thin Python relay stores and forwards encrypted blobs by opaque mailbox id | Accepted |
| [0008](0008-passkeys-and-social-recovery.md) | Passkeys unlock a device key; recovery is social (member-chosen contacts); no platform sign-in | Accepted |
| [0009](0009-per-group-identities.md) | Separate identity per group, linked only by the member's choice | Accepted |
| [0010](0010-open-ballots-with-exit.md) | Open ballots within the group, backed by leave, remove, and split | Accepted |
| [0011](0011-debate-venues.md) | Groups link their own chat; coalitions get an optional Reconcile-hosted encrypted room | Accepted |
| [0012](0012-content-free-push.md) | Dispatches arrive by opt-in, content-free push | Accepted |
| [0013](0013-covenant-on-reach.md) | A founding covenant limits reach (discovery, coalitions, broadcast), not existence. Open source vs. closed is open | Accepted |
| [0014](0014-invite-and-vouch-admission.md) | Admission by invitation, vouches, and a 14-day wait; groups set their own rules | Accepted |
| [0015](0015-anti-capture.md) | Eligibility snapshots, entrenched and eternal Atoms, and split only by petition in extreme cases | Accepted |
| [0016](0016-suspend-then-vote.md) | Stewards can suspend for 7 days; only a vote removes | Accepted |
| [0017](0017-need-to-see-and-expiry.md) | Pseudonyms by default, no roster for followers (Members), ballots expire 30 days after the tally | Accepted |
| [0018](0018-device-protection-and-duress.md) | App lock, panic wipe, and an opt-in duress login that hides chosen groups | Accepted |
| [0019](0019-sealed-sender-relay.md) | The relay uses sealed sender, padding, and batching, and keeps no logs | Accepted |
| [0020](0020-us-nonprofit-zero-knowledge.md) | A US nonprofit that holds nothing readable; no client-side scanning | Accepted |
| [0021](0021-level-names-and-self-selection.md) | Levels are Member (follows), Collaborator (votes), and Co-Creator (votes and creates); moving up is self-selected | Accepted |
| [0022](0022-react-vite-react-aria.md) | React + Vite SPA, React Aria Components, styled from DESIGN.md; the engine stays framework-free | Accepted |
| [0023](0023-markdown-atoms.md) | Atom content is normalized CommonMark-subset Markdown with line diffs on ballots | Accepted |
| [0024](0024-source-available-license.md) | Source-available license (PolyForm Strict, pending legal review) plus a trademark | Accepted |
| [0025](0025-gift-economy.md) | A gift economy: platform gifts at the moment of reach; peer tips wait for a privacy and legal design | Accepted (direction) |
| [0026](0026-name-and-domain.md) | "Reconcile" as a distinctive mark; reconcile.earth proposed | Accepted |
| [0027](0027-supporters-and-coalition-tip-share.md) | Monthly group supporters, a coalition share of tips on reads it generated, and monthly cash-out; payer-anonymous rail required | Accepted (direction) |
| [0028](0028-relay-fastapi-sqlite.md) | The relay is FastAPI with SQLite (WAL), access logs off | Accepted |
| [0029](0029-install-first-indexeddb.md) | Install to the Home Screen before creating keys on iOS; keys and logs in IndexedDB | Accepted |
| [0030](0030-device-key-fallback.md) | Without passkey PRF, a non-extractable device key plus mandatory social recovery | Accepted |
| [0031](0031-yjs-working-copies.md) | Working Copies use Yjs behind an interface; frozen versions hash normalized text | Accepted |
| [0032](0032-github-private-hosting.md) | Code, issues, and CI live in a private GitHub repository | Accepted |
| [0033](0033-legal-entity-staging.md) | Founder-owned pilot, then a fiscal sponsor (to be chosen), then Reconcile's own 501(c)(3) | Accepted |
| [0034](0034-blind-credit-payment-rail.md) | Peer money moves as blind-signed credits; platform gifts use an ordinary processor; never Stripe Connect | Accepted (direction) |
| [0035](0035-reconcile-group-minimal-eternal-core.md) | Reconcile-the-group starts from a one-line eternal core; the rest is ratified by the first groups | Accepted |
| [0036](0036-coalition-each-group-passes.md) | Coalition motions pass group by group; only signed results cross group lines | Accepted |
| [0037](0037-holonic-promotion.md) | Each level decides; the author sets a ceiling; votes travel with the Dispatch on the voter's own device | Accepted |
| [0038](0038-optional-discovery.md) | Discovery is optional; groups can open a front door that never lists people | Accepted |
| [0039](0039-integrations-per-group-opt-in.md) | Bot reach and sight are a per-group ladder, nudge-only by default | Accepted |
| [0040](0040-group-opt-ins-are-governed.md) | Every group-level opt-in is decided by Proposal; widening is entrenched, narrowing is easy | Accepted |
| [0041](0041-digitalocean-relay-hosting.md) | The pilot relay runs on a DigitalOcean VM; we terminate TLS, logs off | Accepted |
| [0042](0042-broad-device-support.md) | iOS 16.4+, Android 10+, current desktop browsers; plain warnings on older devices | Accepted |
| [0043](0043-recovery-and-backup.md) | Recovery threshold chosen per person (default 3 of 5), a fixed 72-hour wait, and an encrypted relay backup unlocked by recovery | Accepted |
| [0044](0044-qr-device-linking.md) | A second device links by QR code; devices are listed and revocable | Accepted |
| [0045](0045-names-in-groups.md) | Names in a group are freely chosen and unique; changes show "formerly X" | Accepted |
| [0046](0046-padded-vault-and-panic-wipe.md) | A fixed-size padded vault from Phase 1, duress after external review; panic wipe by hold or opt-in wrong codes | Accepted |
| [0047](0047-ballot-cap-quorum-reproposals.md) | Three versions per ballot; missed quorum lapses; a 14-day cooldown and a 3-in-180-days cap on re-proposing | Accepted |
| [0048](0048-feed-surfacing.md) | Proposals drawing early enthusiasm rise in a locally computed feed; nothing is hidden | Accepted |
| [0049](0049-stewards-and-removal.md) | Two staggered 6-month stewards; removal at the entrenched bar without the target voting | Accepted |
| [0050](0050-splitting.md) | "Split," not "fork": 20% of voters within 14 days of a trigger, signatures sealed | Accepted |
| [0051](0051-dissolution-and-rule-classes.md) | Dissolution at the entrenched bar with read-only archives; which founding rules start entrenched | Accepted |
| [0052](0052-newcomer-onboarding.md) | Preview first; join provisionally with the inviter as first recovery contact; recovery complete before voting | Accepted |
| [0053](0053-multi-use-invites.md) | Invites are multi-use links (default up to 10) that expire in 48 hours | Accepted |
| [0054](0054-digest-notifications.md) | One daily digest (including votes closing soon); only recovery attempts notify immediately | Accepted |
| [0055](0055-accessibility-and-languages.md) | WCAG 2.2 AA with automated checks and periodic manual passes; English, translation-ready | Accepted |
| [0056](0056-pilot-plan.md) | The pilot: two contrasting groups for 6 weeks, learned through interviews and Signal, with a plain notice | Accepted |
| [0057](0057-environments-updates-retention.md) | Staging and production; protocol rules change only by version; blobs 30 days, backups 180 days | Accepted |
| [0058](0058-security-review-on-demand.md) | A paid security review when an activist group calls for it, booked at the first serious conversation | Accepted |
| [0059](0059-suspension-during-removal.md) | A suspension lasts until an open removal vote against the member ends | Accepted |
| [0060](0060-how-phase-1-is-built.md) | Agents build in waves; green merges (no separate human sign-off); main protected; label scheme | Accepted |
| [0061](0061-quality-gates.md) | Merge gates: TDD, check-all, pre-commit and CI on changes, review bot; mutation testing before a release | Accepted |
| [0062](0062-entity-and-sponsor-timing.md) | Stay on the 501(c)(3) path (a nonprofit-owned operating company once there's revenue); choose the sponsor after the pilot | Accepted |
| [0063](0063-money-rules.md) | Entrenched treasurer changes; 10% coalition share; pay-what-you-want platform fee; balances go to the payee; reach at the yearly M+R CPM | Accepted (direction) |

**Terminology (2026-11-07):** the member-initiated notification formerly called a "Push" is now a **Dispatch**. A proposed change formerly called a "Pitch" is now a **Proposal** (verb: *propose*); the log event is `proposal` and the capability is `propose`. "Pitch" survives only in references to the original pitch deck. The governance act once called a "fork" is a **split** (ADR-0050); "fork" now means only forking code.

New ADRs take the next number and record the context, decision, consequences, and open questions. When a decision comes from a `/decide` sheet, note the sheet and decision id.
