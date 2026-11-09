# ADR-0003: Three Fixed Involvement Levels, Built to Evolve

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-phase-0`, decision `involvement-levels`

## Context

When people join a group, they choose an involvement level, but the levels and their permissions were never defined. They decide who can propose changes and who can vote, which is the core of governance and of resistance to capture.

We considered fixed tiers, levels each organization defines, and levels earned over time.

## Decision

**Three fixed levels, the same in every group:**

| Level | Follows and gets Dispatches | Votes | Proposals changes |
|---|---|---|---|
| **Member** | ✓ | | |
| **Collaborator** | ✓ | ✓ | |
| **Co-Creator** | ✓ | ✓ | ✓ |

**Build no more than this (no YAGNI violations), but don't close the door on per-group roles.** The eventual direction is per-group configuration similar to Discord roles, but easier to set up. To keep that path open cheaply:

- Code checks **named capabilities** (`follow`, `vote`, `propose`, …), never level names directly.
- One place maps each level to its capabilities. Today that map is fixed and global.
- Moving to per-group roles later means letting a group supply its own map. No permission check has to change.

Don't build a role editor, per-group configuration, or custom levels until a real group needs them.

## Consequences

- Permissions are the same in every group, so members always know what a level means.
- Groups with unusual needs must make do with three levels for now.
- The capability indirection costs almost nothing now and saves rewriting every permission check later.

## Open Questions

- **Mass joins.** The decision sheet's highest risk: a coordinated group joins all at once and outvotes the founders. The proposed mitigation is a short waiting period before new Collaborators can vote, plus alerts on mass joins. Not yet decided.
- **Changing levels.** Can anyone promote themselves to Co-Creator, or does the group approve it? Undefined.

## Amendment (2026-11-07): Names Corrected, Promotion Settled

Superseded in part by [ADR-0021](0021-level-names-and-self-selection.md). The levels are named **Member** (follows), **Collaborator** (votes), and **Co-Creator** (votes and creates). The capability model above is unchanged. "Changing levels" is resolved: it's self-selected once voting rights are earned.

## Amendment (2026-11-08)

Mass joins are answered: 2 vouches and a 14-day wait before voting ([ADR-0014](0014-invite-and-vouch-admission.md)), plus a steward alert when one invite link admits 5 or more people within an hour ([ADR-0053](0053-multi-use-invites.md)).
