# ADR-0011: Groups Link Their Own Chat; Coalitions Get a Reconcile-Hosted Room

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `debate-venue`

## Context

The voting slide has a messenger app ("to be decided later") host each debate. Reconcile is where decisions are made, not a chat app. But a coalition formed from a Discord server and a Facebook group has no shared home.

## Decision

- **Groups link any chat.** A Pitch carries a link to wherever the group already talks.
- **Coalitions get an optional Reconcile-hosted discussion space.** It's end-to-end encrypted and travels the same local-first path as everything else (signed events through the relay). The relay can't read it.
- **Proposed, not decided: platform integrations.** The user envisions Discord servers, WhatsApp groups, Facebook groups, subreddits, and Slack workspaces running a Reconcile group from inside their platform (pitch, vote, and notify there).

**From the user's notes:** the in-house space is needed only because nothing else lets several platforms share one decision-making place. If a better way to cohabit across platforms appears (for example Matrix bridges), revisit this ADR.

## Consequences

- **The hosted space must stay small.** It needs threads per Pitch and the "argument concluded" message, not a full chat product. Scope creep is the main risk.
- **Integrations conflict with ADR-0001.** A bot inside Discord sees members and votes in plaintext on Discord's servers. Before any integration is built, a follow-up ADR must say what data is allowed through and warn members that their platform can see it.

## Amendment (2026-11-07)

Platform integrations are decided in [ADR-0039](0039-integrations-per-group-opt-in.md): a per-group ladder of bot reach and sight, nudge-only by default, changed by Pitch ([ADR-0040](0040-group-opt-ins-are-governed.md)).
