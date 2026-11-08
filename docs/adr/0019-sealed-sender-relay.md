# ADR-0019: Sealed Sender, Padding, and Batching at the Relay

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided via:** `/decide` sheet `2026-11-07-reconcile-trust-safety`, decision `metadata`

## Decision

The relay (ADR-0007):

- keeps **no request logs**, keeps blobs for a short time, and uses rotating mailbox ids;
- uses **sealed sender**: blobs carry no sender identity the relay can read;
- pads blobs to **fixed size buckets** and delivers in **batches** with jitter.

People who need Tor can open the PWA in Tor Browser. That is documented, not built.

## Consequences

- Bandwidth rises about 20–40%, and batching adds delay.
- The wire format is versioned, because sealed sender is part of the protocol.
- This resolves the metadata question ADR-0007 left open.
