# ADR-0042: Broad Device Support, with Honest Warnings on Older Devices

- **Status:** Accepted
- **MVP:** partly deferred by [ADR-0073](0073-mvp-scope.md) until pilot feedback asks for it.
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `support` (chose `broad`; the founder's note: "Be clear about the hazards of outdated devices, but we can't expect the audience of this app to be tech savvy and fully updated.")

## Decision

| Platform | Supported from | Notes |
|----------|----------------|-------|
| iOS / iPadOS Safari (installed) | **16.4** | 16.4 is the first version with Web Push for installed apps. Below 18.4, PRF isn't used (ADR-0030) and push uses a service worker rather than declarative push. |
| Android | **10**, with current Chrome | Chrome updates independently of the OS |
| Desktop | Current Chrome, Edge, Firefox, Safari | |

**On older devices the app tells the truth plainly.** When the OS is below the version the app recommends (iOS 18.4, Android 13), Settings shows a calm, specific notice. It is not modal, not blocking, and not shown again and again. For example:

> Your iPhone is running iOS 17. Reconcile works, but it can't use your passkey to protect your keys, and older iOS versions miss security fixes. If you can update, it'll protect you better. Make sure your recovery contacts are set up.

The same notice appears once in onboarding. It follows the `DESIGN.md` voice: plain, not alarming, never guilt-driven.

## Consequences

- The test matrix grows. Epics 3 and 6 test iOS 16.4, 17.x, 18.4+, Android 10, and a current Android.
- Code paths branch on capabilities (PRF available, declarative push available), never on version strings.
- Push isn't available below iOS 16.4. Those devices are unsupported, and they can't install a PWA with push anyway.
