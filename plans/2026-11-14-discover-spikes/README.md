# Discover spikes #427 and #428: drafts as of 2026-11-14

These are the working drafts from the two Discover spikes, kept for the record. **They are superseded:** don't build from them.

- **#427, the public shelf.** [ADR-0081](../../docs/adr/0081-listed-doors-and-exception-moderation.md) (2026-11-17) answers this spike, and the [listed-doors spec](../../docs/spec/listed-doors.md) has the protocol. The drafts in `427-shelf/` predate it, #434 and #494.
  - The founder's sheet answers of 2026-11-14:
    - **Who may publish:** left open for a brainstorm. ADR-0081 later answered it with listed doors and moderation by exception.
    - **The covenant gate:** your groups first.
    - **Where entries live:** public mailboxes with write keys.
    - **Forgery by key holders:** a new key per group key.
    - **How long an entry stays:** 30 days.
    - **A level that breaks the covenant:** its entry comes down at once.
  - What's here:
    - `amendment-0077.md`: the draft ADR-0077 amendment;
    - `relay-routes.md`: the draft relay routes;
    - `issue-bodies.md`: draft bodies for #430–#434;
    - `decide-sheet.json`: the sheet.
- **#428, the bedfellows score.** [ADR-0080](../../docs/adr/0080-bedfellows-algorithm.md) (2026-11-17) sets the algorithm: claims matched by an on-device embedding model, stance checked, and a slow-clock stretch. The term-overlap score this spike built is the commit before this one on this branch. ADR-0080 keeps its idea as the fallback, which main builds as `client/src/bedfellows/baseline.ts`.
  - The founder's sheet answers of 2026-11-14:
    - **Method:** word overlap rejected. Matching should be semantic and stance-aware.
    - **The band:** deferred. Stretch readers toward stranger bedfellows over time.
    - **Same subject, other side:** deferred. For and against are not common ground.
  - What's here:
    - `bands.md`: the bands comparison on the sample corpus;
    - `amendment-0077-s4.md`: the draft §4 amendment;
    - `brainstorm-prompt.md`: the brief that led to ADR-0080;
    - `decide-sheet.json`: the sheet.
