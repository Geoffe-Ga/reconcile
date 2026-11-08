# ADR-0039: Platform Integrations Are Opt-In, Group by Group

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-remaining`, decision `integrations` (chose `per-group-choice`, with the founder's notes)
- **Resolves:** the proposal in [ADR-0011](0011-debate-venues.md); governed by [ADR-0040](0040-group-opt-ins-are-governed.md)

## Decision

A group decides, by Pitch, how far its bot may **reach** (post into the home chat) and **see** (read from it). The default is the shallowest useful step. Each step up comes with a plain warning about what the chat platform's servers will then hold in plaintext.

| Step | The bot may… | The chat platform then holds |
|------|--------------|------------------------------|
| 0. Off | nothing | nothing |
| **1. Nudge (default)** | post content-free notices ("A new Pitch is open. Open Reconcile.") | that the group uses Reconcile |
| 2. Publish | also post the canonical text of Documents the group voted to publish | published text, which is public anyway |
| 3. Listen | also read messages in channels the group names, for example to link a discussion to a Pitch | those channels (already on the platform) and that the bot reads them |
| 4. In-platform | also run Pitches and open-ballot votes in the chat, **only for Documents the group marks non-sensitive** | those Pitches, ballots, and voter handles, in plaintext |

These never pass through a bot, at any step: rosters, vouches, sensitive Documents, Working Copies, and duress-hidden groups (ADR-0018).

## Consequences

- Phase 3 for steps 2–4. Step 1 can ship alongside link-any-chat (ADR-0011).
- Step 4 needs a per-Document `sensitivity` flag. Ballots cast in-platform are bridged into the group log by the bot, signed with a bot key the group approved.
