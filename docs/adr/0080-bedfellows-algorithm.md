# ADR-0080: Bedfellows Matches Claims, Checks Stance, and Stretches on a Slow Clock

- **Status:** Accepted (written as ADR-0079 on its branch; renumbered 0080 on merge, since vote links took 0079); every threshold and model named here is provisional until the evaluation in §8 passes
- **Date:** 2026-11-17
- **Decided via:** `/decide` sheet `2026-11-14-bedfellows-algorithm`, decisions `matching-method` (`claim-embeddings`), `model` (`english-small`), `stance` (`nli-leave-out`), `band-stretch` (`slow-clock`), `signals-memory` (`sealed-history`), `safeguards` (`tier-floors`, `bridge-bonus`, `shared-enemy-check`), `explanation` (`paired-quotes`)
- **Amends:** [ADR-0077](0077-discover.md) §4 (how kinship is scored, what the reason says, and what the device may keep)
- **Builds on:** [ADR-0001](0001-local-first-trust-model.md), [ADR-0018](0018-device-protection-and-duress.md), [ADR-0046](0046-padded-vault-and-panic-wipe.md), [ADR-0077](0077-discover.md)

## Context

ADR-0077 §4 asked for a Bedfellows view that surfaces shelf entries from groups that share something with the reader but not everything, computed on the device, and left the scoring to a spike (#428). The spike scored term overlap. On its sample corpus the middle band caught every pair sharing one thing, but it failed in four ways:

- **Same idea, other words:** "reading room" against "library" was missed.
- **Stance:** a call to end deer season matched a hunter as kin.
- **Word sense:** a chess club's "boards" matched a housing board.
- **Passing mentions** scored like coincidences.

The founder asked for semantic, stance-aware matching that stretches a reader toward stranger bedfellows over time, the opposite of a feed that narrows.

## Decision

ADR-0077 §4's rules stand: everything runs on the reader's device; no text, term, score, vector or history leaves it; nothing is stored about how groups resemble each other; no third-party service or script; votes, membership and follows are never signals; ranking by engagement stays ruled out.

### 1. Matching: claims, not whole texts

- Each Document and each shelf entry is split into sentences. A sentence is a **claim**.
- A small sentence-embedding model turns each claim into a vector, and claims are matched pair by pair, the reader's against the entry's.
- The term-overlap score from #428 stays as the fallback while the model hasn't loaded and for text the model doesn't cover. It isn't part of the score.

### 2. The model

- An English-first sentence-embedding model of the all-MiniLM-L6-v2 class, quantized to 8-bit, about 25 MB.
- It is served from Reconcile's own origin, and it is **the same file for every device**, so fetching it says nothing about the reader. No per-language packs.
- It loads the first time a reader opens Bedfellows, never with the app, after the reader has seen its size. The service worker caches it.
- It is pinned by hash and changes only with an app release.
- Non-English text falls back to term overlap. **Trigger to revisit:** a pilot group writes in another language. The multilingual model is then a larger download and a re-tune, not a migration, because nothing derived from the old model is kept.
- Running a model in the browser needs WebAssembly, so the deploy CSP's `script-src` gains `'wasm-unsafe-eval'` and nothing else. `connect-src` doesn't change.

### 3. Stance: verify, then leave out

- A small natural-language-inference model checks the three best-matching claim pairs of each candidate entry.
- **Agrees:** the pair counts as common ground.
- **Opposes:** the pair doesn't count, and the view never says so. An entry can still qualify through a different claim.
- **Unsure:** the pair counts as a shared subject only.
- There is no "other side" lane. **Trigger to revisit:** the check's precision on opposed pairs is above about 90% on the corpus, and the founder asks for the lane.

### 4. The band and the stretch

- **Something** is an **anchor**: at least one claim pair that passed the stance check.
- **Everything** is **coverage**: the share of an entry's claims that have a counterpart in the reader's writing. Entries above about 80% coverage are near-copies and stay out. Entries with no anchor stay out.
- **Strangeness** is one minus coverage. Entries fall into three tiers: close kin, middle and strange. An entry under three sentences is placed by its anchor's strength and its distance from the reader's nearest Document instead.
- **The slow clock:** the mix starts mostly close and shifts outward one step for each week in which the reader opens Bedfellows. The reader sees it as a **dial** they can move or reset.
- Entries from the reader's own groups and coalitions stay out of Bedfellows, as #433 already says.

### 5. What the device remembers

- **A sealed short history:** which shelf entries Bedfellows showed, and how the reader marked them (**Common ground** or **Too far**), with the dial's position.
- A mark nudges the dial, and an entry marked Too far isn't shown again. Marks are private: never shown to anyone, never counted, never sent.
- A history record is deleted 30 days after it's written, or when its entry leaves the shelf, whichever comes first.
- It is sealed in the vault and written through the vault's scheduled writes (ADR-0046), never on the tap.
- It stays on the one device: no backup, relay backup, snapshot or device link carries it.
- Settings has **Clear Bedfellows history**. Panic wipe erases it with everything else.
- **Match scores are never written.** Vectors of the reader's own writing live in memory only. Vectors of public shelf entries may sit in an ordinary cache.
- Ask to join and Propose reconciling are never signals, and neither is time spent.

### 6. Safeguards

- **Floors and ceilings:** every view keeps a minimum share of close kin and of strange entries and a maximum of any one tier, whatever the dial says.
- **Bridging bonus:** an entry anchored in two or more of the reader's Documents that are themselves unlike each other ranks ahead in its tier.
- **No shared-enemy anchors:** a claim that is mainly hostility toward a group of people can't be the anchor. It ships only once it's measured (§8); until then it's off.
- No per-group cap. **Trigger to revisit:** one publisher fills a pilot reader's view.

### 7. The reason, in words

- The reason is the entry's matched sentence, quoted as written: **"You both care about this:"** for a verified pair, **"You both write about this:"** for an unverified one.
- The reader's own matching sentence is one tap away, never shown by default, because a line from a group's Document on screen could tell an onlooker which group the reader is in.
- No model writes the reason, so no reason can state something a group didn't write.

### 8. Evaluation gates what ships

- **Corpus:** #428's 4 readers and 14 entries grown to about 40 readers and 300 entries, invented and naming no real group, with at least 30 labelled pairs each of shared claim, opposed stance, unclear, word-sense trap, idiom, passing mention, near-copy and unrelated. Two labellers, and a held-out split that thresholds are never tuned on.
- **Targets:** at least 90% of "You both care about" lines judged correct; under 5% of opposed pairs counted as agreement.
- **Simulation**, since no device reports anything: simulated readers over a year of clock steps. Distinct groups and subjects shown should rise, the top group's share should fall, verified-agreement precision should hold, and the share of shown entries labelled hostile toward a group of people must not rise.
- **Phone budget**, measured on a mid-range Android and an iPhone: at most 60 MB downloaded, first matches within 3 seconds on a 50-entry shelf, a full refresh within 10 seconds, and peak memory under 300 MB (250 MB on the iPhone).
- A part that misses its target ships in its weaker form: unverified wording everywhere if the stance check misses, and the shared-enemy check off if it's unmeasured.

## Why

- A sentence is the smallest unit that can be both checked for stance and shown to the reader as the reason.
- Similarity finds the same subject, not the same side, so agreement is never claimed from similarity alone.
- Leaving a doubtful pair out costs one missed match. Labelling a group as the reader's opponent wrongly misstates that group in Reconcile's voice.
- A feed that leads outward from one shared point has the shape of a radicalization pathway, so the safeguards are part of the algorithm.

## Consequences

- **The history is high-risk data by this project's own definition:** a dated list of public statements a person agreed with. The founder chose it over keeping only the dial's position, for a stretch that can hide what was seen and respond to marks. Sealing protects a locked phone, not an unlocked or coerced one, which is why it expires, stays out of every backup, and has its own erase.
- **A device with no vault keeps no history.** Bedfellows still works there from the clock alone, kept in memory for the session.
- **The CSP loosens by one keyword.** `'wasm-unsafe-eval'` lets the page compile WebAssembly from its own origin; it doesn't allow `eval` or inline script.
- **Two models, about 50 to 115 MB together by estimate,** stretch ADR-0077's "app size and battery matter". The 60 MB budget in §8 decides whether the stance model ships at its smallest size or not at all.
- The app gains its first machine-learning dependency. It is pinned exactly and imported by one module.
- #428's term-overlap module becomes the fallback, and #433 shows quotes, a dial and marks instead of shared terms.
- The shelf is public, so anyone can run the same open model over it and draw a likeness graph of publishing groups. Reconcile never computes or publishes one.

## Open questions

- Whether a small inference model can read implied values at all. The opposed-pair set in §8 answers it.
- Whether a zero-shot use of the stance model is enough for the shared-enemy check, or it needs a classifier of its own.
- The pace of the clock and the size of each tier's floor. The simulation proposes first values, and the pilot corrects them.
- The model files' licenses, checked before either ships (ADR-0024).
