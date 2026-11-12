### Capabilities

`can(state, member, capability)` is the only permission check, and it's false for non-members (#63). It reads the member's level through `LEVEL_CAPABILITIES` in `client/src/engine/capabilities.ts`, the one map from levels to capabilities ([ADR-0003](../../../adr/0003-three-tier-involvement-levels.md), [ADR-0021](../../../adr/0021-level-names-and-self-selection.md), #90):

| Level (id) | Capabilities |
|---|---|
| Member (`member`) | `read`, `see-roster` |
| Collaborator (`collaborator`) | `read`, `see-roster`, `vote`, `vouch`, `invite`, `propose-removal` (#115) |
| Co-Creator (`co-creator`) | `read`, `see-roster`, `vote`, `vouch`, `invite`, `propose-removal` (#115), `propose`, `dispatch` (#112) |

- Each person chooses their level at Join and changes it with a `level` event whenever they like, and the change takes effect at once. Until their voting rights arrive, every level grants only a Member's capabilities (#101, §4, Vouches and the wait before voting).
- Every level holds `see-roster` until the hidden roster returns (ADR-0074, §12).
- `wouldVote(state, member)` decides who enters a Proposal's eligible set: the member holds voting rights (#101) and their level grants `vote`. It ignores suspensions, so a suspension never shrinks the electorate (ADR-0075 §3).
- **Stewards** (#102, #117). Holding a steward seat adds `suspend` and `narrow` to the holder's level, unless they're suspended. While a member's suspension runs, at `state.at`, `can()` grants them only `read` and `see-roster`, whatever their level or seat.
- **Removal** (#115). Both voting levels hold `propose-removal`, so a Collaborator may propose removing someone though not a change to the Document (ADR-0049). Once a removal of a member has passed (`state.removals`, which `can()` reads), `can()` grants them only `read`, whatever their level, seat or suspension, until a `remove` takes them out.
- Code never compares level names. Only `capabilities.ts` and the golden vectors spell out a level id, and a test fails on one anywhere else in `src/`. Screens take ids from `LEVELS` and labels from the messages module, in `LEVELS` order.

---
