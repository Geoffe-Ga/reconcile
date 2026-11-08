# ADR-0012: Dispatches Arrive by Content-Free Push

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-system-design`, decision `dispatch-delivery`

## Context

The outer loop depends on reaching Members. Push services (Apple, Google, browser vendors) see when a device receives a message and from which service. Email needs an address, which is an identity.

## Decision

**Push is opt-in and carries no content,** only "something new". The app wakes, fetches the encrypted Dispatch from the relay, and decrypts it on the device. There is no email channel.

## Consequences

- Push providers can still see that a device uses Reconcile and when it gets wake-ups. Batch and jitter wake-ups so their timing doesn't track any one group's activity.
- On iOS, push works only for an installed PWA (ADR-0005). Without push, members see Dispatches when they open the app.
- No email list exists to leak or subpoena.
