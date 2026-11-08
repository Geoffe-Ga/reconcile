# ADR-0056: The Pilot: Two Contrasting Groups, Six Weeks, Learned Through People

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-pilot-ops`, decisions `pilot-shape`, `learning`, `paperwork`

## Decision

- **Two groups from the founder's circle, 5–15 people each, for 6 weeks.** One is an everyday group (family or friends). The other is an organizing or community group whose content isn't sensitive, because the app hasn't had an outside review yet (ADR-0058).
- **No telemetry. We learn from people:**
  - short interviews at week 2 and at the end;
  - an opt-in anonymous survey;
  - a dedicated Signal group, with disappearing messages, for bugs and questions.
- **Success means all of:**
  - each group completes the loop (Proposal → vote → update) at least 3 times;
  - at least 70% of members vote at least once;
  - nobody loses their keys.
- **Testers accept a plain, one-page notice in the app at join.** It covers what's stored, what the relay can and can't see (timing and size buckets, not content), that data loss is possible beyond the encrypted backup, and that this is a test. Written by us; a lawyer reviews it at Stage 2 (ADR-0033).

## Consequences

- Before inviting testers, check their devices against ADR-0042.
- Epic 6's acceptance criteria use the success bar above, alongside spec §1's at least 5 testers on at least 3 devices.

## Amendment (2026-11-08, four-lenses review)

The interviews also ask whether anyone changed their mind, whether disagreements ended livably, whether anyone felt shut out, and whether relationships improved, and the write-up lists what we aren't measuring ([ADR-0069](0069-lapses-celebration-relational-pilot.md)).
