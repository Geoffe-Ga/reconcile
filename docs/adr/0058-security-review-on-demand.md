# ADR-0058: A Paid Security Review When an Activist Group Calls for It

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-pilot-ops`, decision `security-review` (the founder's own approach)

## Decision

From the founder: "Paid external review when it's actually called for — that is, whenever we get to a point where an activist group doesn't want to join unless there is one (or ideally, timed just right so that we have it just in time for them to ask for it)."

- **What triggers it:** a group facing real threats wants to join, and its decision depends on an outside review.
- **How it's timed:** reviews are usually booked weeks ahead, and grants (for example the Open Technology Fund's Red Team Lab) can take months. **So the first serious conversation with such a group is the signal to start booking.** That way the review lands as they ask for it.
- **Still gated on the review:** the duress PIN (ADR-0046), and any claim in the app or its marketing that Reconcile is safe for high-risk organizing.
- *Assumption, stated rather than asked (none of this costs money):* from day one there is
  - a security contact (`security@` on the project domain, plus a `security.txt` per RFC 9116);
  - a written incident plan;
  - our own threat-model walkthrough before the pilot;
  - dependency and static scans in CI.

## Consequences

- The pilot runs on code without an outside review, so the pilot's organizing group must be one whose content isn't sensitive (ADR-0056).
- Keep the threat model and a list of the security-critical code current, so a reviewer can start quickly.
