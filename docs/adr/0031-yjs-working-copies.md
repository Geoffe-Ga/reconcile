# ADR-0031: Working Copies Use Yjs; Frozen Versions Hash Normalized Text

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided via:** `/decide` sheet `2026-11-08-reconcile-stack-details`, decision `crdt`
- **Refines:** [ADR-0006](0006-signed-log-plus-crdt.md); resolves spec §9 spike 1

## Decision

- **Working Copies are Yjs documents**: pure JavaScript, MIT, about 20 KB gzipped, with the smallest updates in the standard benchmark (about 27 bytes per typed character, against about 110–120 for Automerge and Loro).
- **A returned version is frozen to the SHA-256 of its normalized text** (ADR-0023: NFC, UTF-8), never to the library's bytes. Yjs, Automerge, and Loro all lack a byte-stable encoding, and hashing text keeps frozen versions independent of the library.
- **Yjs sits behind an interface** in the client engine, so the library can be swapped without touching the protocol.
- **Updates are debounced, and compacted into encrypted snapshots periodically**, so loading doesn't replay thousands of tiny encrypted updates.

## Consequences

- Before the first release, measure the bundle in our own Vite build. The benchmark figures come from older versions.
- Yjs is mostly one maintainer. The MIT license and the interface boundary are the mitigation.
- Precedents: Proton Docs, and secsync (end-to-end-encrypted Yjs through a relay).
