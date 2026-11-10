# ADR-0075: Safeguards for the Revised MVP

- **Status:** Accepted (2026-11-09)
- **Date:** 2026-11-09
- **Decided via:** a review of the 57-issue backlog against ADR-0074 and the threat model ([`12_Security_Privacy_Threat_Model.md`](../plan/12_Security_Privacy_Threat_Model.md)). Most findings came from two issues interacting, not from either one alone. The issue edits are drafted in [`plans/2026-11-09-adr-0075-issue-edits.md`](../../plans/2026-11-09-adr-0075-issue-edits.md).
- **Founder's answers (2026-11-09):** on removal, "With <= 21 people, a zero is non-blocking" (§3). On merge safeguards, "No merge safeguard. We're ai engineering this" (§6).
- **Amends:** [ADR-0074](0074-mvp-scope-revised.md), plus [ADR-0060](0060-how-phase-1-is-built.md)'s library rule (§4) and its list of safeguards (§6). §3's steward rules amend [ADR-0016](0016-suspend-then-vote.md) (a suspension never shrinks the electorate; one at a time), [ADR-0049](0049-stewards-and-removal.md) (the removal bar, a fixed 14-day removal vote, one count of voting members) and [ADR-0059](0059-suspension-during-removal.md) (an extended suspension lasts at most 21 days). Nothing is superseded.

## Context

ADR-0074 brought back coalitions, stewards, push and recovery. Each issue builds its feature to the depth ADR-0074 sets. Taken together, though, they open paths that no ADR accepts:

- A seat secret lets one person speak for their whole group in a coalition.
- One push address ties a phone's groups together at the relay.
- A steward can shrink the electorate.
- Recovery's 72-hour wait binds only honest contacts.

Each item below is marked **Fix** (a rule the issues build) or **Accept** (a pilot risk, named so the outside review, [ADR-0058](0058-security-review-on-demand.md), covers it).

## Decision

### 1. Coalition seats

Every member of a group, at any level, can read its log. So the group's coalition seat secret is held by all of them, by anyone who opened one of its invite links while the link was live, and by anyone who has since left or been removed, because seats don't rotate. ADR-0074's accepted risk named only the last group.

- **Fix: promotion needs the origin group's own result.** A `promote` motion doesn't record `from` as passed. `from`'s result arrives as an ordinary `group-result`. `resultsToReport` reports `pass` only when the group's own fold holds a passed Dispatch Proposal with the same id, title, text and ceiling, and reports `fail` otherwise. A forged or altered record is therefore blocked. The motion still opens no new vote in `from`'s groups.
- **Fix: a coalition speaks only through passed motions.** Coalition Dispatches ride only on a passed coalition motion. A seat-bound participant can't send one directly. ADR-0074's "sent by a Co-Creator" applies to groups.
- **Accept: one seat-secret holder can block.** Anyone holding a seat secret can make their group's result count as a fail on any motion. For coalitions of 4 groups or fewer, that is a standing veto.
  - The pilot's remedy is the one ADR-0073 gives groups: the groups reconcile again into a fresh coalition, with new secrets, and carry its Documents across with Copy as Markdown.
  - `resultMismatches` shows the group when it happens.
- **Accept: seat-secret holders can act in the coalition.** They can join, open motions and post in the coalition room. Motions still need every group, or two-thirds of them, to pass.
- **Revisit** before the outside review, or the first time a pilot coalition is blocked by a contested seat: wrap seat secrets only to voting members, and rotate them with the group key.

### 2. Push and polling

- **Accept and disclose: push links a phone's groups.**
  - A device has one push address. The relay stores it under the mailbox of every group and coalition where push is on, including weekly mailboxes up to 30 days ahead.
  - So the relay's database shows which groups and coalitions one phone is in. With Apple's or Google's help, it can also tie that phone to a person. It also links a group's weekly mailboxes, which undoes [ADR-0019](0019-sealed-sender-relay.md)'s rotation for that group.
  - Push stays off by default, one switch per group. The switch's disclosure says this in plain words before anything is sent.
- **Accept: polling links a phone's groups live.** A device polls all its groups' mailboxes from one IP address every few seconds. Whoever watches the relay live can tie those groups together. Weekly mailboxes protect stored data, not a live watcher. The pilot notice already says the relay sees which mailboxes a device checks. This ADR records the risk so the outside review covers it.
- **Revisit** before groups outside the founder's circle use the app: a separate push address per group, if browsers support it in installed iOS apps, or no push for a group that asks for none.

### 3. Stewards

These rules close the capture paths a steward's powers open ([ADR-0015](0015-anti-capture.md), [ADR-0016](0016-suspend-then-vote.md), [ADR-0049](0049-stewards-and-removal.md), [ADR-0059](0059-suspension-during-removal.md)):

- **Fix: a suspension never shrinks the electorate.** A Proposal's eligible set ignores suspensions. A suspended member stays eligible on Proposals that open during the suspension, and counts toward quorum and early close. They can vote on those Proposals once the suspension ends, if the vote is still open.
- **Fix: one suspension at a time.** Each steward holds at most one active suspension. A steward facing an open recall can't suspend or narrow.
- **Fix: the 30-day guard runs from a suspension's end, not its start.**
- **Fix: a single 0 never blocks a removal.**
  - A removal passes at an average of at least 3.0, with either at most one 0 or fewer than 5% zeros: `sum ≥ 3·n` and (`zeros ≤ 1` or `20·zeros < n`).
  - The 5% rule alone would let one 0 block whenever 20 or fewer people score, which in a pilot group means one ally of the person could always block. Two or more 0s still block in a small group, and so does the average.
  - The entrenched bar for everything else (dissolution, widening an opt-in, entrenched sections) is unchanged.
- **Fix: removal votes run a fixed 14 days.** They use the entrenched default with no proposer-set window. A suspension that ADR-0059 extends therefore lasts at most 21 days in total.
- **Fix: narrowing goes to a vote, as [ADR-0040](0040-group-opt-ins-are-governed.md) says.**
  - A steward's `narrow` is valid only alongside an open off-Proposal for that opt-in, authored by the same steward. It lasts until that Proposal closes.
  - Once the group turns such a Proposal down, no steward can narrow that opt-in again for 30 days.
- **Fix: one count of "voting members".** ADR-0049's thresholds (the first election at 3, the second seat at 6) and [ADR-0014](0014-invite-and-vouch-admission.md)'s bootstrap all count the same people: those holding voting rights, whatever level they chose. A person holds voting rights if they were admitted under the bootstrap, or were vouched for and have passed the wait.

### 4. Recovery

- **Accept: colluding contacts can skip the wait.**
  - Enough colluding contacts (t of them) can rebuild the backup key and fetch the relay backup with no wait, alert or cancel, because those run on the contacts' own devices.
  - What the 72-hour wait does protect against is someone impersonating the person to honest contacts.
  - The picker says: "Pick people you'd trust with all your groups at once."
  - **Revisit** before the outside review: a relay-held release, where the backup fetch opens only 72 hours after a request that the person's devices see and can cancel.
- **Fix: record the rule #118 builds.** Each contact's device runs the wait in relay time, from the relay's receipt of that contact's alert. The person's devices hear of it through the groups they share with each contact.
- **Fix: restored devices keep recovery working.** The random backup key travels in the passphrase backup file and the second-device link bundle. Both already hold every group's keys. A restored or linked device can therefore keep the relay backup fresh.
- **Fix: one library beyond `@noble/*`.** This amends ADR-0060's "audited libraries only (`@noble/*`)".
  - It allows one more library, `shamir-secret-sharing`, pinned exactly and imported only by `client/src/crypto/shares.ts`.
  - The PR that adds it links a published third-party audit of that version. If there isn't one, the work stops and asks.
- **Disclose ([ADR-0009](0009-per-group-identities.md)): one contact in two groups links your names.** If someone picks the same person as a contact in two groups, that person can tell both names belong to one person. The picker says so.

### 5. Smaller rules

- **Narrowing exposure is ordinary (ADR-0040).**
  - `isWider` compares only what outsiders can see or reach: whether a front door is open and whether it shows a count, and for the chat bot, off to on.
  - These are therefore ordinary changes: rotating a front door's keys, turning its count off, and replacing one Discord webhook with another. A group cuts off someone who left with the old URL by replacing the webhook.
- **Following a coalition posts nothing.** A follower reads the coalition and gets its Dispatches, but writes no `join`, so followers can't see each other. Followers can read which member group each participant came from, and the follow link says so.
- **A dissolved archive keeps time on the device.**
  - After `dissolve`, no relay time arrives. Each device clears the archive's ballots and notes 30 days after the dissolve's receipt, by its own clock, and keeps the outcomes and totals from its own tally. The wipe delay uses the same clock.
  - This is the one place device time decides anything.
- **Members can read ballots and vouches.** Members hold the group secret, so they can read everything a voting member can. [ADR-0010](0010-open-ballots-with-exit.md)'s "Members see only the result" returns together with the hidden roster ([ADR-0072](0072-protocol-details-for-decomposition.md) §12), which stays deferred.

### 6. Merge safeguards

ADR-0060 let security-critical code merge on green, partly because a Python and a TypeScript implementation had to pass shared test vectors. ADR-0073 removed the Python implementation.

- **Decided: nothing replaces that safeguard.** The project is built by AI agents, and security-critical code keeps merging on green under ADR-0061's gates.
- **What remains:**
  - the review bot;
  - CI's security scans;
  - audited libraries only: `@noble/*`, plus §4's Shamir library;
  - the golden vectors beside the TypeScript engine.
- The outside review (ADR-0058) is still due before groups outside the founder's circle use the app.

### Accepted pilot risks added

These add to ADR-0073's and ADR-0074's lists, and the outside review covers them:
- Anyone holding a seat secret can block a coalition motion or act in the coalition (§1).
- Push and polling show the relay which groups and coalitions share a phone (§2).
- Enough colluding recovery contacts can restore someone's groups without the wait (§4).

## Consequences

- 37 issues change, most by a sentence or two. The drafts are in [`plans/2026-11-09-adr-0075-issue-edits.md`](../../plans/2026-11-09-adr-0075-issue-edits.md). Two of the changes fix bugs whatever this ADR decides: #118's release blob, which the relay would refuse, and #126's promotion record, which can be forged.
- The foundation issues (#69–#78) still list as deferred some features ADR-0074 restored. The same plan file points each one at the issue that now builds it.
- Each **Revisit** item becomes a `blocked` issue with its trigger, so it lives in more than this ADR.

## Open Questions

None. The founder answered both on 2026-11-09 (§3 and §6).
