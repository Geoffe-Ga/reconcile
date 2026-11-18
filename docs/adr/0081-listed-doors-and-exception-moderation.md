# ADR-0081: Listed Doors, a Shelf Only They Publish To, and Moderation by Exception

- **Status:** Accepted (the founder, 2026-11-17). It records the founder's choices of 2026-11-14 to 2026-11-17, made in conversation, and the founder accepted it as written, protocol details in [the spec](../spec/listed-doors.md) included. Written as ADR-0078 on its branch; renumbered 0081 on merge, since the landing page holds 0078 and vote links and Bedfellows took 0079 and 0080.
- **Date:** 2026-11-17
- **Answers:** the spike in [ADR-0077](0077-discover.md) §1 (#427): storage and proof, abuse, how long an entry stays, takedown, and the covenant gate
- **Builds on:** [ADR-0013](0013-covenant-on-reach.md), [ADR-0016](0016-suspend-then-vote.md), [ADR-0035](0035-reconcile-group-minimal-eternal-core.md), [ADR-0038](0038-optional-discovery.md), [ADR-0040](0040-group-opt-ins-are-governed.md), [ADR-0077](0077-discover.md)
- **Amends:** ADR-0077 §1, ADR-0038, [ADR-0074](0074-mvp-scope-revised.md), [ADR-0007](0007-thin-python-relay.md), [ADR-0028](0028-relay-fastapi-sqlite.md), [ADR-0020](0020-us-nonprofit-zero-knowledge.md)

## Context

Signing keys are free and there is no global identity (ADR-0009). So a reader can check that a key signed a shelf entry, but not that a real group stands behind it. Two attacks follow: a flood of entries from empty groups, and an entry under a name that looks like a real group's.

The founder weighed gates that would prevent these (a steward's list, proof of work, vouching, blind tickets, paid stamps) and judged that none prevents them at an acceptable cost. This ADR takes the other road: narrow who can be seen at all, then detect and undo harm after the fact.

## Decision

### 1. You see a level you aren't part of only if it is listed

- **The app never shows a person a group they aren't part of unless that group is listed.** Two exceptions: every level in the person's own coalition tree, and a link that another person hands them (an unlisted door, a reconcile card, a follow link).
- **Listing is a property of an open front door.** A group lists its door by a rules Proposal at the entrenched bar, like any widening opt-in (ADR-0040). Unlisting takes the ordinary bar.
- **An unlisted door stays free.** A door reachable only by its link needs no covenant and appears in no registry. Groups doing politically risky work can still take applicants by hand.
- **Listing and publishing are one status.** ADR-0077's separate `shelf` opt-in is withdrawn. Only a listed group can put a Dispatch on the shelf, and each Dispatch is still published by its own line on its ballot.
- **A shelf entry names only listed levels.** A coalition has no front door (ADR-0077's open question), so only groups publish for now.

### 2. The registry is public by the group's own vote

- **There is a registry of listed doors:** each one's name, its door address and the covenant version it accepted. Anyone can read all of it.
- **It holds no people, no membership and no unlisted group.** There is still no registry of who belongs to what.
- This is the "public index of front doors" that ADR-0038 left as a further opt-in. It lifts ADR-0077's "the shelf never lists groups" and ADR-0074's "no public index" for listed doors only.

### 3. Listing means accepting the covenant

- **A listing carries the hash of the covenant version the group voted to accept.** The covenant adds two rules to the eternal core: no spam and no impersonation.
- **Admission is by default.** Nobody votes a group in. Breaking the covenant costs the listing, never the group (ADR-0013).
- **The covenant gate stands.** Until the eternal core is worded and read by counsel (ADR-0035), the relay holds every new listing until the steward releases it, and the steward releases only the founder's own groups.

### 4. Moderation is by exception, over public bytes only

- **What is watched:** a listed group's registry name, its shelf entries and the timing of its public writes. Nothing sealed is read, and no unlisted group is watched at all.
- **Mechanical rules act on their own.** A look-alike name loses to the earlier listing. A listing may hold a few live entries and add one a day.
- **Judgment rules only flag.** A reader's report, or a text classifier bundled with the app, puts an entry in the steward's queue. Neither hides anything.
- **A hold is reversible and lapses.** A steward's hold hides an entry for 7 days unless the steward upholds it. An upheld breach leaves a public notice naming the clause.
- **Affected devices are told without the platform learning who they are.** Each device matches public removal notices against its own history of applications and cards.
- **One preventive rule:** a door listed for under 30 days, or held, can't receive attached personal Documents (ADR-0077 §3), because a fake door keeps what it was sent.

### 5. What waits

- **Who votes on appeals and on the moderation policy.** Listings are free, so "every listed group votes" would let fake groups capture the covenant. The founder left this open. It must be decided before any group beyond the founder's is released. Until then the founder's steward seat (ADR-0035) hears appeals.
- **Reconcile-the-group as a governed group**, panels drawn by lot, the open mode with its burst trip and window rollback, pass-along inside a group, per-entry takedown by vote, and a "not taking asks" switch. The spec lists each with its trigger.

## Why

- Reach that follows real relationships removes most of the flood: an empty group reaches nobody.
- A registry of groups that chose to be public is not the database the threat model forbids. Anyone could archive the shelf and build the same list.
- A registry is a namespace, so look-alike names can be refused by a rule every device computes the same way.
- Automated action that only ever holds, and lapses, can't silence a group for good by mistake or by a stolen key.

## Consequences

- **The relay verifies signatures on public records and keeps new tables** for them. It still can't read or link anything sealed. ADR-0028 requires this ADR for the new columns.
- **ADR-0020's "no client-side scanning" needs one clarification:** the classifier reads only shelf entries, which are public, and only on a steward's device. It never reads a group's sealed content.
- **A named group's traffic is visible to a live observer of the relay.** A member's device posts the listing from the same IP address as its group syncs. That ties a public name to sealed mailboxes and to members' addresses, for whoever watches the relay live. It is an accepted pilot risk, stated in the pilot notice, and goes to the outside review (ADR-0058).
- **A listing ends when a membership ends,** as a door does (ADR-0038's amendment of 2026-11-12). Relisting takes a new vote and a new address, and the name is unprotected in between. The steward resolves that by hand during the pilot.
- **The steward's key is one key on one device during the pilot.** A thief could hold or remove entries until it is rotated by an app release.
- #427 closes with this ADR. #430, #431, #432 and #434 are rewritten to match.
