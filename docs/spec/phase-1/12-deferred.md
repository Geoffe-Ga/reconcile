## 12. Deferred

Each item here waits for pilot feedback, and returns only through a new ADR that lifts it (ADR-0073). These are the items ADR-0074 still lists as deferred:

- **The roster hidden from Members** ([ADR-0017](../../adr/0017-need-to-see-and-expiry.md), [ADR-0072](../../adr/0072-protocol-details-for-decomposition.md) item 12). Until it returns, every level can read the roster, ballots and vouches (ADR-0075 §5).
- **Invite caps, revocation and QR invites** ([ADR-0053](../../adr/0053-multi-use-invites.md), [ADR-0014](../../adr/0014-invite-and-vouch-admission.md)). A link admits anyone while its envelope lives on the relay.
- **The older-device notice** ([ADR-0042](../../adr/0042-broad-device-support.md)).
- **App lock, the padded vault, panic wipe and duress** ([ADR-0018](../../adr/0018-device-protection-and-duress.md), [ADR-0046](../../adr/0046-padded-vault-and-panic-wipe.md)). The phone's own lock and Erase Reconcile from this device stand in. Duress will need a storage migration.
- **Derived identities and link-reveal** ([ADR-0009](../../adr/0009-per-group-identities.md)). Independent random keys per group stand in.
- **Genesis templates, and rules changes beyond the opt-ins** ([ADR-0067](../../adr/0067-genesis-templates.md), [ADR-0051](../../adr/0051-dissolution-and-rule-classes.md)): the Circle and Chapter templates, the Circle-to-Fellowship switch, rule provenance, and tuning any other rule by vote. When it returns, the switch is the one rule change that skips the `rules-change` Proposal loop, and that's deliberate: every device derives it from the log when a Circle reaches 10 voting members, and it leaves alone every rule a Proposal set ([ADR-0051](../../adr/0051-dissolution-and-rule-classes.md)'s 2026-11-09 amendment).
- **Readmission and parting ways** ([ADR-0066](../../adr/0066-readmission.md), [ADR-0050](../../adr/0050-splitting.md), [ADR-0068](../../adr/0068-part-ways.md)): the `readmit` target and the `part-ways-petition` event. Copy as Markdown into a fresh group stands in.
- **Re-proposal cooldowns and caps** ([ADR-0047](../../adr/0047-ballot-cap-quorum-reproposals.md), [ADR-0069](../../adr/0069-lapses-celebration-relational-pilot.md)): the 14-day cooldown after a failure, the 3-in-180-days cap, the per-person open cap, and re-opens with twice the window. One open Proposal per Atom stands in.
- **Stand-aside and per-version notes** ([ADR-0065](../../adr/0065-stand-aside-and-ballot-notes.md)). One note per ballot stands in.
- **The daily digest and scheduled Dispatches** ([ADR-0054](../../adr/0054-digest-notifications.md), [ADR-0012](../../adr/0012-content-free-push.md)). Needs your vote and opt-in push stand in.
- **The Quiet and Rising tabs** ([ADR-0064](../../adr/0064-feed-tabs-quiet-and-rising.md), [ADR-0048](../../adr/0048-feed-surfacing.md)). One list stands in.
- **Shared CRDT drafts, CodeMirror and line diffs** ([ADR-0006](../../adr/0006-signed-log-plus-crdt.md), [ADR-0031](../../adr/0031-yjs-working-copies.md), [ADR-0023](../../adr/0023-markdown-atoms.md)): Yjs Working Copies with shareable URLs. Private drafts and word diffs stand in.
- **The binary encoding** ([ADR-0006](../../adr/0006-signed-log-plus-crdt.md), [ADR-0072](../../adr/0072-protocol-details-for-decomposition.md) items 1–2): CBOR, BLAKE3, `prev` links, Lamport order, the author-time floor, and `tally` and `checkpoint` events. Signed JSON in relay order stands in.
- **The Python reference implementation** ([ADR-0007](../../adr/0007-thin-python-relay.md), [ADR-0060](../../adr/0060-how-phase-1-is-built.md), ADR-0075 §6): a Python validator and tally sharing test vectors with the client. The TypeScript engine and its golden vectors stand in.
- **Unique names** ([ADR-0045](../../adr/0045-names-in-groups.md)): renames, "formerly X" and lookalike detection. Key suffixes stand in.
- **Per-member mailboxes and delivery jitter** ([ADR-0019](../../adr/0019-sealed-sender-relay.md)). One mailbox per group, rotating weekly after #110, stands in.
- **Staging and production, and WebSockets** ([ADR-0057](../../adr/0057-environments-updates-retention.md), [ADR-0028](../../adr/0028-relay-fastapi-sqlite.md)): CI deploys and the staging smoke run. One VM and polling stand in. The update prompt is back as one line, "A new version is ready. Close and reopen Reconcile." (§8, #513; ADR-0073's 2026-11-19 amendment).

ADR-0074's clarifications and ADR-0073's table also leave these out:

- ADR-0030's non-extractable device key and mandatory recovery, and [ADR-0052](../../adr/0052-newcomer-onboarding.md)'s recovery before voting.
- Expiring the text of removal Proposals and suspension reasons (ADR-0072 item 5), and lowering a promotion ceiling once voting opens ([ADR-0037](../../adr/0037-holonic-promotion.md)).
- Reconcile-the-group, the covenant ([ADR-0013](../../adr/0013-covenant-on-reach.md)) and Reconcile-wide broadcast, so nothing waits on the eternal core's wording ([ADR-0035](../../adr/0035-reconcile-group-minimal-eternal-core.md)).
- An ICU message library (ADR-0055), the rejected-events view, and a choice of relay.
- Proposals that span several Atoms, editing a Document's title, and export formats other than Markdown (#75).
- The gift prompt and money ([ADR-0025](../../adr/0025-gift-economy.md), [ADR-0063](../../adr/0063-money-rules.md)), which belong to Phase 3.
