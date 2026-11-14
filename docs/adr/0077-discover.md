# ADR-0077: Discover: a Voted Public Shelf, Door-Based Asks, and On-Device Kinship

- **Status:** Accepted; the shelf's publishing side waits on the eternal core's wording ([ADR-0035](0035-reconcile-group-minimal-eternal-core.md)) and on the spike in §1
- **Date:** 2026-11-14
- **Decided via:** `/decide` sheet `2026-11-14-discover`, decisions `feed-reach` (the founder's own: pass-along plus a per-Dispatch public shelf), `read-to-join` (`door`), `resume` (`snapshot`), `influence` (the founder's own: a strange-bedfellows algorithm), `find-group` (`door-cards`), `handover` (`share-sheet`, `paste-spot`), `placement` (`tabs`)
- **Builds on:** [ADR-0001](0001-local-first-trust-model.md), [ADR-0009](0009-per-group-identities.md), [ADR-0013](0013-covenant-on-reach.md), [ADR-0037](0037-holonic-promotion.md), [ADR-0038](0038-optional-discovery.md), [ADR-0040](0040-group-opt-ins-are-governed.md)
- **Amends:** [ADR-0038](0038-optional-discovery.md) and [ADR-0074](0074-mvp-scope-revised.md) ("There is no public index")

## Context

The app has per-group Dispatch lists, front doors, personal Documents with share links, and reconciling by a card link. It has no place to read across groups, no way to meet a group you aren't tied to, and no in-app place for a group to receive a reconcile card. The founder asked for a Discover page that reads like a feed of short posts, inspires joining, lets personal Documents speak for an applicant, and starts coalitions.

ADR-0074 kept "no public index" for the MVP, and ADR-0038 made any index a further opt-in governed by the covenant. This ADR lifts that line for one narrow thing: single Dispatches a group or coalition votes to show in public.

## Decision

### 1. The shelf: single Dispatches, public by vote

- **The shelf is a public list of Dispatches, never of groups or people.** There is still no directory of groups, no roster, and no member count on it.
- **A group turns the shelf on by a rules Proposal** at the entrenched bar, like any widening opt-in (ADR-0040). Until it does, nothing below is offered. Turning it off takes the ordinary bar.
- **Each Dispatch is then decided on its own, inside the vote that sends it** (ADR-0037's Dispatch Proposal and promote motion). The ballot gains a second line, "Put our name to this on the public shelf", scored 0–4 and tallied separately at the ordinary bar. A level can send or carry a Dispatch without publishing it.
- **A name is tied to a shelf entry only by that level's own pass.** If a group publishes and the coalition above carries the Dispatch but doesn't pass its shelf line, the entry names the group alone. If the coalition passes it, the entry names both.
- **An entry holds** the Dispatch's title and text, the names of the levels that published it, and each one's front-door address when its door is open. Nothing else: no author, no totals, no Document link.
- **Pass-along stays.** A shelf entry has a link a person can hand to another person, who then sees it on Discover.
- **The shelf is pull only.** It sends no notification and no push, so ADR-0071's "no Reconcile-wide broadcast" stands.
- **A spike settles the rest before anything publishes:** where entries live on the relay and how a reader checks that the named levels really passed them, spam and abuse, how long an entry stays, and how a level takes one down. Its findings amend this ADR.

### 2. From reading to asking

An entry shows **Ask to join** for each named group whose front door is open, and it opens that door. A group with a closed door can't be asked from Discover.

### 3. Personal Documents as a resume

A front-door application can carry **a copy of personal Documents the applicant picks**, sealed inside the application to the door's key. Nothing is attached by default. The picker says in words what the group will read. Each device deletes the copy when the application is dismissed or answered.

### 4. Kinship: strange bedfellows, computed on the device

- Discover has a **Bedfellows** view that surfaces entries from groups that share something with the reader but not everything: a middle band of likeness, not the closest matches.
- **It runs on the device.** The device compares shelf entries with the reader's personal Documents and the Documents of their groups. Nothing about the reader, and no likeness score, leaves the device. Every device fetches the same shelf, so what a device fetches says nothing about its reader.
- **No likeness between groups is ever stored or published.** The relay holds no graph of who resembles whom.
- Each surfaced entry says why in words ("You both write about …"). A Newest view stays one tap away.
- The scoring and the width of the band are tunable, and a spike picks the first values against sample writing.

### 5. Front doors take reconcile cards

A group with an open front door also receives reconcile cards there. A person in a group sees **Propose reconciling with this group** on the door's page and on a shelf entry that names it. The card arrives in the other group's Applications as a quiet row, to bring to a vote or dismiss. Hand-to-hand card links stay.

### 6. Handing links over

A reconcile card and a follow link gain a **Share** button that opens the device's share sheet, beside Copy. Discover has an **Open a card or link** field, as Start has.

### 7. Where Discover lives

The app gains a bottom tab bar: **Groups** (today's Start, and still the opening screen), **Discover**, and **Me** (personal Documents and Settings).

## Why

- A shelf of single, voted Dispatches gives a newcomer something to read without listing who exists. A group is exposed only by words it chose to publish, one vote at a time.
- A closed door is a governed choice, so Discover doesn't route around it.
- A sealed copy leaves no reusable link that ties one application to another (ADR-0009).
- Ranking by closeness would hide the people a reader disagrees with. Surfacing partial likeness is the product's purpose.

## Consequences

- **The shelf is the first content the relay holds that anyone can read.** Everything else stays sealed. The end-to-end scan must show that shelf entries are the only readable bytes.
- **A published entry can be copied before it's taken down.** The ballot line says so.
- **Blocked on the eternal core.** ADR-0035 says its wording must be settled before discovery ships, because the covenant governs reach (ADR-0013). Reading, the tab bar, door cards, the resume and the share sheet don't wait. Publishing to the shelf does.
- Not lifted: a directory of groups, a list of groups open to reconciling, likes or counts (DESIGN.md), and any ranking by engagement.

## Open questions

- The spike's four: storage and proof, abuse, how long an entry stays, and takedown.
- Whether a coalition gets a front door of its own. Today only groups have one, so a card can reach a coalition only by hand.
- Whether a suspended group's entries (ADR-0016) leave the shelf at once or by vote.
