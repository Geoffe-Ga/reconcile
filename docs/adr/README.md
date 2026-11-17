# Architecture Decision Records

Settled decisions about how Reconcile works. Before designing anything, check here. Don't re-open an accepted decision without a new ADR that supersedes it.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-local-first-trust-model.md) | Local-first trust model with relational (peer-to-peer) discovery. Promotion (0037) stops at coalitions, with no Reconcile-wide broadcast (0071) | Accepted; amended by 0037, 0038, 0071 |
| [0002](0002-consent-floor-vote-rule.md) | A vote passes when the average is ≥ 2.0 and fewer than 10% score 0; a stand-aside counts toward quorum only (0065) | Accepted; amended by 0047, 0065 |
| [0003](0003-three-tier-involvement-levels.md) | Three fixed involvement levels, checked through capabilities so per-group roles can come later | Accepted; names superseded by 0021; amended by 0014, 0053 |
| [0004](0004-competing-versions-go-to-ballot.md) | Every competing version of an Atom goes on the ballot, up to 3 per ballot (0047) | Accepted; amended by 0047 |
| [0005](0005-pwa-client.md) | The client is an installable TypeScript web app (PWA) | Accepted |
| [0006](0006-signed-log-plus-crdt.md) | Governance is a signed, append-only log; draft text is a CRDT; only a passed tally moves the canonical Document | Accepted; amended by 0072 |
| [0007](0007-thin-python-relay.md) | A thin Python relay stores and forwards encrypted blobs by opaque mailbox id | Accepted |
| [0008](0008-passkeys-and-social-recovery.md) | Passkeys unlock a device key; recovery is social (member-chosen contacts); no platform sign-in | Accepted; amended 2026-11-08 |
| [0009](0009-per-group-identities.md) | Separate identity per group, linked only by the member's choice | Accepted |
| [0010](0010-open-ballots-with-exit.md) | Open ballots within the group, backed by leave, remove, and parting ways | Accepted; amended by 0066, 0068 |
| [0011](0011-debate-venues.md) | Groups link their own chat; coalitions get an optional Reconcile-hosted encrypted room | Accepted; amended by 0039, 0040 |
| [0012](0012-content-free-push.md) | Dispatches arrive by opt-in, content-free push | Accepted |
| [0013](0013-covenant-on-reach.md) | A founding covenant limits reach (discovery, coalitions, broadcast), not existence. The license question is settled by 0024 | Accepted; amended by 0024, 0035 |
| [0014](0014-invite-and-vouch-admission.md) | Admission by invitation, vouches, and a 14-day wait; groups set their own rules | Accepted |
| [0015](0015-anti-capture.md) | Eligibility snapshots, entrenched and eternal Atoms, and parting ways only by petition in extreme cases | Accepted; amended by 0068 |
| [0016](0016-suspend-then-vote.md) | Stewards can suspend for 7 days, longer while a removal vote is open (0059, at most 21 days); one suspension per steward, and a suspended member stays eligible; only a vote removes | Accepted; amended by 0059, 0075 |
| [0017](0017-need-to-see-and-expiry.md) | Pseudonyms by default, no roster for followers (Members), ballots and their notes expire 30 days after the tally; checkpoints keep the totals | Accepted; amended 2026-11-07, and by 0065 |
| [0018](0018-device-protection-and-duress.md) | App lock, panic wipe, and an opt-in duress login that hides chosen groups | Accepted |
| [0019](0019-sealed-sender-relay.md) | The relay uses sealed sender, padding, and batching, and keeps no logs | Accepted |
| [0020](0020-us-nonprofit-zero-knowledge.md) | A US nonprofit that holds nothing readable; no client-side scanning | Accepted; amended by 0033 |
| [0021](0021-level-names-and-self-selection.md) | Levels are Member (follows), Collaborator (votes), and Co-Creator (votes and creates); moving up is self-selected | Accepted |
| [0022](0022-react-vite-react-aria.md) | React + Vite SPA, React Aria Components, styled from DESIGN.md; the engine stays framework-free | Accepted |
| [0023](0023-markdown-atoms.md) | Atom content is normalized CommonMark-subset Markdown with line diffs on ballots | Accepted |
| [0024](0024-source-available-license.md) | Source-available license (PolyForm Strict, pending legal review) plus a trademark, with a grant to run unmodified relays and clients (0071) | Accepted; amended by 0071 |
| [0025](0025-gift-economy.md) | A gift economy: platform gifts at the moment of reach, anchored to Reconcile's running cost (0070); peer tips use blind-signed credits (0034) and wait on counsel and a licensed partner | Accepted (direction); amended by 0034, 0070 |
| [0026](0026-name-and-domain.md) | "Reconcile" as a distinctive mark; reconcile.earth proposed | Accepted |
| [0027](0027-supporters-and-coalition-tip-share.md) | Monthly supporters for groups and coalitions, and monthly cash-out; payer-anonymous rail required. The per-read coalition tip share is withdrawn (0070) | Accepted (direction); amended by 0034, 0040, 0070 |
| [0028](0028-relay-fastapi-sqlite.md) | The relay is FastAPI with SQLite (WAL), access logs off | Accepted |
| [0029](0029-install-first-indexeddb.md) | Install to the Home Screen before creating keys on iOS; keys and logs in IndexedDB | Accepted |
| [0030](0030-device-key-fallback.md) | Without passkey PRF, a non-extractable device key plus mandatory social recovery | Accepted |
| [0031](0031-yjs-working-copies.md) | Working Copies use Yjs behind an interface; frozen versions hash normalized text | Accepted |
| [0032](0032-github-private-hosting.md) | Code, issues, and CI live in a private GitHub repository | Accepted; amended 2026-11-08 |
| [0033](0033-legal-entity-staging.md) | Founder-owned pilot, then a fiscal sponsor (to be chosen), then Reconcile's own 501(c)(3) | Accepted |
| [0034](0034-blind-credit-payment-rail.md) | Peer money moves as blind-signed credits; platform gifts use an ordinary processor; never Stripe Connect | Accepted (direction) |
| [0035](0035-reconcile-group-minimal-eternal-core.md) | Reconcile-the-group starts from a short eternal core, its wording settled before genesis; the rest is ratified by the first groups | Accepted; amended 2026-11-08 |
| [0036](0036-coalition-each-group-passes.md) | Coalition motions pass group by group; only signed results cross group lines | Accepted |
| [0037](0037-holonic-promotion.md) | Each level decides; the author sets a ceiling, at most the coalitions (0071); votes travel with the Dispatch on the voter's own device | Accepted; amended by 0065, 0070, 0071 |
| [0038](0038-optional-discovery.md) | Discovery is optional; groups can open a front door that never lists people, and that closes when a membership ends (#288) | Accepted; amended 2026-11-12 (#288), and by 0077 |
| [0039](0039-integrations-per-group-opt-in.md) | Bot reach and sight are a per-group ladder, nudge-only by default | Accepted |
| [0040](0040-group-opt-ins-are-governed.md) | Every group-level opt-in is decided by Proposal; widening is entrenched, narrowing is easy | Accepted |
| [0041](0041-digitalocean-relay-hosting.md) | The pilot relay runs on a DigitalOcean VM; we terminate TLS, logs off. The MVP runs it as a systemd service, not a container, until it needs another host | Accepted; amended 2026-11-09 |
| [0042](0042-broad-device-support.md) | iOS 16.4+, Android 10+, current desktop browsers; plain warnings on older devices | Accepted |
| [0043](0043-recovery-and-backup.md) | Recovery threshold chosen per person (default 3 of 5), a fixed 72-hour wait, and an encrypted relay backup unlocked by recovery | Accepted; amended by 0072 |
| [0044](0044-qr-device-linking.md) | A second device links by QR code; devices are listed and revocable | Accepted |
| [0045](0045-names-in-groups.md) | Names in a group are freely chosen and unique; changes show "formerly X" | Accepted |
| [0046](0046-padded-vault-and-panic-wipe.md) | A fixed-size padded vault from Phase 1, duress after external review; panic wipe by hold or opt-in wrong codes | Accepted |
| [0047](0047-ballot-cap-quorum-reproposals.md) | Three versions per ballot; missed quorum lapses; a 14-day cooldown and a 3-in-180-days cap on re-proposing failed content (lapses don't count, 0069) | Accepted; amended by 0069 |
| [0048](0048-feed-surfacing.md) | Proposals drawing early enthusiasm rise in the Rising tab; the default Quiet tab puts the least heard first (0064); nothing is hidden | Accepted; amended by 0064 |
| [0049](0049-stewards-and-removal.md) | Two staggered 6-month stewards; removal by a fixed 14-day vote at average ≥ 3.0 with at most one 0 or under 5% zeros, without the target voting | Accepted; amended by 0066, 0067, 0072, 0075 |
| [0050](0050-splitting.md) | Parting ways (named "split" here), not "fork": 20% of voters within 14 days of a trigger, signatures sealed | Accepted; amended by 0068 |
| [0051](0051-dissolution-and-rule-classes.md) | Dissolution at the entrenched bar with read-only archives; which founding rules start entrenched | Accepted; amended by 0072, 2026-11-09, 2026-11-11 (#231: restored copies read only until they hear from the group), and 2026-11-13 (#232: a dissolved group's mailboxes expire; nothing deletes them) |
| [0052](0052-newcomer-onboarding.md) | Preview first; join provisionally with the inviter as first recovery contact; recovery complete before voting | Accepted |
| [0053](0053-multi-use-invites.md) | Invites are multi-use links (default up to 10) that expire in 48 hours | Accepted |
| [0054](0054-digest-notifications.md) | One daily digest (including votes closing soon); only recovery attempts notify immediately | Accepted; amended by 0072 |
| [0055](0055-accessibility-and-languages.md) | WCAG 2.2 AA with automated checks and periodic manual passes; English, translation-ready | Accepted; amended by 0068 |
| [0056](0056-pilot-plan.md) | The pilot: two contrasting groups for 6 weeks, learned through interviews (relationships included) and Signal, with a plain notice | Accepted; amended by 0069 |
| [0057](0057-environments-updates-retention.md) | Staging and production; protocol rules change only by version; blobs 30 days, backups 180 days; a group's invite carries the log of each coalition it reaches, so a newcomer reads one older than 30 days (2026-11-13) | Accepted; amended by 0072 |
| [0058](0058-security-review-on-demand.md) | A paid security review when an activist group calls for it, booked at the first serious conversation | Accepted |
| [0059](0059-suspension-during-removal.md) | A suspension lasts until an open removal vote against the member ends (at most 21 days, since removal votes run 14) | Accepted; amended by 0075 |
| [0060](0060-how-phase-1-is-built.md) | Agents build in waves; green merges (no separate human sign-off); main protected; label scheme | Accepted; amended by 0075 |
| [0061](0061-quality-gates.md) | Merge gates: TDD, check-all, pre-commit and CI on changes, review bot; mutation testing before a release | Accepted |
| [0062](0062-entity-and-sponsor-timing.md) | Stay on the 501(c)(3) path (a nonprofit-owned operating company once there's revenue); choose the sponsor after the pilot | Accepted |
| [0063](0063-money-rules.md) | Entrenched treasurer changes; pay-what-you-want platform fee; balances go to the payee. The 10% coalition share and the M+R CPM anchor are withdrawn (0070) | Accepted (direction); amended by 0070 |
| [0064](0064-feed-tabs-quiet-and-rising.md) | Two feed tabs: Quiet (least heard, the default) and Rising (enthusiasm) | Accepted |
| [0065](0065-stand-aside-and-ballot-notes.md) | Ballots can stand aside; any score can carry a short note; notes expire with ballots | Accepted; amended by 0072 |
| [0066](0066-readmission.md) | A removed person can return by an ordinary `readmit` Proposal plus fresh vouches | Accepted; amended by 0072 |
| [0067](0067-genesis-templates.md) | Genesis templates (Circle, Fellowship, Chapter) preset rules; privacy floors fixed | Accepted; amended by 0072 |
| [0068](0068-part-ways.md) | "Part ways," not "split"; numbers unchanged; a closing note and a shared-Atoms coalition offer | Accepted |
| [0069](0069-lapses-celebration-relational-pilot.md) | Lapses aren't failures; passes are celebrated quietly; the pilot asks about relationships | Accepted |
| [0070](0070-patronage-not-attention.md) | No per-read coalition share; gifts anchored to Reconcile's running cost | Accepted (direction) |
| [0071](0071-self-hosting-and-reach.md) | A license grant to run unmodified relays and clients; promotion stops at coalitions | Accepted |
| [0072](0072-protocol-details-for-decomposition.md) | Protocol details settled during decomposition: causal time, length caps, expiring sensitive text, re-open and readmit binding, `dissolve` target, backup endpoint, generic lock-screen text | Accepted; amended 2026-11-09 |
| [0073](0073-mvp-scope.md) | MVP scope: build the simple loop first. Defers parts of 42 ADRs until pilot feedback asks, and 0041's container until the relay needs another host | Accepted; amended by 0074, and 2026-11-09 |
| [0074](0074-mvp-scope-revised.md) | MVP scope revised: each feature at the founder's chosen depth, with Phase 2 coalitions in | Accepted; amended by 0075 and 0077 |
| [0075](0075-safeguards-for-the-revised-mvp.md) | Safeguards for the revised MVP: coalition seats, push linkage, steward limits, recovery; a key change whose wraps don't open is refused, and its author may write no other (2026-11-11); a room wrap counts only when it holds the `inner` the coalition's genesis commits to (2026-11-12); one person's latest choice of recovery contacts wins on every device (2026-11-12, #272); a device that leaves or is removed takes its push address back within the day, not at the key change (2026-11-12, #356); each group shifts a coalition motion's nudges by its own offset (2026-11-12, #284); a release carries a second number, and the new device asks before restoring (2026-11-14, #398) | Accepted; amended 2026-11-11, 2026-11-12, 2026-11-14 |
| [0076](0076-merge-recap-to-discord.md) | Merge recaps send only metadata, PR titles included, to a private Discord channel; the bot token runs merged code | Accepted (tooling) |
| [0077](0077-discover.md) | Discover: a public shelf of single Dispatches, each published by its own vote; Ask to join through open front doors; personal Documents sealed into an application; an on-device strange-bedfellows view; doors take reconcile cards; a bottom tab bar | Accepted; shelf publishing waits on 0035's wording and a spike; amended by 0079 |
| [0078](0078-landing-page-and-painted-edges.md) | The landing page is the first step of first run, storing nothing; some screens show a few pixels of the painting at their edges, and focus screens stay plain | Accepted |
| [0079](0079-bedfellows-algorithm.md) | Bedfellows matches sentence-level claims with a small on-device embedding model, checks stance and leaves opposed pairs out, stretches on a slow clock with a dial, keeps a sealed 30-day history, and quotes the shared claim as its reason | Accepted; thresholds provisional until its evaluation passes |

**Status column:** "amended by 00NN" means a later ADR changed part of the decision, and the ADR's own file says what changed. A date means the ADR was amended in place, with no ADR of its own. Each one-liner describes the decision as amended.

**MVP depth:** [ADR-0073](0073-mvp-scope.md), as amended by [ADR-0074](0074-mvp-scope-revised.md) and [ADR-0075](0075-safeguards-for-the-revised-mvp.md), sets how much of each decision the MVP builds. An ADR's **MVP** line says when part of it is deferred.

**Terminology (2026-11-08):** the governance exit formerly called a "split" is now **parting ways** (`part-ways-petition`, [ADR-0068](0068-part-ways.md)); ADRs before 0068 still say "split".

**Terminology (2026-11-07):** the member-initiated notification formerly called a "Push" is now a **Dispatch**. A proposed change formerly called a "Pitch" is now a **Proposal** (verb: *propose*); the log event is `proposal` and the capability is `propose`. "Pitch" survives only in references to the original pitch deck. The governance act once called a "fork" is a **split** (ADR-0050); "fork" now means only forking code.

New ADRs take the next number and record the context, decision, consequences, and open questions. When a decision comes from a `/decide` sheet, note the sheet and decision id.
