# Proposed changes to #430–#434 from spike #427

Only the parts that change are shown. Section names match each issue's own headings. **Replace** means swap that text in, **Add** means append it to that section, and **Remove** means delete it. Every change assumes the sheet's recommended answers (`steward-roll`, `own-groups-first`, `write-keys`, `epoch-key`, `30-days`, `entry-first`). Where a different answer would change an issue, the note under that issue says so.

"The amendment" means ADR-0077's amendment of 2026-11-14 (#427), drafted in [amendment-0077.md](amendment-0077.md).

---

## #430: the shelf opt-in and the per-Dispatch shelf line at every level

### Context

**Replace** the Depends on and Blocked lines with:

> - **Epic:** #422. **Settled by:** #427 (ADR-0077's amendment of 2026-11-14), §1 (keys), §6 (takedown).
> - **Not blocked on the covenant:** this issue records decisions only in each level's own log and shows a shelf address. Nothing reaches the relay.

**Add** to Privacy:

> - The shelf line's ballot copy says what publishing exposes, in words:
>   - on a group's ballot: "Anyone can read and copy it for 30 days. If a coalition above also puts its name to it, readers will see both names together, which shows that <group> is part of it."
>   - on a coalition's line, only where the origin published: "<origin> has put its name to this, so readers will see that <origin> is part of <coalition>."
> - The shelf address shown in Rules is public by design. It names no person and no member key.

### Output Format

**Replace** the Opt-in item with:

> - [ ] **Opt-in.** A `shelf` opt-in, off at genesis, whose value is `true` or `false`, with no secret. Its keys derive (the amendment, §1): a signing key and a write key, by HKDF of the level's current secret under `reconcile/v1/shelf-sign` and `reconcile/v1/shelf-write`, each ‖ `0x00` ‖ the turning-on Proposal's id. Add them in a new `client/src/crypto/shelf.ts`, with `vectors/shelf.json` computed outside @noble. Turning it on is the entrenched bar; off is the ordinary bar.
>   - Rules shows the plain line on what the shelf exposes, then the **shelf address** (the public key and its public mailbox id, 86 characters) with Copy and Share, and: "Send this to the shelf's steward to be added. During the pilot, only groups the founder has added can publish."
>   - After a key change (#98), the address is the new one, and Rules says the old one has retired.
> - [ ] **A coalition's opt-in.** A coalition motion turns its `shelf` on or off, decided group by group, at the entrenched bar to turn it on and the ordinary bar to turn it off. Its keys derive from the coalition's secret, which never changes (ADR-0074). If coalition motions have no class rule yet, raise it on the issue rather than inventing one.

**Replace** the fold item with:

> - [ ] **The fold** exposes `shelfOf(dispatchId) => {level, key, passed}[]`: the levels whose shelf line passed and hasn't been taken down, in order from the origin, with each one's shelf public key and `passed`, the relay minute its line passed. A coalition that carried the Dispatch but didn't pass its line isn't in it. A level's `below` and `above` (amendment §1) are the keys before and after it in this list.
> - [ ] **The promote record carries `below`.** A promote motion for a Dispatch whose origin asked for the shelf carries `shelf: [<key>, …]`: the keys of the levels below whose line passed. The `from` seat's result is `fail` for a record whose list differs from its own fold, as #126 does for altered text. So no seat-secret holder can slip a key into `below`.

**Add** (moved here from #431, since these are governance):

> - [ ] **Take it down.** On a Dispatch whose `shelfOf` includes this level, an ordinary Proposal: "Take <title> off the public shelf", in a coalition decided group by group. Its final pass drops the level from `shelfOf` for good.
> - [ ] **Fast path.** A steward's `narrow` of `shelf` (ADR-0040, ADR-0075 §3) drops every Dispatch from `shelfOf` while it holds, and they stay dropped whatever the off-Proposal does.
> - [ ] **The fold exposes what the device owes the relay.** `shelfDeletesOwed`: every Dispatch whose entry must leave because of a takedown pass, a narrowing, the opt-in turning off, or a dissolve. `shelfRetireOwed`: the shelf key a key change, an opt-in off or a dissolve retired. #431 sends both; this issue sends nothing.

### Acceptance Criteria

**Add:**

> - [ ] Vectors:
>   - a takedown removes one level and leaves the coalition's line standing;
>   - a narrowing that fails still leaves its Dispatches off `shelfOf`;
>   - a dissolve owes every live entry's delete and one retire;
>   - a `leave` changes the shelf address and owes the old key's retire;
>   - `vectors/shelf.json` matches Python's `hashlib` and `cryptography`;
>   - a promote record whose `shelf` list adds or drops a key gets `fail` from its `from` seat.
> - [ ] Component tests:
>   - Rules shows the address only while the opt-in is on, and its pilot line;
>   - each ballot line's disclosure appears in the right case (the coalition line only when the origin published).

### Constraints

**Replace** "taking an entry down (per #427's answer)" in "Not in this issue" with "sending anything to the relay: posting, deleting and retiring are #431".

> If the founder picks `ordinary-vote` for `key-holders`, the opt-in value becomes `{secret}` again, and a membership's end sets "needs a new key", which takes an ordinary rules Proposal. If the founder picks `keep-key`, a key change doesn't change the address.

---

## #431: publish to the shelf and read it on Discover

### Context

**Replace** the Depends on and Blocked lines with:

> - **Epic:** #422. **Settled by:** #427 (ADR-0077's amendment of 2026-11-14), §§1–7 and [relay-routes.md](relay-routes.md). **Depends on:** #430 (`shelfOf`, the keys, what the device owes), #429 (the feed), and **#431a** below (the relay routes).
> - **Blocked:** until the founder lifts `blocked`. With the sheet's `own-groups-first`, that can be as soon as #430 and #431a land: the steward's roll lists only levels the founder belongs to. Lifting that limit is a roll change, gated on the amendment's §7 list and the outside review (ADR-0058), the same trigger as #435.

**Replace** the Privacy paragraph's last two sentences with:

> - Every read of the shelf is a whole read: the roll's public mailbox, then every listed level's, all pages from `after=0`. It happens when Discover opens, and at most once per relay day while the app is open, at a random minute, on every device, in a group or not. So no request says anything about the reader.
> - The shelf sends no notification and no push, and a public PUT never asks for `wake`.
> - The one new linkage is the posting device's address tied to its level at the relay, live. It's named in the amendment's accepted risks and in `09-privacy-rules.md`.

### Output Format

**Replace** the Publishing, Reading, check and Leaving items with:

> - [ ] **Records** (`client/src/shelf/records.ts`, a pure module): build, sign (`signTagged` under `reconcile/v1/shelf`), pad (the blob sizes) and parse entry and retire records exactly as amendment §1 gives them, with the entry id `SHA-256("reconcile/v1/shelf-entry" ‖ 0x00 ‖ dispatchId)`.
> - [ ] **Publishing.** For each level in `shelfOf`, the device posts the level's record to its public mailbox (`PUT /v1/public/{writeKey}?ttl_days=<days left of 30, at least 1>`) at a random relay minute in the hour after folding the pass, unless the mailbox already holds the same bytes.
>   - When an upper level joins (`above` grows) or the door changes, it posts the new record, and deletes the old one once the new one has stood 1,440 relay minutes.
> - [ ] **Leaving.** The device sends what #430's fold owes: `DELETE /v1/public/{writeKey}/{seq}` for each record of an owed entry, at once, and the retire record for an owed retire.
> - [ ] **Members' devices check the shelf** (amendment §4). After each whole read, the device deletes any record under its levels' current keys that its fold wouldn't make. It does so only after a full sync pass, over every group and coalition the device holds, that began after the relay received the record.
>   - For 31 days after a key retires, the device also checks that key's mailbox: it deletes anything posted after the retire record, and posts the retire record again if it's gone.
> - [ ] **Reading** (`client/src/shelf/read.ts`, pure, given the roll, the mailboxes and the GET's `now`):
>   - the roll rule: the newest valid roll under 30 days old, and no lower than the version this device last saw, which it keeps in IndexedDB. Otherwise Discover says "The shelf is resting." and lists nothing.
>   - the eight checks of amendment §3, the day's hold and the rule that names join only when both levels list each other included.
> - [ ] **Discover** shows each entry marked "On the public shelf", with its names as plain text in `<bdi>`, plus the line "Groups put their own names here by vote. Reconcile doesn't check a group's name against anything outside the app. Anyone can copy what's here."
>   - The publishing group's own result, and its Dispatch, say "Goes on the public shelf after a day" until the hold has passed.
> - [ ] **The steward's tool** (`scripts/shelf-steward`, Python, run on the founder's own computer, never on the VM): add or drop a shelf address with its name, withhold an entry, suspend a key, sign and post the roll, and delete the roll it replaces. It copies a retire record's seq into the roll's `retired` list, warns when the roll is two weeks old, and drops retired keys 31 days after their retire record. Its key file sits outside the repo. Its public key and the roll's id are build constants.

**Keep** Pass-along and the no-group reader. **Add** to "The spec gains a Shelf section": "§6 gains the public routes (from #431a)".

### Acceptance Criteria

**Replace** the first two items with:

> - [ ] Unit tests for `read.ts`, each failing when its check is removed:
>   - a level that never passed (no record), and a record under a key the roll doesn't list;
>   - a name whose commitment differs, a record received after its key's retire record, and one after the seq the roll's `retired` gives once that record has been deleted;
>   - a record 1,439 minutes old (not shown) and one 1,440 minutes old (shown);
>   - a record with `passed` in the future, and one 43,201 minutes old;
>   - a withheld entry and a suspended key;
>   - a hostile level whose record copies another's entry id and lists that level's key in its own `below` or `above` (two entries, not one), and a pair where only one side lists the other (not joined);
>   - an eleventh entry from one level;
>   - a roll 30 days old (nothing shown), and a roll older than the version seen (refused).
> - [ ] Unit tests for publishing and the check:
>   - two devices of a level post byte-identical records;
>   - a device that's behind (its last full pass began before the record arrived) deletes nothing;
>   - an up-to-date device deletes a forged record and leaves the real one.
> - [ ] `scripts/shelf-steward` has pytest coverage under the repo's gates, including a roll vector that `read.ts` accepts.

**Replace** the `relay-learns-nothing` item with:

> - [ ] `relay-learns-nothing.spec.ts` or a sibling: with one published entry and one unpublished Dispatch, the stopped relay's files hold the published title and text readable, as the control, and no other canary. They also hold no group secret, no shelf signing seed or write key (only its hash, the id), no steward secret and no member's name, in every encoding.

> If the founder picks `signed-shelf` for `storage`, the relay half becomes relay-routes.md's appendix, and `read.ts` reads one `GET /v1/shelf`. If the founder picks `plain-mailbox`, there's no #431a, and Leaving can only hide entries until they expire.

### Proposed split: #431a (new issue)

> **feat(relay): public mailboxes: a write key to add or delete, its hash to read** (P2, `relay`, `security-critical`)
>
> - **Role:** a Python engineer for `reconcile/relay/`.
> - **Goal:** relay-routes.md, exactly: `PUT /v1/public/{key}`, `DELETE /v1/public/{key}/{seq}`, `GET /v1/public/{id}`, rows in `blobs` under `public:<id>`, and `RECONCILE_RELAY_MAX_PUBLIC_BYTES` at 512 KiB, with no new table, column or per-IP state.
> - Also `client/src/net/relay.ts`'s `putPublic`, `deletePublic` and `getPublic`, and spec §6's rows. It amends ADR-0028 as the shelf amendment says.
> - **Acceptance:** relay-routes.md's test list, and the shared `public-id` vector.
>
> It can start now. It exposes nothing until #431 writes to it.

---

## #432: Ask to join and Propose reconciling from a shelf entry

### Context

**Add:**

> - **Settled by:** #427 (ADR-0077's amendment of 2026-11-14), §3: a door must name the entry's shelf key. This stops a hostile level listing another group's door beside its own words.

**Add** to the Files list: `client/src/door/page.ts`, `door/keeper.ts`, and the front door's spec section.

### Output Format

**Add:**

> - [ ] **The door names its shelf key.** While a group's `shelf` opt-in is on, its door page gains `shelf: "<the level's current shelf public key>"` (43 characters), and members' devices post a fresh copy when it changes. An older app ignores the field.
> - [ ] **The check.** Tapping Ask to join or Propose reconciling reads the door's page as today. The form opens only when the page is open and its `shelf` equals the entry's key for that group. Otherwise the page says "This front door doesn't belong to <name>." in `body`, with no form. Nothing is fetched before the tap.

**Replace** "neither shows on entries from the reader's own groups" with "neither shows on entries whose key is one of the reader's own levels' shelf keys, current or retired in the last 30 days, never matched by name".

### Acceptance Criteria

**Add:**

> - [ ] Component tests:
>   - a door page naming another key shows the mismatch line and no form;
>   - a door page with no `shelf` field shows it too;
>   - an entry from a reader's own level is matched by key even when another group has the same name.
> - [ ] `vectors/door.json` gains an open page with `shelf`.

---

## #433: the Bedfellows view

### Output Format

**Replace** "Entries from the reader's own groups and coalitions are left out of Bedfellows and stay in Newest" with:

> - [ ] Entries whose key is one of the reader's own levels' shelf keys (current, or retired in the last 30 days) are left out of Bedfellows and stay in Newest. They're matched by key, never by name.

**Add:**

> - [ ] Bedfellows scores only the entries #431's reader shows (after the day's hold and every check). An entry that fails a check is never scored, so no kinship is ever computed against a forged name.

(No other change. Discover's whole-shelf read already means scoring adds no request.)

---

## #434: the end-to-end spec and relay scan

### Context

**Add:**

> - **Settled by:** #427 (ADR-0077's amendment of 2026-11-14).
> - The e2e build has its own steward key pair. Its public key and the roll's id are build constants, as in production and staging, never a relay mode. The spec plays the steward in Node, signing and posting the roll with the steward's write key, as `recovery.spec.ts` opens boxes outside the app.
> - The day's hold is crossed with `readRelayLater` (`e2e/support/relayNow.ts`, #127), extended to `GET /v1/public/` responses, with no relay route or flag.

### Output Format

**Replace** the Cy reads step with:

> - [ ] The spec reads A's and C's shelf addresses from Rules and posts a roll listing both.
> - [ ] Cy, in no group, opens Discover at once: nothing from A is there yet.
> - [ ] Every profile then reads the relay a day later. Cy reads the first Dispatch, named for A alone and not for C. The second isn't there.

**Add** after it:

> - [ ] **A forgery is caught.** The spec reads A's group secret from Ana's IndexedDB, as `leave-rotates.spec.ts` does, derives A's shelf keys with Node's own HKDF, and posts a forged canary entry under A's key from Node. Ana's next whole read deletes it, and Cy, a day later, never sees it.
> - [ ] **A takedown removes bytes.** A third canary Dispatch is published, then taken down by an ordinary vote that closes early. Cy's next read lacks it.

**Replace** the stopped-relay item with:

> - [ ] The stopped relay's database, WAL, shared memory and log:
>   - hold the first Dispatch's title and text readable, as the control;
>   - hold no word of the second, third or forged Dispatches;
>   - hold no group secret, shelf signing seed, write key or steward secret, and no other canary, key or name, in every encoding.
>
>   The public mailbox ids, which are the write keys' hashes, are controls.

### Acceptance Criteria

**Replace** "Removing the shelf-line check in the fold makes it fail" with:

> - [ ] Each of these makes the spec fail, recorded in the PR:
>   - removing the shelf-line check in the fold;
>   - removing the day's hold;
>   - removing the rule that names join only when both levels list each other;
>   - removing members' devices' check.

---

## Also worth updating: #422 (the epic)

**Replace** its "Publishing to the shelf is blocked on #427 and on the eternal core's wording" sequencing note with:

> Publishing waits on #430, #431a and the founder lifting `blocked` on #431. With #427's `own-groups-first`, the shelf runs for the founder's own groups first. Opening it to other groups waits on the amendment's §7 list and the outside review, the same trigger as #435.

**Add** #431a to Child Issues under **Ready now**: "Core: public mailboxes on the relay (depends on nothing; exposes nothing until #431)".
