# ADR-0053: Invites Are Multi-Use Links That Expire in 48 Hours

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-onboarding-ux`, decision `invites` (chose `multi-48h`)
- **Refines:** spec §4 (`invite`), [ADR-0014](0014-invite-and-vouch-admission.md)

## Decision

- **One invite link admits up to a set number of people and expires 48 hours after it's made.** It's shared as a link or shown as a QR code.
- *Assumption, stated rather than asked:* the inviter sets the maximum, from 1 to 50, **default 10**. A one-person invite is the same mechanism with the maximum set to 1.
- Admission still needs 2 vouches and the 14-day wait before voting (ADR-0014). So a leaked link can let strangers *in*, but not *vote*.

## Consequences

- The `invite` body changes from a one-time key hash to an invite secret, `max_uses`, and an expiry. Validation rejects a `join` past `max_uses` or after expiry. Test vectors cover both.
- The inviter sees how many people used a link, and can revoke it early.
- Mass-join alerts (ADR-0003's open risk): a steward is notified when one link admits 5 or more people within an hour.
