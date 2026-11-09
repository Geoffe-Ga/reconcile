# ADR-0055: WCAG 2.2 AA Checked Automatically; English, Translation-Ready

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-onboarding-ux`, decisions `accessibility` (chose `aa-auto`, with the founder's note), `languages`

## Decision

- **Target: WCAG 2.2 AA.** axe checks run in component and end-to-end tests, and a violation fails CI.
- **Manual screen-reader passes** (VoiceOver on iOS, TalkBack on Android) **happen periodically, not on every release.** From the founder's note: "more sporadic, especially at the start while resources are slim."
- **English ships first, translation-ready.** Every interface string lives in a message catalog from the first screen, and layouts are tested with longer text. A new language then needs translation, not code.

## Consequences

- The client gate adds axe (Epic 3).
- A message-catalog library is chosen when the first screen is built. The criterion is ICU message support.
- Each language gets a glossary for governance terms (Proposal, consent floor, split), reviewed by native speakers from the community.

## Amendment (2026-11-08, four-lenses review)

The glossary term "split" is now "part ways" ([ADR-0068](0068-part-ways.md)).
