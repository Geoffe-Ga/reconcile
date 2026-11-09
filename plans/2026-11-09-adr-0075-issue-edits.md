# Issue Edits for ADR-0075

These are the edits made to GitHub issues following [ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) and the 2026-11-09 backlog review.

**Status:** applied on 2026-11-09, after the founder accepted ADR-0075. Each issue was re-fetched and checked after saving. A few follow-up fixes found while applying them are listed at the end. This file stays as the record of what changed and why.

**How to read this:**
- **Replace** quotes the current issue text exactly, then gives the new text.
- **Add** names where the new text goes.
- The anchors in sections A–D come from each issue's full body, read on 2026-11-09.
- Section E's anchors come from the review agents' quotes. Check each against the issue before applying it.

---

## A. Bugs

### #118: recover with your contacts after a 72-hour wait

1. **The release blob is never padded, so the relay refuses it.** #62 accepts only 1, 4, 16 or 64 KiB blobs.
   - Replace: "the device PUTs `sealTo(E_R, JSON {split, t, n, share}, "reconcile/v1/recovery-release", requestMailboxId)` to the request mailbox with `ttl_days=7`."
   - With: "the device builds `sealTo(E_R, JSON {split, t, n, share}, "reconcile/v1/recovery-release", requestMailboxId)`, seals it with M2-02's `Seal` under `hkdf(sha256, r, empty salt, "reconcile/v1/recovery-seal", 32)` so the blob is one of the four bucket sizes, and PUTs it to the request mailbox with `ttl_days=7`. The new device opens the `Seal` first, then the box."
   - Add to Acceptance Criteria: "Every blob a contact PUTs to the request mailbox is exactly 1,024, 4,096, 16,384 or 65,536 bytes, and `fakeRelay` enforces #62's size check in this test."
2. **The HKDF call lacks parameters.**
   - Replace: "It polls the mailbox `hkdf(r, "reconcile/v1/recovery-mailbox")` for released shares."
   - With: "It polls the mailbox whose id is the unpadded base64url of `hkdf(sha256, r, empty salt, "reconcile/v1/recovery-mailbox", 32)` for released shares."
3. **The push rule contradicts itself.** The Output Format wakes devices with the wake flag, but the Constraints exclude that push.
   - Replace: "**Not in this issue:** a push that wakes the person's devices for the alert (#99 is the place for it), and the device list and revocation (deferred, ADR-0074)."
   - With: "**Not in this issue:** the device list and revocation (deferred, ADR-0074)."
4. **The issue cites ADR-0074 for a rule ADR-0074 doesn't contain.**
   - Replace: "Per ADR-0074 (MVP scope, revised), the wait runs on the contact's side in relay time, and the person's devices are reached through the groups they share with each contact."
   - With: "Per ADR-0075 §4, the wait runs on the contact's side in relay time, and the person's devices are reached through the groups they share with each contact. Contacts who collude can skip it, an accepted pilot risk."
5. **The input to `sixDigits` is unclear.** Here it receives a 32-byte SHA-256 hash. State which bytes it reads, and make that identical to #96's definition.

### #126: Dispatches rise through coalitions by vote

**A promote record can be forged** (ADR-0075 §1).
- Replace: "It records `from` as `pass` at once, so the motion doesn't open in `from`'s groups."
- With: "It opens no new vote in `from`'s groups. `from`'s result arrives as an ordinary `group-result`. `resultsToReport` reports `pass` only when the group's own fold holds a passed `dispatch` Proposal with this id, title, text and ceiling, and reports `fail` otherwise, so a forged or altered record fails (ADR-0075 §1)."
- Add to the Acceptance Criteria vectors: "A promote record whose text differs from the passed Dispatch gets `fail` from the origin group and doesn't pass. A promote for a Dispatch the group never passed fails. Removing the check in `resultsToReport` makes both vectors fail (recorded in the PR)."

---

## B. Rules from ADR-0075

### #90: three involvement levels (§3)

- Replace: "A Proposal's `eligible` set becomes the members for whom `can(state, m, 'vote')` holds when it opens."
- With: "A Proposal's `eligible` set becomes the members whose level and voting rights would grant `vote` when it opens, with suspensions ignored. A suspended member stays eligible and can vote once their suspension ends, if the vote is still open (ADR-0075 §3). Put this in one helper, `wouldVote(state, m)`, that #102 doesn't override."
- Add to Acceptance Criteria: "Vector: a member suspended when a Proposal opens is in its `eligible` set. Their ballot during the suspension is ignored, and their ballot after it lapses, before the deadline, counts."

### #101: vouches and a 14-day wait (§3)

- Add to Output Format: "Export the count that ends the bootstrap as `votingRightsCount(state)`: people holding voting rights, whatever level they chose. #102 uses it for steward thresholds (ADR-0075 §3)."

### #102: stewards and a 7-day suspension (§3, plus a wrong claim)

1. **Seat thresholds.**
   - Replace: "seat 2, which can be filled once the group has 6 voting members (members holding `vote`)."
   - With: "seat 2, which can be filled once the group has 6 voting members, counted by #101's `votingRightsCount` (ADR-0075 §3)."
2. **Suspension validity.**
   - Replace: "and the target's last suspension began more than 30 days earlier, so stewards can't chain suspensions into a longer one (ADR-0059)."
   - With: "the target's last suspension ended more than 30 days earlier, the author holds no other active suspension, and no recall against the author is open (ADR-0059, ADR-0075 §3)."
3. **Suspension and eligibility.** Add under Suspension: "The target stays in the `eligible` set of Proposals that open during the suspension (#90's `wouldVote`), so a suspension never shrinks the electorate."
4. **Wrong claim.**
   - Replace: "Expiring the reason is #111's."
   - With: "The reason stays in the signed log. Expiring it stays deferred (ADR-0074)."
5. Add to Acceptance Criteria: "Suspension vectors also ignore a second active suspension by the same steward, and a `suspend` from a steward facing an open recall. A suspension 25 days after the previous one ended is ignored, and one 31 days after it is accepted."

### #106: the proposer sets the voting window (§3)

- Add: "A `remove` target ignores `window` and always runs 14 days (ADR-0075 §3)."

### #115: removal by vote (§3, plus wrong claims)

1. **The bar: a single 0 never blocks a removal** (ADR-0075 §3).
   - Replace: "The target isn't eligible, or their own 0 could block it in a group of 9 or fewer."
   - With: "The target isn't eligible, so their own score never counts. Per ADR-0075 §3, removal has its own bar: an average of at least 3.0, with at most one 0 or fewer than 5% zeros."
   - Add under Output Format: "**Bar.** A removal version passes when `sum ≥ 3·n` and either `zeros ≤ 1` or `20·zeros < n`, with integers only. Add it to #94's bars as `removal`, and have `targetClass()` return it for a `remove` target. Every other entrenched target keeps the entrenched bar."
   - Replace: "with the line \"This needs a higher bar: an average of at least 3.0 and fewer than 5% zeros."
   - With: "with the line \"This needs a higher bar: an average of at least 3.0, and no more than one 0 unless fewer than 5% scored 0."
   - Add to Acceptance Criteria: "Bar vectors: 20 scorers with one 0 and an average of at least 3.0 pass. 10 scorers with two 0s fail. 41 scorers with two 0s and an average of at least 3.0 pass. A dissolve with 20 scorers and one 0 still fails, because the entrenched bar is unchanged. Dropping the one-zero allowance makes the 20-scorer vector fail (recorded in the PR)."
2. **Expiry promise.**
   - Replace: "and #111 expires them with the ballots."
   - With: "#111 expires the response with the ballots. The title and justification stay in the signed log, because expiring them stays deferred (ADR-0074)."
3. **Fixed window.**
   - Replace: "`proposal {target: {kind: 'remove', member}, title, why, window?}`."
   - With: "`proposal {target: {kind: 'remove', member}, title, why}`. It always runs the entrenched default of 14 days, and the fold ignores a `window` on it, so a suspension it extends lasts at most 21 days in total (ADR-0075 §3)."
   - Replace: "opens `RemovalComposer` (title, why, window)"
   - With: "opens `RemovalComposer` (title, why)"
4. **Capability map.**
   - Replace: "Add `'propose-removal'` to the Collaborator set, which Co-Creators inherit."
   - With: "Add `'propose-removal'` to both the Collaborator and Co-Creator lists in #90's map, since the lists are flat."
5. **Constraints.**
   - Replace: "the rotation itself (#98) and expiring the removal's text (#111)."
   - With: "the rotation itself (#98) and expiring the response (#111). Expiring the title and justification stays deferred (ADR-0074)."

### #117: group opt-ins decided by Proposal (§3, §5)

1. **Widening.**
   - Replace: "A change to anything but off widens, and a change to off narrows. #121 may widen `frontDoor`'s value into an object under the same rule."
   - With: "Only off to on widens. A change to off narrows, and replacing one webhook with another is ordinary. If #121 makes `frontDoor` an object, `isWider` compares only whether it's open and its `showCount` (ADR-0075 §5)."
   - Replace: "Changing one webhook to another is entrenched."
   - With: "Changing one webhook to another is ordinary."
   - Replace: "Making `isWider` return false for webhook-to-webhook fails its vector"
   - With: "Making `isWider` return true for webhook-to-webhook fails its vector"
2. **Narrowing goes to a vote.**
   - Replace the bullet that begins "**Steward narrowing.** `narrow {optIn}` is valid when…"
   - With: "**Steward narrowing.** `narrow {optIn, proposal}` is valid when all of these hold: `can(author, 'narrow')`; the effective value isn't off; `proposal` is an open off-Proposal for that opt-in authored by the same steward; no recall against the author is open; and no off-Proposal for that opt-in failed or lapsed in the last 30 × 1,440 minutes. The opt-in is off from the `narrow` until that Proposal closes: off for good if it passes, back to the standing value if it doesn't (ADR-0040, ADR-0075 §3)."
   - Replace: "Stewards also see \"Turn off now\", with \"This lasts 7 days unless the group votes to keep it off.\""
   - With: "Stewards also see \"Turn off now\". It opens the off-Proposal composer, then queues the Proposal followed by `narrow`, with the line \"It's off until the group decides. This Proposal asks the group to keep it off.\""
   - Replace the second Acceptance Criteria bullet, the one that begins "Narrowing vectors:"
   - With: "Narrowing vectors: a non-steward's `narrow` is ignored, and so is a steward's without an open off-Proposal of their own. With one, the bot is off from the `narrow` until that Proposal closes: off for good if it passes, back on at its close if it fails. A second `narrow` within 30 days of that failure is ignored."

### #124: follow a coalition (§1, §5)

1. **Goal.**
   - Replace: "Whoever opens it sees the coalition's name, member groups and an excerpt, chooses a name, and follows. They join the coalition at Member level and get its Dispatches"
   - With: "Whoever opens it sees the coalition's name, member groups and an excerpt, and follows. They read the coalition and get its Dispatches"
2. **Link copy.**
   - Replace: "including the names its participants chose. They won't see inside any member group."
   - With: "including the names its participants chose and which group each comes from. They won't see inside any member group."
3. **Following.**
   - Replace: "Follow creates a fresh keypair, imports the history through sync's verify, dedupe and fold path, and queues `join {name}` without a seat."
   - With: "Follow imports the history through sync's verify, dedupe and fold path, and posts nothing. Following is read-only, so followers can't see each other (ADR-0075 §5)."
4. **Engine.** Replace the bullet that begins "**Engine.** In a coalition, a `join` without a `seat`…"
   - With: "**Engine.** In a coalition, a `join` without a seat is ignored. Coalition Dispatches ride only on a passed coalition motion, and a seat-bound participant can't send one directly (ADR-0075 §1)."
5. **Unfollow.**
   - Replace: "and 'Unfollow' runs M4-02's Leave on it."
   - With: "and 'Unfollow' runs `purgeGroup` on the coalition entry and posts nothing."
6. **Vectors.**
   - Replace: "Vectors: a follower's `proposal`, `group-result` and `dispatch` are ignored, and their join changes no seat, motion or result."
   - With: "Vectors: a `join` without a seat is ignored, and a `dispatch` from a seat-bound participant is ignored. A Dispatch carried by a passed coalition motion goes out."
7. **Privacy.**
   - Replace: "and their own follow appears only in the coalition."
   - With: "and nothing records that they follow."

### #100: coalitions as groups of groups (§1)

- Replace: "(an accepted pilot risk in ADR-0074: they can still read the coalition and contest that group's results, but never pass a motion)."
- With: "(an accepted pilot risk in ADR-0074 and ADR-0075 §1). Anyone holding a seat secret, which includes every member of that group, can read the coalition and make that group's result count as a fail. Nobody can make a motion pass without the group."

### #120: the coalition's mission statement (a gap: no wakes for coalition votes)

- Add under Output Format: "**Wakes.** If #99 has merged, each device that folds a new outside motion into a group posts, to that group's mailbox, a nudge due now plus nudges at `deadline − 1440` and `deadline`. The relay collapses deadline nudges with the same minute, and an extra 'now' wake is harmless."

### #99: opt-in push (§2)

1. **Disclosure.**
   - Replace: 'Disclosure first: \'Notifications only ever say "Something new in Reconcile." To send them, the relay keeps this phone\'s push address for each group you turn on, for up to 30 days, and Apple or Google can see when this phone is woken. They may show on your lock screen and a paired watch.\''
   - With: 'Disclosure first: \'Notifications only ever say "Something new in Reconcile." To send them, the relay keeps this phone\'s push address for each group you turn on, for up to 30 days. That lets whoever runs the relay see that the same phone is in each of those groups. Apple or Google can see when this phone is woken. Notifications may show on your lock screen and a paired watch.\''
2. **Privacy.**
   - Replace: "The relay gets one endpoint per opted-in group mailbox, plus wake minutes."
   - With: "The relay gets one endpoint per opted-in group mailbox, plus wake minutes. One device has one endpoint, so the relay can see which opted-in groups and coalitions share a phone, and can link a group's weekly mailboxes. That's an accepted pilot risk (ADR-0075 §2)."

### #89: content-free Web Push (§2)

- Replace: "so with the provider's help the database could tie a phone to its mailboxes"
- With: "so the database shows which mailboxes share a phone, across groups and weeks, and with the provider's help could tie that phone to a person (ADR-0075 §2)"

### #110: weekly mailboxes (§2)

- Replace: "While it watches live, the relay can still link one device's polls by IP and timing."
- With: "While it watches live, the relay can still link one device's polls by IP and timing. For a group with push on, #89's stored push address also links its weekly ids. Both are accepted pilot risks (ADR-0075 §2)."

### #109: choose recovery contacts (§4)

1. **The ADR-0009 claim.**
   - Replace: "and a share travels only in that group, so no contact learns your other groups."
   - With: "and a share travels only in that group, so a contact learns your other groups only if you pick them in more than one (ADR-0075 §4)."
2. **Picker copy.**
   - Replace: "Its copy: \"Pick people who know you and would answer a call from you. Pick different people.\""
   - With: "Its copy: \"Pick people who know you and would answer a call from you. Pick people you'd trust with all your groups at once. If you pick the same person in two groups, they can tell both names are you.\""
3. **Library.** Add under Decisions: "ADR-0075 §4 allows `shamir-secret-sharing` as the one library outside `@noble/*`. The PR links a published third-party audit of the pinned version, and stops to ask if there isn't one."

### #108: dissolve a group (§5)

- Replace: "With `wipe`, run `purgeGroup` on the first launch at least 7 × 1,440 minutes after the dissolve's `received`, so everyone sees the result first."
- With: "With `wipe`, run `purgeGroup` on the first launch at least 7 × 1,440 minutes after the dissolve's `received`, by the device's own clock, so everyone sees the result first. Without `wipe`, clear the archive's ballots and notes 30 × 1,440 minutes after the dissolve's `received`, by the same clock, keeping the outcomes and totals from the device's own tally. No relay time arrives after `dissolve` (ADR-0075 §5)."
- Add to Acceptance Criteria: "Store test: an archive holds no `vote` record, and no canary note, 30 days after the dissolve by the injected device clock, and still shows each outcome."

---

## C. Stale foundation text (ADR-0074 restored these)

### #73: invite links

- **TTL.**
  - Replace: "a link admits anyone while its envelope lives on the relay (`ttl_days=2`, about two days)"
  - With: "a link admits anyone while its envelope lives on the relay (`ttl_days=1`, which #62 rounds up to the next UTC day: 24–48 hours)"
- **Broken sentence.**
  - Replace: "so the link lives 24–48 hours and the \"next 2 days\" warning stays true. each blob sealed by M2-02's `Seal` under the invite key."
  - With: "so the link lives 24–48 hours and the \"next 2 days\" warning stays true. The envelope is a header blob followed by chunk blobs, each sealed by M2-02's `Seal` under the invite key."
- **The warning understates what a link reveals.**
  - Replace: "\"Anyone who opens this link in the next 2 days can read this group from then on. Send it directly to the people you're inviting.\""
  - With: "\"Anyone who opens this link in the next 2 days can read everything this group has written and voted on, and what comes next. Send it directly to the people you're inviting.\""
- **Deferred list.**
  - Replace: "vouches, use caps, revocation, token expiry, QR codes, member-approved joins, key rotation, and history requests between devices."
  - With: "use caps, revocation, token expiry, QR codes, member-approved joins, and history requests between devices. Vouches (#101) and key rotation (#98) come in later issues."

### #75: add and remove sections

- **Decisions.**
  - Replace: "Per ADR-0073 (MVP scope), there is no member removal and no part-ways event, so a group copies its Document into a fresh group instead. ADR-0073 also defers multiple Documents, reordering and Proposals that span several Atoms. Atoms keep their document id."
  - With: "Removal by vote arrives in #115, and parting ways stays deferred, so Copy as Markdown is how a group starts fresh. Several Documents (#92) and reordering (#103) come in later issues. Proposals that span several Atoms stay deferred (ADR-0074). Atoms keep their document id."
- **Goal.**
  - Replace: "which is how it parts ways or leaves someone out."
  - With: "which is how a group starts over, and how it parts ways while that stays deferred."
- **Deferred list.**
  - Replace: "moving or reordering Atoms, editing the Document title, more than one Document, Proposals that span several Atoms, and export formats other than Markdown."
  - With: "editing the Document title, Proposals that span several Atoms, and export formats other than Markdown. Reordering (#103) and several Documents (#92) come in later issues."

### #78: back up, restore, and erase

- **Deferred list.**
  - Replace: "relay backups, scheduled backups, recovery contacts, passkeys, QR linking, device lists, app lock, panic-wipe gestures, and restoring unsent events or drafts."
  - With: "scheduled backups, device lists, app lock, panic-wipe gestures, and restoring unsent events or drafts. The relay backup (#97), recovery contacts (#109), passkeys (#95) and QR linking (#96) come in later issues."
- **Backup key.** Add to `exportGroups`: "Once #97 has merged, the export also carries the random backup key (ADR-0075 §4)."

### #69: per-group signing keys

- Replace: "root identity, passkeys, recovery, link-reveal, renames, unique names and lookalike-name detection."
- With: "root identity, link-reveal, renames, unique names and lookalike-name detection. Passkeys (#95) and recovery (#109, #118) come in later issues."

### #71: encrypted, padded blobs

- Replace: "batching with jitter, rotating mailbox ids, key rotation, records over 64,000 bytes, and encrypting local storage (per ADR-0073, the phone's own lock and disk encryption protect the device)."
- With: "batching with jitter and records over 64,000 bytes. Weekly mailboxes (#110), key rotation (#98) and the passkey vault for local storage (#95) come in later issues."

### #74: consent meter and results

- Replace: "a per-Atom History view (the Decided list stands in for it), stand-aside, ballot expiry, push, and streaks, confetti or celebratory counts."
- With: "stand-aside, and streaks, confetti or celebratory counts. Section history (#104), ballot expiry (#111) and push (#99) come in later issues."
- Replace: "and because ballots don't expire, DESIGN.md's \"visible until\" date is left out."
- With: "and DESIGN.md's \"visible until\" date arrives with #111."

### #76: installable PWA

- Replace: "an update prompt, push, the older-device notice,"
- With: "an update prompt, the older-device notice,"
- Then append to the end of that list: "Push comes in #99."

### #77: group home and Leave

- Replace: "push and the digest, 'new' dots, feed tabs, removal, parting ways, key rotation, and clearing the group from the person's other device when it syncs a leave made elsewhere (they tap Leave there too)."
- With: "the digest, 'new' dots, feed tabs, parting ways, and clearing the group from the person's other device when it syncs a leave made elsewhere (they tap Leave there too). Push (#99), removal (#115) and key rotation (#98) come in later issues, and #98 replaces the Leave dialog's last sentence."

---

## D. Accepted risks to file as `blocked` issues

These come from ADR-0075's **Revisit** items. Each is filed as an issue labeled `blocked`, with its trigger:

1. #129: "Seat secrets wrapped to voting members and rotated with the group key". Trigger: before the outside review, or the first coalition blocked by a contested seat.
2. #130: "A separate push address per group, or no push for groups that ask for none". Trigger: before groups outside the founder's circle.
3. #131: "A relay-held recovery release that the owner's devices can cancel". Trigger: before the outside review.
4. #132: "Track the outside security review (ADR-0058) and the risks it must cover". Trigger: before the first group outside the founder's circle. It lists every accepted risk from ADRs 0073, 0074 and 0075.

---

## E. Small clarifications (anchors from the review; check before applying)

- **#91:** show each first-run guide card only when `can()` allows its action. A Member, or a newcomer still waiting for vouches, doesn't see "Suggest new wording for any section".
- **#93, #96:** leave the share link's state (`n` and the share secret key) out of the second-device link bundle, since syncing personal state is deferred. Say so in #93's privacy note.
- **#95:** list every secret the vault covers, including #105's share secret and #109's held shares, and widen the plain-text scan to them.
- **#96:** spell out the HKDF calls (hash, salt, length and encoding), as #97 and #105 do.
- **#97:** replace "never in the passphrase file, a link bundle or any group" with "never in any group or on the relay. It travels in #78's passphrase file and #96's link bundle, so a restored or linked device keeps the relay backup fresh (ADR-0075 §4)."
- **#97, #105:** soften "nobody can tie" the mailbox to a person. Uploads run from the same IP address as group syncs (ADR-0075 §2).
- **#104:** for Proposals in #111's `cleared` set, read totals from the `result` counts. Define history entries for moves (#103) and class changes (#116), which carry no text.
- **#105:**
  - Declare #76 and #77 as dependencies.
  - Before posting, read the mailbox and set `n` to the highest `n` seen plus one.
  - Treat any tombstone found there as final, so restoring an old backup can't roll the share back or bring a stopped share back.
- **#112, #126:** give `target: {kind: 'dispatch'}` its bar (ordinary). Say what happens to a Dispatch's `doc` link when it rises.
- **#121:** make `isWider('frontDoor', …)` compare only whether the door is open and its `showCount`. Rotating its keys is ordinary (ADR-0075 §5).
- **#122:**
  - Check a seat's claimed `level` against the coalition it came from.
  - Refuse an admission that would make a cycle, such as C admitting D when D contains C.
- **#123:** accept a `chat-thread` only from the author of the winning `chat-posted` claim for that Proposal's `open` moment, so another member can't point Join discussion at a different server.
- **#125:**
  - Make the example match "Authors appear only under their coalition names".
  - Note that ADR-0011's threads per Proposal and "argument concluded" message stay deferred.
- **#127:** "Dee joins A" becomes "Dee joins A as a Collaborator", so her score counts.

---

## F. Follow-ups made while applying

- **#118:** the check number is `u32be(sha256("reconcile/v1/recovery-check" ‖ 0x00 ‖ code)[0..4]) mod 10^6`, shown as six digits with leading zeros. That's the same reduction #96 uses.
- **#115:**
  - The comma splice in Privacy is fixed.
  - `targetClass()` returns `removal`.
  - Builds on says a removal always runs 14 days, with no window field.
- **#117:** the ADR-0040 decision bullet now describes narrowing as an off switch that lasts until the group decides.
- **#126:** the first vector takes A's result from A's own `group-result`. The `dispatch` target passes at the ordinary bar. This moved here from #112, which has no `dispatch` target.
- **#89:** the long Privacy sentence is split in two.
- **#122:** the level and cycle checks read only the coalition's own log, so every device folds the same way:
  - An admitted seat's level is the one its `admit` motion states, and each member group's vote is the check.
  - The fold refuses only seats already present.
  - A false level or a cycle across coalitions is left for the voting groups to sort out.
- **#96, #97:** the link bundle carries the backup key, and #97's older "passphrase file stays as it is" and "exists only on this device" lines now match ADR-0075 §4.
- **#125:** the deferral note was already there, so nothing was added.
