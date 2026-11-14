# ADR-0038: Discovery Is Optional; Groups Can Open a Front Door

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `discovery` (chose `front-doors`, with the founder's notes)
- **Builds on:** [ADR-0009](0009-per-group-identities.md), [ADR-0014](0014-invite-and-vouch-admission.md), [ADR-0013](0013-covenant-on-reach.md); governed by [ADR-0040](0040-group-opt-ins-are-governed.md)

## Context

Reconcile isn't only for political organizing ([use cases](../use-cases.md)). Families, fan and creator communities, recovery fellowships, workplaces, and movements each want different things from discoverability, for different reasons.

## Decision

- **Discoverability is optional and off by default.** Sharing an invite card stays the default way in.
- **A group can open a front door:** a public page with the group's name, a mission excerpt, and an application form. Applicants are still admitted by invite, vouches, and the wait (ADR-0014). Their application reaches the group encrypted to the group's front-door key; the relay sees a sealed blob (ADR-0019).
- **A front door never lists people.** No member names or roster. A member count stays hidden unless the group opts to show it.
- **Being listed in a public index of front doors** is a separate, further opt-in. The covenant governs it (ADR-0013).
- **Opening, changing, or closing a front door is a group decision**, made by Proposal (ADR-0040).
- No anonymous "your coalition mates are in…" hints. They leak under real attacks.

## Consequences

- Phase 2: the front-door page, the application flow, and the optional index.
- The threat model applies per group. A recovery fellowship or a vulnerable movement chapter should never be pushed toward opening a door. The UI says plainly what a front door exposes.

## Amendment (2026-11-12): a membership's end closes the door

**Decided by the founder on 2026-11-12** ([#288](https://github.com/Geoffe-Ga/reconcile/issues/288), option 3: close the door on leave).

A door's two secrets, the page signing key `sign` and the inbox key `box`, travel in the group's sealed log. They don't change when the group key does ([#98](https://github.com/Geoffe-Ga/reconcile/issues/98)). So someone who leaves, or is removed by vote, keeps them, and could read every new application, forge the door's page, and send applicants forged invites.

- **Closing no longer always takes a Proposal.** When a membership ends (a `leave`, or the `remove` that follows a removal's pass), an open door closes on every device. Each device's fold closes it at that record, with no event of its own. Reopening takes a new opening Proposal, made once the key has changed, with fresh secrets: a new address and a new link, at the entrenched bar like any opening (ADR-0040).
- **Secrets someone who left could read never open a door again.** That covers a door brought back, a door in a vote that was still open when the membership ended, and one posted while the key change was still due.
- **The old link reads closed for good.** Each member's device posts a final page there, which readers let no later copy outrank, so neither a forged nor a replayed open copy ([#277](https://github.com/Geoffe-Ga/reconcile/issues/277)) reopens it.
  - A reader can verify only the door's own key, which the former member holds. So the final page protects the old link only while a member's device keeps a copy on the relay.
  - [#366](https://github.com/Geoffe-Ga/reconcile/issues/366) decides whether to accept that for the pilot or have the relay keep a tombstone.

The spec's §4, Front door, has the rules.

## Amendment (2026-11-14): a shelf of single Dispatches

[ADR-0077](0077-discover.md) lifts "no public index" for one thing: single Dispatches a group or coalition votes to show in public. There is still no directory of groups or people.
