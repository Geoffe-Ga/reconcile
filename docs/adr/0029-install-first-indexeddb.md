# ADR-0029: Install First on iOS; Keys and Logs in IndexedDB

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `storage`
- **Resolves:** spec §9 spike 3 (storage persistence), by desk research on 2026-11-07

## Decision

- **On iOS, the app must be added to the Home Screen before it creates keys.** Safari erases data that a site wrote with script after 7 days without a visit. WebKit says Home Screen web apps keep their own counter and aren't expected to be erased, and push only works for installed apps on iOS anyway (ADR-0012). Android and desktop may run in a tab, with installing recommended.
- **Keys, the governance log, and Working Copies live in IndexedDB.** OPFS is deferred until large drafts actually need it.
- **After installing, the client calls `navigator.storage.persist()` and shows the result.** Both Safari and Chrome grant persistence silently, using signals such as installation and interaction.

## Consequences

- The first-run flow begins with an install guide on iOS (sheet 4 designs it).
- WebKit's Home Screen exemption isn't restated in current documentation. That's why social recovery is mandatory (ADR-0030), and why sheet 2 decides on an optional encrypted backup through the relay.
