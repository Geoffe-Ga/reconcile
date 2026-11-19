# Draft: amendment to ADR-0077 §1

> Draft for spike #427. Paste the section below at the end of `docs/adr/0077-discover.md`, after the founder answers `/decide` sheet `2026-11-14-shelf-spike`. Each place a sheet answer lands is marked **[sheet `decision`: option]**. The text below assumes the recommended option for each, so a different answer changes only the marked passages, plus whatever they name in **Accepted pilot risks**.
>
> Vocabulary: a **level** is a group or a coalition, as ADR-0037 and §1 use the word. It is never a person's involvement level.

---

## Amendment (2026-11-14, #427): How the Shelf Is Stored, Proven, Kept Clean and Taken Down

- **Status:** Proposed by spike #427. The founder's answers are recorded in **Founder's answers** below; until then, publishing stays blocked.
- **Decided via:** `/decide` sheet `2026-11-14-shelf-spike`, decisions `admission`, `covenant-gate`, `storage`, `key-holders`, `lifetime`, `suspension`.
- **Answers:** §1's spike (storage and proof, abuse, how long an entry stays, takedown), and this ADR's open question on a suspended group's entries.
- **Amends:** [ADR-0028](0028-relay-fastapi-sqlite.md) (public mailboxes: two routes and a DELETE, in the existing `blobs` table), [ADR-0038](0038-optional-discovery.md)'s door page (an optional `shelf` field), and [ADR-0040](0040-group-opt-ins-are-governed.md)'s list of opt-ins (`shelf`).

### Context

§1 settled what the shelf shows and who decides it. It left open how a reader who holds no group's log can trust a name on an entry, and what stops a flood, a look-alike or a forgery. There's no global identity (ADR-0009), so anyone can found a group and pass its vote alone. Every member of a level can read everything that level holds (ADR-0075 §1), and someone who leaves keeps what they read. The relay keeps no per-IP state (ADR-0028, #141). The covenant that governs reach isn't worded yet (ADR-0013, ADR-0035). Two hostile people shape every answer below: a reader who builds a list of groups by ideology, and a writer who puts a group's name on words it never chose.

### 1. Records

The shelf is made of public records: signed, padded to the blob sizes and **not sealed**. A key shipped in every copy of the app would hide nothing, and the relay scan (#434) needs these bytes to be the readable control.

- **A level's shelf key.** While a level's `shelf` opt-in is on, every device in that level derives two keys:
  - a **signing key**: an Ed25519 seed from HKDF-SHA-256 of the level's current secret under `reconcile/v1/shelf-sign` ‖ `0x00` ‖ the UTF-8 id of the Proposal (or coalition motion) that turned the opt-in on;
  - a **write key**: 32 bytes from HKDF of the same secret under `reconcile/v1/shelf-write` ‖ `0x00` ‖ that id.

  For a group, the secret is its current group secret, so a membership's end (#98's new key) gives the level new shelf keys with no event of its own **[sheet `key-holders`: `epoch-key`]**. A coalition's secret doesn't rotate (ADR-0074), so its keys last as long as its opt-in. Turning the opt-in off and on again names a new Proposal, so it gives new keys.
- **The shelf address** is the signing key's public half and its public mailbox id (§2), 86 characters. Rules shows it while the opt-in is on, with Copy, for sending to the steward.
- **An entry record**, one per level per Dispatch, is UTF-8 JSON signed with `signTagged` under the new context `reconcile/v1/shelf`:

  ```json
  {"v": 1, "kind": "entry", "entry": "<id>", "title": "…", "text": "…",
   "name": "<this level's name>", "door": "<address>" | null,
   "below": ["<shelf key>", …], "above": ["<shelf key>", …], "passed": 29411520}
  ```

  - `entry` is the unpadded base64url SHA-256 of `reconcile/v1/shelf-entry` ‖ `0x00` ‖ the Dispatch's id. It's the same at every level (ADR-0037), and it puts no raw log id in public.
  - `title` and `text` are exactly the Dispatch's (80 and 500 code points at most). `name` is the level's name (at most 120). `door` is the group's open front-door address, or null for a closed door or a coalition.
  - `below` and `above` list the shelf keys of the levels below and above this one on the Dispatch's path, in order up from the origin, whose shelf line on this Dispatch has passed.
    - `below` is fixed when this level's line passes. The promote record carries it up, and the level below checks it as #126 checks a Dispatch's text.
    - `above` grows as higher levels pass.
  - `passed` is the relay minute this level's shelf line passed (`shelfOf`, #430).
  - There's no author, no total, no member count, no Document link and no per-member key.
  - The bytes come from the fold alone. Ed25519 is deterministic (RFC 8032), so every device of the level makes the same record, byte for byte.
- **A retire record**, `{"v": 1, "kind": "retire"}` under the same context, ends a shelf key. Readers ignore every record under that key that the relay received after it.
  - Whoever retired the key still holds its write key, and could delete the retire record. So members' devices post it again if it goes missing (§4), and the steward copies its seq into the roll's `retired` list, which no level can touch.
- **The roll** is one record signed by the steward's key under its own context, `reconcile/v1/shelf-roll`:

  ```json
  {"v": 1, "kind": "roll", "version": 7,
   "levels": [{"key": "…", "read": "…", "name": "<commitment>"}],
   "retired": [{"key": "…", "seq": 812}],
   "withheld": ["<entry id>", …], "suspended": ["<shelf key>", …],
   "notes": [{"about": "<entry id or key>", "reason": "covenant" | "impersonation" | "request" | "legal"}]}
  ```

  - `name` is a commitment, not a name: base64url SHA-256 of `reconcile/v1/shelf-name` ‖ `0x00` ‖ the key ‖ the NFC name. So the roll itself is a list of opaque keys, not a directory of groups. A level's name is readable only beside words it chose to publish.
  - The steward's public key and the roll's mailbox id ship in the app as build constants (production, staging and the e2e build each have their own).
- **Vectors.** `client/src/crypto/vectors/shelf.json` pins every derivation, the entry id, the name commitment and one record of each kind. They're computed outside @noble, with Python's `hashlib` and `cryptography`.

### 2. Storage: public mailboxes

**[sheet `storage`: `write-keys`]** The relay gains **public mailboxes**: anyone can read one by its id, and only the holder of its write key can add to it or delete from it.

- `PUT /v1/public/{key}` stores a blob under the id `base64url(SHA-256("reconcile/v1/public-id" ‖ 0x00 ‖ key))`. `DELETE /v1/public/{key}/{seq}` deletes one record there. `GET /v1/public/{id}` reads it as a mailbox GET does. [relay-routes.md](relay-routes.md) gives every rule.
- **Where entries live.** Each listed level has one public mailbox, its `read` id on the roll. The roll has one more, whose write key only the steward holds.
- The relay checks a hash and some byte counts. It never parses a record, checks a signature, reads the roll, or learns which mailboxes are shelf mailboxes beyond what the public roll says.
- **Publishing.** When a device folds a final pass of its level's shelf line, it posts the entry record to the level's public mailbox at a random relay minute in the next hour, unless the mailbox already holds the same bytes. In practice one device posts, and a duplicate changes nothing.
  - When an upper level's line passes later, the lower levels' devices post a new record with a longer `above`. They delete the one it replaces once the new one has stood a day (§3).
  - When the group's door opens, closes or moves, they post a new record with the new `door`.
  - `ttl_days` is the days left in the entry's 30 (§5), at least 1.
- **Reading.** Every read of the shelf is a whole read: the roll's mailbox, then every listed level's mailbox, all pages, from seq 0, with no cursor. Discover reads it when it opens. Every device, in a group or not, also reads it at most once per relay day while the app is open, at a random minute. So no read says anything about the reader: not their interests, not their groups, not when they last looked.

**Stops:** a stranger putting a byte in front of a reader, since readers fetch only the roll's mailboxes and only the write key can add to them; one person blanking the shelf by filling a well-known mailbox; the relay learning anything from a read.
**Doesn't stop:**
- Anyone flooding unlisted public mailboxes to fill the relay's 1 GiB (ADR-0028's accepted risk, unchanged). No reader ever fetches them.
- A holder of a level's write key filling that level's mailbox up to its 512 KiB cap, or deleting its entries. That's suppression, never a false name.

### 3. Proof: what a reader checks before showing a name

A reader takes the newest roll that verifies under the shipped steward key and whose relay receipt is under 30 days old. Its version must be no lower than the highest version this device has seen, which the device remembers. Without one, Discover shows "The shelf is resting." and lists nothing (fail closed). Then, for each level the roll lists, it shows the level's name on an entry only when **all** of these hold:

1. The record is in that level's listed mailbox. Its key is the listed key, and its signature verifies under `reconcile/v1/shelf`.
2. The NFC `name`'s commitment equals the roll's for that key. The reader then shows the record's `name`, as plain text in `<bdi>`.
3. No retire record under the key comes before it in the mailbox, and its seq is below any seq the roll's `retired` gives for the key.
4. **It has stood a day.** The reader uses the level's newest record for that entry that the relay received at least 1,440 relay minutes before the GET's `now`. A newer one waits its turn, so a change to a level's record (a new `above`, a new `door`) also waits a day. A deletion takes effect at once.
5. `passed` is no later than `now`, and `now` is within 43,200 minutes of both `passed` and the record's receipt.
6. The roll neither withholds the entry nor suspends the key.
7. **Names join only when both sides agree.** Two levels' records for one entry id, each passing 1–6, with the same `title` and `text`, are joined only when the lower one's `above` lists the upper's key and the upper one's `below` lists the lower's. An entry shows each joined set of names together, in order up. A record joined to nothing shows as an entry of its own, under its own name only. So no level can attach itself to another's words, whether from above or below.
8. At most the level's 10 newest entries show (§5).

Ask to join is offered for a group's `door` only once the reader taps it and the door's page, signed by that address, names the same shelf key in its new `shelf` field (#432). A coalition has no door.

**What a reader can verify without the level's log:**
- A holder of the level's current shelf key signed exactly these words, under the name the steward admitted for that key, naming this door and these levels below and above.
- The record has stood a day, the key wasn't retired before it, and the steward hasn't withheld it.
- Each joined pair of levels signed the same words with their own keys, and each one listed the other.
- The roll is the steward's and is no older than one this device has seen.

**What it can't verify:**
- **That a vote happened**, or passed, at what bar, or with how many voters. It can verify only that someone holding the key signed. Every member holds the key, and someone who left holds it until the key changes.
- That the level has more than one person in it, or that its people are who they say.
- That the name belongs to any group or organization outside the app.
- That a coalition really holds the level below. It can verify only that both levels' key holders say so.
- That the relay served every record and honoured every deletion. The relay is trusted for order and time only (ADR-0073).
- That the steward is honest. It can verify only that every change to the roll is public.

**Stops:** a name on words its key never signed; a name the steward never admitted; a level renaming itself after admission; a hostile level attaching its name to another level's entry (7: each side must list the other); a relay forging entries or serving an older roll; a forgery that an honest device deletes within its day (4).
**Doesn't stop:** a key holder signing words the level never passed, if no honest device of that level syncs within a day; the relay withholding records or ignoring a DELETE.

### 4. Abuse

- **Admission by a steward's roll** **[sheet `admission`: `steward-roll`]**. A level reaches readers only once the steward adds its shelf address to the roll. A group founded by one person, or a hundred groups founded by one person, publish nothing until a person judges each one.
  - In the pilot, the steward is the founder, who holds the first steward seat (ADR-0035). The steward adds only the levels the founder belongs to **[sheet `covenant-gate`: `own-groups-first`]**.
- **Look-alike names.** The steward checks a name by hand before adding it: it must not be confusable with a listed name (Unicode look-alikes included), and it must not be a real organization's name unless that organization asked. The name commitment then fixes the name to the key, so a rename needs the steward again. Every roll change is public. A level's own devices hash their name with each listed key, and warn their members if the roll commits any key but theirs to their name.
- **Smear by association.** Under rule 7 of §3, two names appear together only when each level's own record names the other. A hostile level can't claim to sit above or below another group. It can still copy another group's words and publish them as its own entry, under its own name only.
- **Forgery by key holders** **[sheet `key-holders`: `epoch-key`]**.
  - **At a membership end:** the key change (#98) gives the group new shelf keys. The first device to take up the new key posts a retire record under the old one, and Rules shows the new shelf address for the steward. The group's live entries stay until they age out. New ones wait for the steward to add the new address. For the founder's own groups, the founder's device can read that address itself.
  - **Members' devices check the level's mailboxes.** After each whole read (Discover's, or the daily one), a device deletes any record under its level's current key that its fold wouldn't make: a forged entry, altered words, a wrong `below`, `above` or `door`, or a superseded record once its successor has stood a day.
    - For 31 days after a key retires, the device checks that key's mailbox too. It deletes anything posted after the retire record, and posts the retire record again if it's gone. It judges a record only after a full sync pass, over every group and coalition it holds, that began after the relay received the record. Every pass a real record reflects reached the relay before the record did, so a device that's behind never deletes a real entry.
  - **The day's hold** (§3, rule 4) gives that check a day before any reader sees a forgery.
- **What the relay may do,** without reading or keeping per-IP state:
  - check a write key against a mailbox id by hash;
  - cap each public mailbox at `RECONCILE_RELAY_MAX_PUBLIC_BYTES` (512 KiB), and the whole relay at its 1 GiB;
  - expire records by `ttl_days`;
  - delete a record on its write key's DELETE.

  It may not read, parse or filter titles or text, verify signatures, keep rate limits, logs, addresses or counters, or wake anyone for a public mailbox. The operator may delete a row by hand only on a legal demand, and the next roll notes it (`legal`).
- **What the founder does by hand in the pilot:**
  1. Asks for the shelf address of each of the founder's own levels that turns the shelf on, checks that the founder is in it and that its name is unconfusable, and adds it with `scripts/shelf-steward` on the founder's own computer. The steward key never sits on the relay VM.
  2. Posts the roll again at least every three weeks; the script warns. A roll older than 30 days empties every reader's shelf.
  3. Re-adds a level's new address after a membership end in it. The script also:
     - copies the old key's retire seq into the roll's `retired`;
     - keeps the old key on the roll until its entries age out;
     - drops it 31 days after the retire record.
  4. Reads the shelf, and withholds an entry or suspends a key if needed (§6), with a reason code.
  5. Keeps the steward secret in their own backup. Losing it means a release with a new steward key.

**Stops:** one person founding empty groups to flood the shelf (each needs a person's yes, and in the pilot only the founder's own groups get one); a look-alike the steward catches; one level crowding the shelf; a former member forging after the key change; most current-member forgeries.
**Doesn't stop:** a sock-puppet group or look-alike the steward admits by mistake; copying another group's words under one's own name; a current member's forgery in a group where nobody opens the app for a day; a steward who is careless, captured or whose key is stolen, beyond making that visible on the public roll.

### 5. How long an entry stays, and the shelf's size

- **30 days** from its level's pass, then it leaves on its own **[sheet `lifetime`: `30-days`]**. That's the relay's blob retention (ADR-0057), and `ttl_days` makes the relay delete the bytes then. Nothing re-posts an entry to keep it up. A group that wants to stay findable publishes again.
- **Size:**
  - a reader shows at most each level's 10 newest entries;
  - each public mailbox holds at most 512 KiB;
  - the roll's 64 KiB holds about 600 levels.

  At pilot size a whole read is well under 1 MiB. Whole reads stop scaling at a few hundred listed levels. The trigger to revisit is a roll that lists 100.

**Stops:** the shelf becoming a lasting record of what each group said; a seized relay holding more than a month of entries; old words standing for a group whose views have moved.
**Doesn't stop:** anyone who archives the shelf every day.

### 6. Takedown

- **A level takes its name off by vote.** "Take this off the public shelf" is an ordinary Proposal on a published Dispatch, since narrowing exposure is ordinary (ADR-0040). In a coalition it's a motion decided group by group. Once the pass is final, devices delete every record of that entry under the level's key at once. The first device to do so wins, and a repeat costs nothing.
  - Readers drop that level's name. An upper level's own record then stands alone under its own name, since each level controls only its own name (§1).
  - The bytes leave the relay at the DELETE (`secure_delete`).
- **Fast path.** A group's steward narrows the `shelf` opt-in (ADR-0040, ADR-0075 §3). While the narrowing holds, devices delete all the group's live entries and post nothing new.
  - If the off-Proposal passes, they also retire the key.
  - If it fails, the opt-in is back for new Dispatches. The deleted entries stay down: exposure is hard to take back, and retreating should be easy.
- **Turning the opt-in off** by vote deletes every live entry and retires the key. A **dissolve** does the same: it's the last thing a group's devices send (#108).
- **A member's suspension** (ADR-0016) changes nothing on the shelf. The suspended member's device still posts and checks the group's records, since those carry the group's decisions, not theirs.
- **A suspended level** (the covenant's steward denying reach, ADR-0013) **[sheet `suspension`: `entry-first`]**.
  - The steward withholds a single entry at once, with a public reason on the roll. Every reader hides it on their next read.
  - The steward suspends the level's key for a severe or repeated breach. All the level's entries leave every reader at once.
  - Either stays until the steward lifts it or the entry ages out.
  - In the pilot, appeals go to the founder by hand. Reconcile-the-group's appeal by vote (ADR-0013) waits on the covenant gate.
  - The steward can't delete bytes from a level's mailbox, so a withheld entry stays readable on the relay itself until it expires, at most 30 days.

**Stops:** a level's name staying up after its vote, or after it turns the shelf off; the bytes staying on the relay after a takedown; a dissolved group's key being used afterwards; one level removing another's name.
**Doesn't stop:** copies already made (the ballot line says so); a relay that ignores DELETE; a raw read of a withheld entry's bytes for up to 30 days.

### 7. The covenant gate

**What must be worded before groups outside the founder's circle publish:**
1. **The eternal core** (ADR-0035), read by counsel.
2. **The shelf clause.** The one or two sentences the opt-in shows, which the entrenched vote agrees to: what may not go on the shelf, and that the steward withholds what breaks it, publicly, with a way to appeal.
3. **The steward's rules.** Who holds the key: the founder's seat until ADR-0035's threshold, then an election. What the steward may do: refuse to add a level, withhold an entry, suspend a key. That every act is public on the roll with a reason code. How a level appeals.
4. **The steward's admission checks.** A name that isn't confusable with another listed name, isn't a real organization's name unless that organization asked, and belongs to a level that has agreed to the shelf clause.
5. **Counsel's questions.** Whether hosting public text needs a DMCA designated agent (US Copyright Office) before outside groups publish, and how a legal demand reaches the operator.

**Before then** **[sheet `covenant-gate`: `own-groups-first`]**, publishing ships with the steward adding only levels the founder belongs to. The opt-in's line says so ("During the pilot, only groups the founder has added can publish"). Discover says "Groups put their own names here by vote. Reconcile doesn't check a group's name against anything outside the app. Anyone can copy what's here." Lifting the limit waits on items 1–5 and on the outside review (ADR-0058), the same trigger as #435.

### Accepted pilot risks added

- **Any holder of a level's shelf key can sign under its name.** That's every member, and a former member until the key changes. A coalition's key never changes (ADR-0074). The day's hold and members' devices' checks catch a forgery only if someone in the level opens the app within the day.
- **Publishing ties the posting device to the level at the relay, live.** The posting device's address, which also polls the group's weekly mailboxes, ties those mailboxes to the level's public name for whoever watches the relay live (as ADR-0075 §2's polling does for groups). Usually one device posts. Tor Browser is the documented remedy (ADR-0019).
- **A retire record and a new address on the roll show that a membership ended in that group, and roughly when.**
- **The steward is one person, and is a member of every listed level.** The steward could withhold their own groups' entries or admit a look-alike. The roll is public, and a level's devices notice a change to their name.
- **The relay is trusted to serve every record and honour every DELETE.**
- **A copied entry outlives its takedown.**

ADR-0058's outside review covers these.

### Consequences

- **Relay:** two routes and a DELETE, in the existing `blobs` table, with one new setting (relay-routes.md). The private routes don't change.
- **Client:** the `shelf` opt-in has no secret. Its value is `true` or `false`, and the keys derive (§1). The takedown Proposal, the fast path and the dissolve's last writes go in the engine (#430). Records, publishing, the whole read, the checks and members' devices' checks go in sync and net (#431). The door page gains `shelf` (#432).
- **Spec:** §6 gains the public routes; §9 gains the one exception to "nothing readable leaves the device", plus the risks above. The new Shelf section holds §§1–6.
- **Tests:** `relay-learns-nothing`'s sibling finds the published entry's title and text readable as its control, and no other canary. The e2e moves a reader's relay `now` past the day's hold with `readRelayLater` (#127), with no relay mode.
- **#435** (the closed door's tombstone) can reuse public mailboxes: a door page under a write key closes the same flooding gap.

### Not chosen

- **Sealing entries under a key in the app.** Everyone holds that key, so sealing hides nothing and makes the relay scan's control meaningless.
- **One merged record per entry.** Levels would have to coordinate writes, and the relay would have to merge them. A record per level, joined by rule 7, needs neither.
- **Listing on one side only.** If only the lower level listed the upper, a hostile level could claim to sit below a group and pull that group's name onto its words. If only the upper listed the lower, the reverse. Rule 7 needs both.
- **Per-member signatures as proof of a vote.** They'd publish member keys and a count of who voted (ADR-0009, ADR-0010).
- **Threshold signatures.** There's no audited library for them (ADR-0060, ADR-0075 §6), and they still wouldn't prove the consent floor.
- **A per-IP or per-day limit.** It's ruled out by ADR-0019 and the founder's decision on #141.

### Founder's answers

*(Filled in from the sheet's pasted block.)*

---

### README row (proposed)

Replace 0077's row in `docs/adr/README.md` with:

> | [0077](0077-discover.md) | Discover: a public shelf of single Dispatches, each published by its own vote; Ask to join through open front doors; personal Documents sealed into an application; an on-device strange-bedfellows view; doors take reconcile cards; a bottom tab bar. The shelf is signed public records in public mailboxes only a level can write, shown after a day's hold, for 30 days, for levels on a steward's roll, the founder's own groups first (2026-11-14, #427) | Accepted; amended 2026-11-14 (#427); shelf publishing beyond the founder's groups waits on 0035's wording |
