# SPEC: Listed Doors, the Public Shelf and Moderation by Exception

- **Status:** The build contract. The founder accepted [ADR-0081](../adr/0081-listed-doors-and-exception-moderation.md) as written on 2026-11-17, values marked **(proposed)** included; each stays the founder's to change.
- **Date:** 2026-11-17
- **Depth:** the pilot slice. Only the founder's own groups are listed. §9 names what waits and what brings it back.
- **Inputs:** ADR-0081 (why), [ADR-0077](../adr/0077-discover.md) (Discover), [`phase-1-spec.md`](phase-1-spec.md) §4 Front door, Opt-ins and Dispatches, §6 and §9

This spec says what the pilot slice builds and how. Each issue that builds a part moves its contract into `phase-1/` in the same PR, as every MVP issue does. Where this spec and an ADR disagree, the ADR wins.

Values marked **(proposed)** were the author's; the founder accepted them with ADR-0081, and they remain the founder's to change.

---

## 1. Goal

A group can list its front door. A listed group can publish single Dispatches to a public shelf, each by its own vote. Anyone with the app reads the shelf on Discover, including a person in no group. When a listed group spams or impersonates, the harm is detected, contained and undone without anyone voting on each new group.

**Success for the slice:**

1. One of the founder's groups lists its door by vote and the steward releases it.
2. It publishes a Dispatch by vote, and a profile in no group reads it a day later.
3. A second listing under a look-alike name is never shown.
4. The steward holds an entry after a report, upholds it, and a device that applied through that door is told.
5. The stopped relay's only readable bytes are shelf records.

## 2. Terms

| Term | Meaning |
|---|---|
| **Listed door** | An open front door whose group voted to list it. Its address is the door's address: the public half of the door's `sign` key |
| **Listing** | The public record a listed door posts: its name and the covenant version it accepted |
| **Registry** | Every live listing, as each device folds it from the shelf log |
| **Entry** | One published Dispatch: its id, title and text, under a listing's address |
| **Steward** | The platform-level moderator (ADR-0013), the founder during the pilot. Distinct from a group's own stewards |
| **Notice** | A record the steward signs: release, hold, uphold, suspend or pause |
| **Tombstone** | An uphold or suspend notice, as shown in place of what it removed |
| **Skeleton** | A name reduced so that look-alike spellings compare equal |

## 3. Listing a door

**Built.** #485 built §3.1 to §3.3: the front door's value with `listed` and `covenant`, its class, the covenant module, the composer, the ballot and the Group rules lines. That contract now lives in [`phase-1/04-events/07-opt-ins.md`](phase-1/04-events/07-opt-ins.md) and [`phase-1/08-screens.md`](phase-1/08-screens.md) (items 11 and 8). Nothing is posted to the shelf yet: §4.5 is a later issue's.

### 3.1 The opt-in

- **The front door's value gains two fields:** `{sign, box, showCount, listed, covenant}`. `listed` is a boolean. `covenant` is present only when `listed` is true: the SHA-256 of the covenant text the group read, in unpadded base64url.
- **Widening.** `isWider` is true from unlisted to listed, so listing takes the entrenched bar and a 14 to 28 day window. Unlisting is ordinary.
- **One Proposal can open and list** a door, or list a door that is already open.
- **The composer and the ballot show the covenant's text** and one plain line: "Your group's name will be public beside the words it votes to publish. Anyone can read them, and copy them before they come down." #486 added "Members' devices post the listing, so whoever runs the relay can tell which devices are in your group." (§7).
- **A group is never prompted toward listing.** It appears only in Group rules, under the front door.
- **Older apps (decided in #485).** A build from before #485 refuses a front door value with fields it doesn't know (see #459), so it ignores a Proposal carrying one and every vote on it. The decision:
  - **An unlisted door is written as before #485,** `{sign, box, showCount}`, never with `listed: false` (which every build from #485 reads as the same door). So opening, rotating, counting and closing a door that isn't listed fold the same on every build. Only a Proposal that lists a door, accepts a new covenant or unlists one is new to an older build.
  - **An older device lags; the log never splits.** Every device holds the same records, the fold is a pure function of them, and no build stores folded state, so a device that updates refolds the same records and agrees with every other device at once. ADR-0057's background update applies at the next launch.
  - **Until it updates,** an older device doesn't show a listing Proposal; numbers the Proposals after it one lower; keeps a door that one Proposal opened and listed closed; and, since it reads the door as it stood before, may class its own later door Proposal differently from newer devices. None of this reaches the log: newer devices fold it as written.
  - **The pilot rule:** every device in a group runs a build with #485 before that group's first listing Proposal. A listing runs 14 to 28 days and, during the pilot, the steward releases only the founder's own groups, so updating meets it. It stands as ADR-0075's rule for key changes does. The founder accepted it on 2026-11-18.
  - **Rejected:** a separate opt-in for the listing, since an older build ignores an opt-in it doesn't know just as it ignores an unknown field, and it would split opening and listing into two votes; a new event version `v`, since an older build ignores every event of an unknown version (`admits` in `fold.ts`), the same outcome, and ADR-0057's per-version validators aren't built; and carrying the listing beside the value, or on a key rotation, since an older build would then fold a listing as no change, or as an ordinary rotation where newer builds see an entrenched listing, a real split in outcome rather than a lag.

### 3.2 The covenant

- **The text ships with the app** in `client/src/shelf/covenant.ts`, versioned, with its hash pinned by a test.
- **The pilot draft has three clauses:** C1, ADR-0035's placeholder core; C2, no spam; C3, no impersonation of another group or person. As shipped (#485): "Reconcile does not carry calls for violence against people, or speech that denies any group’s humanity." (ADR-0035's words, set with the app's curly apostrophe), "A listed group does not post spam." and "A listed group does not pretend to be another group or person."
- **It is marked a draft on screen.** The wording waits on ADR-0035 and counsel. A new version changes the hash, and a group re-accepts by an ordinary rules Proposal.

### 3.3 When a listing ends

- **A listing ends whenever its door closes:** by a vote, by a steward's narrowing inside the group, or when a membership ends (#288). The fold already closes the door at that record.
- **Relisting is a new opening Proposal** with fresh secrets and a new address, as for any door.
- **The name is unprotected in between.** During the pilot the steward releases every listing by hand, so the steward sees the collision and decides. §9 has the trigger for a real answer.

## 4. The shelf log

The shelf is one public log on the relay. Every device reads the same log and folds it with the same pure function, as it folds a group's log.

**Built so far.** #431 built §4.2's entry rules (`409 not_listed`, 4 live entries and 1 new a relay day, `429 too_many_entries`, one entry per address and id, 30 days; and, decided there, a withdraw names one of its address's entries, else `409 no_entry`, and a repeated withdraw returns its first seq), §4.3's rules 5 to 7 with `vectors/entries.json`, and §4.5's entries and strays; that contract lives in [`phase-1/06-relay-api.md`](phase-1/06-relay-api.md) (Entries), [`phase-1/07-sync.md`](phase-1/07-sync.md) (step 8) and [`phase-1/08-screens.md`](phase-1/08-screens.md) (Group home's stray card). #487 built §4.3's rules 3 and 4 and §4.4, and the listing composer's warning; that contract lives in [`phase-1/06-relay-api.md`](phase-1/06-relay-api.md) (Skeletons and name ownership), [`phase-1/07-sync.md`](phase-1/07-sync.md) (step 8) and [`phase-1/08-screens.md`](phase-1/08-screens.md) (the composer). #486 built §4.2's listing rules (one listing per address, replaced in place, 30 days after its last post, `409 listing_final`, a final listing deleting its entries), §4.3's rule 2 in full, and §4.5's listing and its end; that contract lives in [`phase-1/06-relay-api.md`](phase-1/06-relay-api.md) (Listings) and [`phase-1/07-sync.md`](phase-1/07-sync.md) (step 8 of a pass). #484 built §4.1's records (on the wire, a record is the 64-byte signature, then the JSON; the address travels beside it, not in it), §4.2's `PUT` and `GET /v1/shelf`, its size limits, `shelf_full` and the table, and §4.3's rule 1 and the newest listing per address. That contract now lives in [`phase-1/06-relay-api.md`](phase-1/06-relay-api.md) and [`phase-1/09-privacy-rules.md`](phase-1/09-privacy-rules.md); the rest of this section is still to build.

### 4.1 Records

Every record is compact UTF-8 JSON, signed with Ed25519 under the tag `reconcile/v1/shelf`. The signer is the door's `sign` key for a group's records and the steward's key for notices.

| Kind | Body | Signed by |
|---|---|---|
| `listing` | `{v: 1, kind, open: true, name, skeleton, covenant}`: the group's name (1 to 120 code points), its skeleton, and the covenant hash | the door |
| `listing`, final | `{v: 1, kind, open: false, final: true}` | the door |
| `entry` | `{v: 1, kind, id, title, text}`: the Dispatch's id, title (1 to 80 code points) and text (at most 500) | the door |
| `withdraw` | `{v: 1, kind, id}`: an entry's id | the door |
| `notice` | `{v: 1, kind, act, address?, id?, clause?}` (§6.1) | the steward |

- An entry carries no name. It shows its listing's current name, so a name lives in one place.
- An entry carries no author, total, Document link, member count or time of its own.
- Sizes **(proposed)**: a listing or notice is at most 1,024 bytes, an entry at most 4,096.

### 4.2 Relay routes

These are the first routes whose bodies the relay can read. They are on only when `RECONCILE_RELAY_SHELF_STEWARD_KEY` holds the steward's public key. Otherwise each returns `404 {"error": "shelf_unavailable"}`.

| Method | Path | What it does |
|---|---|---|
| `PUT` | `/v1/shelf/{address}` | Stores one signed record under a door's address, or under the steward's for a notice. Returns `201 {"seq": n}` |
| `GET` | `/v1/shelf?after=S&limit=L` | Returns `{"records": [{"seq", "received", "address", "data"}], "now", "instance"}`: every record that isn't held, in seq order |
| `GET` | `/v1/shelf/held?after=S&limit=L` | The same shape, for held records only. The steward's console reads it |

**What the relay checks on a PUT, and nothing more:**

- The address is 43 base64url characters, the body is within its size, and the signature verifies against the address.
- A notice's address is the configured steward key.
- An `entry` or `withdraw` needs a live listing at that address (else `409 not_listed`).
- At most 4 live entries per address, and at most 1 new entry per relay day **(proposed)** (else `429 too_many_entries`).
- A repeated `entry` with the same address and id stores nothing new and returns the first one's `seq`.
- The shelf's total bytes stay under `RECONCILE_RELAY_SHELF_MAX_BYTES`, 64 MiB by default **(proposed)** (else `507 shelf_full`).
- A suspended address is refused (`403 suspended`).

**What the relay never does:** read a name's meaning, compare skeletons, keep per-IP state, or log a request. The existing rules in §6 of the MVP spec apply unchanged: constant error bodies, no client address, no forwarding headers.

**Storage.** One table, `shelf(seq, address, kind, ref, body, received, expiry, held_until)`, where `ref` is an entry's id or empty. No other column.

- A listing expires 30 days after its last post, an entry 30 days after its first, a notice after 180 days **(proposed)**.
- A final listing deletes its address's entries.
- The daily purge deletes expired rows.

**Held mode.** `RECONCILE_RELAY_SHELF_MODE` is `held`, the only mode this slice builds. An address's first listing, and everything under it, is stored with `held_until` set to "until released". A `release` notice clears it.

### 4.3 The fold

`foldShelf(records, now)` in `client/src/shelf/fold.ts` is pure and imports no React. Every device applies the same rules, so a seized or faulty relay can withhold records but can't make a device show a forged one.

1. **Signature.** A record whose signature doesn't verify against its address is ignored. A notice must verify against the steward key pinned in `client/src/shelf/steward.ts`.
2. **Listings.** Per address, the newest valid listing stands, and a final one outranks every later copy, as a door's page does.
3. **Skeletons.** The device recomputes the skeleton from the name. A listing whose `skeleton` field differs is ignored.
4. **Name ownership.** Among live listings that share a skeleton, the one whose first record has the lowest `seq` holds the name. The others are shadowed: neither they nor their entries are shown. *Decided in #487:* an address's "first record" for a skeleton is the first copy of its newest unbroken run of listings under that skeleton, so a refresh or a respelling with the same skeleton keeps the claim, and a door that renames into a name another door holds claims it only from the rename; a tie on `seq`, which only a faulty relay serves, goes to the lower address.
5. **Entries.** An entry stands only under a live listing that is neither shadowed nor suspended, and only as one of that address's first 4 unexpired entries in seq order.
6. **The day's wait.** A device shows an entry once the relay's clock is 1,440 minutes past its `received`. A member of the publishing group sees it at once, marked "Shows publicly tomorrow".
7. **Withdrawals** remove the entry they name, under the same address only.
8. **Notices** apply as §6.1 says.

Golden vectors in `client/src/shelf/vectors/` pin each rule, with fast-check properties for order independence within a `seq` tie and for the caps.

### 4.4 Skeletons

- `nameSkeleton(name)` in `client/src/shelf/skeleton.ts`: NFKC, case folding, removal of whitespace and punctuation, then the Unicode confusables mapping (UTS #39), pinned to one Unicode version.
- The confusables data is vendored from Unicode's own file and checked by a test. It is data, not a third-party script.
- "Eastside Tenants Union", "EASTSIDE TENANTS UNI0N" and "Eastside  Tenants-Union" share one skeleton.
- This lifts the deferral of look-alike detection (ADR-0045) for listed names only. Names inside a group keep their key suffixes.
- **As built (#487).** Unicode 18.0.0's file, vendored by `client/scripts/confusables.mjs`. Case folding is upper case then lower case with one sigma, since JavaScript has no full case folding; the steps repeat until the skeleton settles, since a prototype can be in the other case (`0`'s is `O`) or a compatibility form. NFKC, case and the character classes come from the device's engine: Unicode keeps them stable once a character is assigned, so devices differ only on a name with a character newer than one engine's Unicode, which that device ignores (rule 3) until it updates.
- **Known gaps, accepted for the pilot.** Case folding runs before the confusables mapping, so a capital `I` for an `l` in a mixed-case name ("MiII Creek") reads as `i`, not `l`; and an accent is a different letter, not a look-alike ("Café", "Cafe"). The steward releases every listing by hand during the pilot (§3.3), and sees both. A name whose skeleton runs long (a ligature such as `ﷺ` spells 18 code points) can take its listing past 1,024 bytes, and the relay then refuses it.

### 4.5 What a group's devices post

A listed group's devices keep the shelf in step with the group's own log, as the door keeper keeps the page (`createDoorKeeper`).

- **The listing.** Posted when none stands, when the name or covenant changed, or when the newest copy is 7 days old.
- **An entry.** Posted when the fold shows a Dispatch's shelf line passed. Every member's device may post it; the relay keeps one.
- **A stray entry.** An entry under the group's address that the group's log didn't make is withdrawn by the first member's device that sees it, and Group home says so.
- **The end.** When the door closes or the group unlists, each device posts the final listing.

## 5. Publishing and reading

### 5.1 The shelf line

**Built.** #430 built the shelf line: the target's `shelf: true`, a reach of 0 beside it, the second version, `state.published` and `publishedBy`, the form, the two-line ballot and both results. That contract now lives in [`phase-1/04-events/11-dispatches.md`](phase-1/04-events/11-dispatches.md) (The shelf line) and [`phase-1/08-screens.md`](phase-1/08-screens.md) (item 15). A shelf line takes only a reach of 0: the Dispatch stays in its group. A build from before #430 then ignores the whole Proposal and only lags, as §3.1 describes; with a ceiling it would read a plain rising Dispatch and ignore the shelf line's ballots, splitting the Dispatch's outcome. #431 posts §4.5's entry.

- While a group is listed, Send a Dispatch offers "Also ask to put it on the public shelf", only for a Dispatch that goes to a vote.
- Its ballot has two scored lines: the Dispatch, and "Put {name} to this on the public shelf". Each is 0 to 4 with its own consent meter. The shelf line passes only if the Dispatch line passes too, at the ordinary bar.
- **Groups only.** A coalition has no door, so a promote motion carries no shelf line in this slice.

### 5.2 Discover

**Built** but for the pause (#489). #432 built Ask to join and Propose reconciling on an entry's own page, where #431 put Share and Copy; that contract lives in [`phase-1/08-screens.md`](phase-1/08-screens.md) (item 19, an entry's page). #431 built the section, "Listed since", the day's wait and "Shows publicly tomorrow", fetching, and the entry's link with Share and Copy; that contract lives in [`phase-1/08-screens.md`](phase-1/08-screens.md) (item 19, Discover) and [`phase-1/09-privacy-rules.md`](phase-1/09-privacy-rules.md). "Listed since" is the earliest relay minute the device read at the listing's address, since the relay renews a listing in place and keeps no first time.

- **A second section, "On the public shelf",** below the feed of the person's own groups. Each card shows the title, the text, the listing's name in `<bdi>`, and "Listed since {month year}".
- **A device in no group reads it** once past the pilot notice.
- **Fetching.** The device reads the whole shelf in seq order, 100 records a page, at most once an hour while the app is open **(proposed)**. Every device fetches the same thing, so a fetch says nothing about its reader (ADR-0077 §4).
- **Pass-along.** Each entry has Share and Copy for a link that opens that entry on Discover.
- **Ask to join** and **Propose reconciling** appear on an entry and open the listing's door (ADR-0077 §2 and §5).
- **Paused.** While a pause notice stands, the section shows one line and no entries.
- The shelf sends no notification and no push.

### 5.3 Attached Documents

**Built** (#432) but for holds, which count once the steward's notices fold (#488, #489). The contract lives in [`phase-1/08-screens.md`](phase-1/08-screens.md) (item 16, Front door) and [`phase-1/09-privacy-rules.md`](phase-1/09-privacy-rules.md) (A front door shows no one), with why a device's "first listing" can only err newer.

A door's application form offers no personal Documents when the door is listed and either its first listing is under 43,200 relay minutes old or it is held. One line says why. An unlisted door reached by a link is unchanged: a person chose to hand that link over.

## 6. Moderation by exception

### 6.1 Notices

The steward signs each notice. The relay acts on it so that held records aren't downloaded, and every device folds it so that the relay alone is never trusted.

| `act` | Names | Relay | Device |
|---|---|---|---|
| `release` | an address | clears its hold | shows the listing and its entries |
| `hold` | an entry, or an address | hides it for 10,080 minutes | the same; the group's own members see "Held: {clause}" |
| `uphold` | an entry, and a clause | deletes the entry, keeps the notice | shows a tombstone in the entry's place until its 30 days end |
| `suspend` | an address, and a clause | deletes its records, refuses its PUTs | shows a tombstone; the door's page says the listing was removed |
| `pause` | on or off | nothing | hides or shows the whole shelf section |

- **A hold lapses.** Without an `uphold` within 10,080 relay minutes, the entry shows again. An absent steward, or a thief who only holds, therefore fails open.
- **A tombstone names the clause,** in words: "Removed: impersonation of another group". Decisions are public (ADR-0013).
- **Clauses** are the covenant's: `C1`, `C2`, `C3`.

### 6.2 The steward's key

- **Two public keys ship in the app:** the steward's Ed25519 key, which signs notices, and an X25519 key, which reports are sealed to. The relay holds the first in its settings.
- **The secret halves** are imported on the steward's device from Settings, kept through `keepKeys`, and sealed in the passkey vault where there is one.
- **Rotation** is an app release and a relay setting. It is one key on one device during the pilot (ADR-0081, Consequences).

### 6.3 Reports and appeals

- **Report.** Every entry has a quiet "Report this entry". It asks for a clause and takes a note of up to 500 code points. The device seals `{address, id, clause, note?}` to the steward's box key, padded to a blob size, and PUTs it to the steward's inbox, an ordinary mailbox derived from the steward's key. It carries nothing about the reporter and has no reply path.
- **Appeal.** A member of a held or suspended group who holds `propose` sees "Ask the steward to look again". It sends `{address, id?, note}`, signed with the door's key, the same way.
- **Reports never hide anything.** They only fill the steward's queue.

### 6.4 The steward's console

`#/steward`, shown only on a device that holds the steward's secret key. It lists:

- listings waiting for release, with any live listing that shares the skeleton beside each;
- reports and appeals, newest first;
- entries the classifier flagged (§6.6);
- standing holds and when each lapses.

Its actions are the five notices. Each asks for a clause where one is needed and shows what readers will see.

### 6.5 Telling affected devices

- After each shelf read, the device matches tombstones against two things it already holds: applications it sent (`sent`) and reconcile cards it sent, by door address.
- A match shows one line on Start and on Discover: "A group you asked to join on {date} was removed from the shelf: {clause}."
- Nothing is sent. The platform never learns which devices matched.
- The device keeps no record of which entries its reader looked at.

### 6.6 The classifier

- **It only flags.** A flag puts an entry in the console's queue. It hides nothing, and no reader sees it.
- **It reads only shelf entries**, which are public, and only on the steward's device. It never runs on a group's sealed content (ADR-0020, as ADR-0081 clarifies).
- **It makes no network call** beyond fetching its own model file from the app's origin.
- **A spike decides the rest:** which model, how it runs under a CSP with no WebAssembly, which languages, and its measured error rate on political speech. The spike's ADR must exist before the classifier is built.

## 7. Privacy rules

These add to §9 of the MVP spec.

- **Shelf records are the only readable bytes the relay holds.** The end-to-end scan proves it: every canary outside a published entry is absent from the stopped relay's files.
- **A record names no person.** No member's name, key or id, no author, no count, no ballot.
- **Only listed groups are watched,** and only their public records.
- **A live observer of the relay can tie a listed group's name to its sealed mailboxes and to its members' IP addresses,** because a member's device posts the listing from the same IP address as its group syncs. The pilot notice and the listing composer both say so (#486). Accepted for the pilot; it goes to the outside review (ADR-0058), and §9 lists it.
- **Reading a door's page** still shows the relay that an address asked for it, as today.
- **A report carries no reporter.** It comes from the reporter's IP address, as any request does.
- **The registry can be enumerated.** That is its purpose, and the composer says so before the vote.

## 8. Quality gates

The gates in CLAUDE.md apply to every issue. In addition:

- **Relay:** tests for every refusal, for the caps at their boundaries, and that a shelf request leaves no client address anywhere.
- **Fold:** golden vectors for every rule in §4.3, and properties for the caps and for name ownership under any arrival order the relay could produce.
- **Screens:** axe on Discover, the listing composer, the two-line ballot, the console and each tombstone, in both themes.
- **End to end:** the five success steps of §1, with a relay scan.

## 9. Deferred

Each waits for its trigger and returns through an ADR.

| What waits | Stands in for it | Trigger |
|---|---|---|
| Who votes on appeals and the moderation policy | The founder's steward seat | Before any group beyond the founder's is released |
| Reconcile-the-group as a governed group, with the covenant as its Document | A covenant shipped in the app | The same, and ADR-0035's wording |
| Panels drawn by lot for appeals | The steward | The electorate decision |
| Open mode: listings live at once, a burst trip into held mode, window rollback, youngest-first eviction | Held mode | The covenant gate opens |
| A name that survives a membership's end | The steward resolves collisions by hand | The same |
| A listing key held apart from the door's secrets | The door's `sign` key | The outside review, or the first forged listing |
| Posting a listing from somewhere a live observer can't tie to the group's mailboxes | Members' devices post it from the IP addresses they sync from; the pilot notice and the covenant say so (§7) | The outside review (ADR-0058) |
| Coalitions as listed levels, and a shelf line on promote motions | Groups only | ADR-0077's open question on a coalition's front door |
| Pass-along as a button inside a group | The entry's link | Pilot feedback |
| Taking one entry down by vote | Unlisting, or the entry's 30 days | A pilot group asks |
| A "not taking asks right now" switch | A listed door takes asks | A pilot group asks |
| The Bedfellows view | Newest first | #428 |
| Folding near-duplicate entries | The caps | The first flood |
