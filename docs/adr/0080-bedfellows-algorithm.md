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
- **Measured (#476).** The model is Xenova's 8-bit ONNX export of sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0), with its WordPiece tokenizer (Apache-2.0), run by ONNX Runtime Web 1.31.1's plain WebAssembly build (MIT) on one thread, through Hugging Face's tokenizers.js 0.2.0 (Apache-2.0). All four fit ADR-0024: none is copyleft, and `/models/NOTICE.txt` carries their notices. The three files every device downloads are 38.5 MB: the model 23.0 MB, the runtime 14.8 MB and the tokenizer 0.7 MB, not the 25 MB estimated, because the runtime is a file of its own (gzip would send about 20.7 MB; the server doesn't compress them yet). They are pinned by SHA-256 in `client/src/net/modelPins.ts`, served from `/models/`, checked again on the device before first use, and kept by the service worker from the first ask. WebGPU isn't used: it needs a second, 29.5 MB runtime that only some devices would fetch, which would break "the same file for every device".

### 3. Stance: verify, then leave out

- A small natural-language-inference model checks the three best-matching claim pairs of each candidate entry.
- **Agrees:** the pair counts as common ground.
- **Opposes:** the pair doesn't count, and the view never says so. An entry can still qualify through a different claim.
- **Unsure:** the pair counts as a shared subject only.
- There is no "other side" lane. **Trigger to revisit:** the check's precision on opposed pairs is above about 90% on the corpus, and the founder asks for the lane.
- **Amended (#478): the check ships switched off.** No small inference model met §8's targets within the download budget and ADR-0024, so no stance model is pinned (`STANCE_MODEL` in `client/src/net/modelPins.ts`), no device downloads one, the judge is the stand-in, and every reason is unverified: "You both write about this:", never "You both care about this:". An opposed pair is therefore never left out by stance; it shows as a shared subject, which is true. The judge itself is built and tested (`client/src/bedfellows/judge.ts`): it asks the model both ways, and a pair **agrees** only when entailment is at least 0.8 both ways and **opposes** only when contradiction is at least 0.9 both ways, the thresholds in `thresholds.ts` set on `tune`. One-way entailment can't be the rule: it is how these models read a literal echo, and DeBERTa reads the ironic ring-road entry as entailing the reader's welcome at 0.97. **Trigger to revisit:** a stance model that verifies shared claims at §8's targets on `held-out` and fits the budget and ADR-0024; pinning it switches the judge on, its files then built and served beside the embedder's.

### 4. The band and the stretch

- **Something** is an **anchor**: at least one claim pair that passed the stance check.
- **Everything** is **coverage**: the share of an entry's claims that have a counterpart in the reader's writing. Entries above about 80% coverage are near-copies and stay out. Entries with no anchor stay out.
- **Strangeness** is one minus coverage. Entries fall into three tiers: close kin, middle and strange. An entry under three sentences is placed by its anchor's strength and its distance from the reader's nearest Document instead.
- **The slow clock:** the mix starts mostly close and shifts outward one step for each week in which the reader opens Bedfellows. The reader sees it as a **dial** they can move or reset.
- **Amended (#481): the clock's pace confirmed, and what it moves.** One step a week, eight steps, stays (`clock.ts`, `mix.ts`). The year's simulation (§8) found no reason to change it, and none it could test: on the corpus shelf the dial reaches the top by week 9, and what a view holds is bounded by the reader's candidate set, not by the pace. With the real embedder a reader has 9 to 46 rows on the 329-entry shelf, 866 in all, and only 15 of them (1.7%) are close kin, 233 middle and 618 strange; so the dial mostly moves a view from middle entries toward strange ones. A slower clock would only delay that move; a faster one changes nothing after week 9. The pilot, on real shelves, corrects it.
- Entries from the reader's own groups and coalitions stay out of Bedfellows, as #433 already says.

### 5. What the device remembers

- **A sealed short history:** which shelf entries Bedfellows showed, and how the reader marked them (**Common ground** or **Too far**), with the dial's position.
- A mark nudges the dial, and an entry marked Too far isn't shown again. Marks are private: never shown to anyone, never counted, never sent.
- **Amended (#480, the founder's decision of 2026-11-19): at most one nudge a view.** A view is one opening of Bedfellows. The first mark in it that would nudge moves the dial one step; later marks in the same view are kept, and a Too far still leaves its entry out, but they don't move the dial. Taking a mark back, or marking the same way again, moves nothing and spends nothing. The count lives in the session's memory, not the sealed history, so reopening starts a new view (`client/src/store/bedfellows.ts`). Why: #481's year found a reader who marks every strange entry Too far pulled back to a dial of 1 to 2.6, a step for each mark, so one view could undo a month of stretch.
- A history record is deleted 30 days after it's written, or when its entry leaves the shelf, whichever comes first.
- It is sealed in the vault and written through the vault's scheduled writes (ADR-0046), never on the tap.
- It stays on the one device: no backup, relay backup, snapshot or device link carries it.
- Settings has **Clear Bedfellows history**. Panic wipe erases it with everything else.
- **Match scores are never written.** Vectors of the reader's own writing live in memory only. Vectors of public shelf entries may sit in an ordinary cache.
  - **Amended (#477): the cache holds the whole shelf.** It is kept outside the vault, unsealed, so which entries it holds must say nothing about the reader. The pipeline is therefore handed every entry on the shelf, the reader's own groups' included, and §4's rule that the reader's own groups' and coalitions' entries stay out applies to the rows it returns, never to what it is given. Were the caller to leave the reader's own groups out first, the entries missing from the cache would point to the groups the reader belongs to.
  - **Amended (#480): the same holds for Too far.** An entry marked Too far is left out of the rows, never out of the run, so the cache still holds its vectors and shows no sign of the private mark (`pipeline.test.ts`).
- Ask to join and Propose reconciling are never signals, and neither is time spent.

### 6. Safeguards

- **Floors and ceilings:** every view keeps a minimum share of close kin and of strange entries and a maximum of any one tier, whatever the dial says.
- **Bridging bonus:** an entry anchored in two or more of the reader's Documents that are themselves unlike each other ranks ahead in its tier.
- **No shared-enemy anchors:** a claim that is mainly hostility toward a group of people can't be the anchor. It ships only once it's measured (§8); until then it's off.
- **Amended (#481): the shared-enemy check is built, measured, and ships off.** `client/src/bedfellows/hostility.ts` asks a stance model, zero-shot, whether a claim entails "This is mainly hostility toward a group of people.", and the pipeline never makes a flagged entry claim an entry's reason (with the stance check off, every reason stands where an anchor would), through `Models.hostility`; the worker hands it none, and `SHARED_ENEMY_CHECK` is `false`. Measured on each entry's claims by `harness.ts`'s `hostilityReport` and `heldOutHostilityReport` (the harness is the one module besides `corpus.ts` that may read the corpus), an entry caught when any claim is flagged, bars set on `tune` (`thresholds.ts`):

  | Candidate (§8's three) | Bar | `tune`: hostile caught | others flagged | anger at the powerful flagged | `held-out`: hostile caught | others flagged | anger flagged |
  |---|---|---|---|---|---|---|---|
  | xtremedistil, 13.1 MB, MIT (inside budget and ADR-0024) | 0.05 | 4/16 | 1/204 | 0/9 | 0/9 | 0/100 | 0/8 |
  | MobileBERT-MNLI, 21.0 MB, no license stated | 0.1 | 7/16 | 2/204 | 0/9 | 3/9 | 2/100 | 1/8 |
  | nli-deberta-v3-xsmall, 87.2 MB, Apache-2.0 | 0.05 | 4/16 | 1/204 | 0/9 | 3/9 | 1/100 | 0/8 |

  No candidate's entailment reaches 0.5 on more than 3 of the 16 `tune` hostile entries, so the bars are rankings, not beliefs. Every candidate misses five of the nine held-out hostile entries: the rival fans, the day-trippers, the evangelicals "in the old cinema", the "scroungers" on disability benefits and the foreigners "taking every job". The wrongly flagged lean toward no one kind of group: on `tune`, two housing arguments, a health-care worry and a pub quiz; on `held-out`, a youth-club appeal (MobileBERT), a referee rule (DeBERTa) and one anger-at-the-powerful entry ("nobody at the station will return a call", MobileBERT). The other seven held-out anger-at-the-powerful entries (the quarry company, the water company's bonuses, the rail operator, the lettings agent, the council's library) were flagged by no candidate. On the harness the check changes nothing: `shared-claim` pairs are 0 verified, 7 unverified and 10 with nothing of 17 on `held-out` (26, 7 of 33 on `tune`), and every other kind the same, off and on with each candidate. Re-measured on the reviewed corpus now on main, every count in the table and the harness is the same. In the year's simulation (§8, seed 1) the real embedder's views are 4.74% hostile over the year with the check off for a reader who marks nothing (4.78% over ten seeds), 4.19% with MobileBERT's check, 4.28% with xtremedistil's (that run covers both splits, so its `tune` catches flatter it), and 0% with a check that knew the labels.

  **Decision** (architectural-decisions, options weighed): *on with xtremedistil*, the one candidate that fits, would download 13.1 MB for a check that caught none of the 9 held-out hostile entries; *on with MobileBERT or DeBERTa* is ruled out by ADR-0024 or the 60 MB budget, and catches a third; *off* costs nothing and loses nothing measured. It isn't clearly measured as helping, so it ships **off**, as #481 asked. The next thing to try is a classifier of its own, which is a third model download and so the founder's call. **Trigger to revisit:** a model inside the budget and ADR-0024 that catches most `held-out` hostile entries and flags no anger at the powerful; switching it on is `SHARED_ENEMY_CHECK`, the worker handing the pipeline `modelHostility`, and §8's simulation rerun.
- No per-group cap. **Trigger to revisit:** one publisher fills a pilot reader's view.
- **Amended (#479): first values.** The dial runs from 0 to 8: 70% close, 20% middle, 10% strange at 0, to 15%, 25%, 60% at 8 (`client/src/bedfellows/mix.ts`). The floors are 15% close kin and 10% strange, rounded down in a small view, and the ceiling is 70% of any tier, rounded up; a short tier's room goes to the others up to that ceiling, so a view comes up short rather than all one tier. The clock steps once per week opened, however long the reader was away (`clock.ts`). The bonus counts candidate pairs, not only anchors, since the stance check is off (§3), and two Documents are unlike below a centroid cosine of 0.5 (`bridge.ts`). That line is untuned and, by the corpus, too high: every pair of one reader's Documents in it, all one community's, sits below it (0.04 to 0.50, by the real model), so for now any entry with pairs in two of a reader's Documents bridges. A view mixes the rows it picks, so it can't be trimmed after: the caller hands the whole shelf as §5 says and names the reader's own groups' and coalitions' entries in the view (`own`), which leaves them out before the mix. Within a tier, order turns by the calendar date and a seed the caller keeps. Each value's reason is beside it in the code; all are untested by simulation.
- **Amended (#481): first values confirmed by simulation.** The year's simulation (§8) keeps every #479 value: TOP 8, the table from 70/20/10 to 15/25/60, floors of 15% close kin and 10% strange, the 70% ceiling, one step a week. What it shows about them: the close floor can't be kept for most readers, since close kin are 15 of the 866 rows the corpus shelf gives its 40 readers, and 27 readers have none, and a view at the dial's start, asking 70% close kin, fills with middle and strange entries instead. None of that is a reason to move a value, because the corpus shelf has almost no close kin to give; a pilot shelf with a reader's near neighbours on it is what can test the close floor. One finding was about marks (#480), not these values: a reader who marks every strange entry Too far was pulled back to a dial of 1 to 2.6 and stayed there, since each mark in a view nudged a step, and the marks lapse with the 30-day history, so the same entries come back every five weeks to be marked again. **Made (#480, the founder's decision of 2026-11-19): at most one nudge a view** (§5). With it, that reader's dial averages 6.08 over the last quarter with the real embedder (ten seeds) and reaches the top with the stand-ins (4.60 before); the hostile share of their views stays flat by the founder's bar (§8).

### 7. The reason, in words

- The reason is the entry's matched sentence, quoted as written: **"You both care about this:"** for a verified pair, **"You both write about this:"** for an unverified one.
- The reader's own matching sentence is one tap away, never shown by default, because a line from a group's Document on screen could tell an onlooker which group the reader is in.
- No model writes the reason, so no reason can state something a group didn't write.

### 8. Evaluation gates what ships

- **Corpus:** #428's 4 readers and 14 entries grown to about 40 readers and 300 entries, invented and naming no real group, with at least 30 labelled pairs each of shared claim, opposed stance, unclear, word-sense trap, idiom, passing mention, near-copy and unrelated. Two labellers, and a held-out split that thresholds are never tuned on.
- **Targets:** at least 90% of "You both care about" lines judged correct; under 5% of opposed pairs counted as agreement.
- **Simulation**, since no device reports anything: simulated readers over a year of clock steps. Distinct groups and subjects shown should rise, the top group's share should fall, verified-agreement precision should hold, and the share of shown entries labelled hostile toward a group of people must not rise.
- **Phone budget**, measured on a mid-range Android and an iPhone: at most 60 MB downloaded, first matches within 3 seconds on a 50-entry shelf, a full refresh within 10 seconds, and peak memory under 300 MB (250 MB on the iPhone).
- **Measured (#476), on desktop only; the phone numbers are pending** (the founder's mid-range Android and iPhone, with `client/scripts/measure-model.sh`). Headless Chromium 157 on a 4-core Linux machine, one thread, files served from the same machine, the embedding model alone (no stance model yet, #478):

  | | Desktop | Budget |
  |---|---|---|
  | Downloaded | 38.5 MB | ≤ 60 MB: inside, with 21.5 MB left for the stance model |
  | Time to first vector, download included | 2.0–3.6 s (fetch and check 1.1–1.8 s, start 0.6–0.9 s, first vector 0.14 s) | |
  | Per sentence | about 20 ms | |
  | 50 entries against 5 Documents (217 claims) | 2.9–3.0 s, model loaded | ≤ 3 s: at the edge on desktop, so over on a phone |
  | 500 entries against 20 Documents (1,997 claims) | 24.6–24.9 s | ≤ 10 s: over, 2.5 times |
  | Peak memory, the page's renderer | 400 MB at peak, about 320 MB once settled (115 MB before loading) | < 300 MB: over |

  Embedding claims is nearly all the time. What would bring the shelves in, cheapest first: keep public entries' vectors in the ordinary cache §5 allows, so a refresh embeds only new entries; show rows as each entry is placed, so first matches don't wait for the whole shelf; give the page cross-origin isolation (COOP and COEP headers), so the runtime can run on several threads; cap the claims or tokens embedded per entry; or a smaller model, with the harness judging what it costs. Memory: hand the files' bytes to the runtime and drop them, as `embedderLoader` does, and measure inside the app rather than the test page.
- **Measured (#477), on desktop again, with the cache §5 allows.** Public entries' vectors are kept in an IndexedDB database of their own (`reconcile-bedfellows-vectors`), by entry id and model, and dropped when the entry leaves the shelf or the model changes; the model now embeds one sentence at a time, since the 8-bit model's vectors shift with the other sentences in a batch, and it is no slower. Same machine, under load from other work, #476's page and this one run side by side:

  | | Before (#476) | After, nothing kept | After, entries kept | Budget |
  |---|---|---|---|---|
  | 50 entries against 5 Documents, model loaded | 3.17 s | 2.5–2.9 s | 0.26–0.30 s | ≤ 3 s |
  | 500 entries against 20 Documents | 25.4 s | 20.2–20.6 s | 1.25–1.49 s | ≤ 10 s |
  | Peak memory, the page's renderer | 399 MB | 401–402 MB | | < 300 MB |

  A refresh with the shelf kept is inside its budget; the first run on a new shelf isn't, and memory is unchanged, since the model's own working set dominates it. A first open still pays for the model's load (2.5–2.8 s to the first vector here) before any match. The thresholds are in `client/src/bedfellows/thresholds.ts`, set on the corpus's `tune` split: a near-copy is an entry more than 65% of whose claims are restated, not 80%, because an entry's title is a claim and a Document's isn't, so a near-copy of a Document tops out at two claims of three.
- **Measured (#478): the stance check misses, so it ships in its weaker form.** Three inference models were tried on `tune`, each through the pipeline's best three pairs per entry, asked both ways:

  | Model (8-bit unless noted) | Size | License | Fits | `tune`: shared claims verified | opposed verified | opposed left out | ms per ask (desktop) |
  |---|---|---|---|---|---|---|---|
  | MoritzLaurer/xtremedistil-l6-h256-zeroshot-v1.1-all-33, two-way | 13.1 MB | MIT | yes | 0/33 | 0/31 | 0 (it has no contradiction) | 10 |
  | Xenova/mobilebert-uncased-mnli, 4-bit weights and 16-bit floats | 21.0 MB (26.4 MB at 8 bits) | none stated by its author | budget only | 1/33 | 0/31 | 1/31 | 108 |
  | Xenova/nli-deberta-v3-xsmall | 87.2 MB | Apache-2.0 | license only | 1/33 | 0/31 | 2/31 | 57 |

  The models share the embedder's tokenizer except DeBERTa, so the first two would add only their network to the 38.5 MB. Even handed the labelled sentences themselves, the best of them reads 1 of the 33 `tune` shared claims as entailment both ways at 0.8, and the others none: the corpus's shared claims are values two groups hold in their own words, not restatements, and inference models are trained on literal ones. That answers the first open question below for models of this size. On `held-out`, at the thresholds set on `tune`, beside #477's stand-in:

  | `held-out` | Stand-in (#477, ships) | xtremedistil | MobileBERT | DeBERTa |
  |---|---|---|---|---|
  | Lines verified | 0 | 0 | 1, a near-copy | 0 |
  | Verified lines that are shared claims (≥ 90%) | none to judge | none to judge | 0/1 | none to judge |
  | Opposed pairs verified (< 5%) | 0/16 | 0/16 | 0/16 | 0/16 |
  | Opposed pairs caught as opposes / left unsure / no candidate | 0 / 10 / 6 | 0 / 10 / 6 | 0 / 10 / 6 | 0 / 10 / 6 |
  | Shared claims shown, unverified | 7/17 | 7/17 | 7/17 | 7/17 |

  The deer-season, irony and quoted-opponent pairs are judged unsure by all three on every pair the pipeline sends (one held-out quoted-opponent pair finds no candidate). The issue's own examples: MobileBERT and DeBERTa agree on "Keep the library open." and "We want the library to stay open."; xtremedistil is unsure; on "Deer season is our heritage." and "End deer season now." DeBERTa opposes and the others are unsure. The download, memory and phone budgets are unchanged, since nothing more is fetched.
- **Measured (#481): a year of the stretch.** `client/src/bedfellows/simulate.ts` opens Bedfellows once a week for 52 weeks for each of the corpus's 40 readers against its 329-entry shelf, a view of 10 rows, with the history modelled as #480 keeps it, one nudge a view included (`client/src/store/bedfellows.simulate.test.ts` holds the two to the same rules). Every week's run is handed the whole shelf, as §5 asks; no corpus reader belongs to a publishing group, so `own` is empty, and Too far leaves the rows, never the run. Three kinds of reader: one who marks nothing, one who marks every verified strange entry Common ground, and one who marks every strange entry Too far. It reads and writes nothing outside memory. With the stand-ins, seed 1, CI runs each kind's year in a test file of its own, about 30 seconds each, side by side; the real embedder's numbers were run by hand on 2026-11-20 against main as it stood (#477 to #480 and the reviewed corpus): Xenova's 8-bit all-MiniLM-L6-v2 as pinned (§2), stance check off and shared-enemy check off, as they ship, seeds 1 to 10. Means per reader's view, over the ten seeds:

  | Reader | Week | Dial | Shown | Groups | Subjects | Groups met so far | Top group's share | Verified | Hostile |
  |---|---|---|---|---|---|---|---|---|---|
  | marks nothing | 1 | 0 | 9.75 | 8.71 | 7.22 | 8.7 | 18.1% | 0 | 4.54% |
  | | 9 | 8 | 9.75 | 8.77 | 7.47 | 17.2 | 18.0% | 0 | 4.92% |
  | | 26 | 8 | 9.75 | 8.76 | 7.36 | 17.4 | 17.6% | 0 | 4.49% |
  | | 52 | 8 | 9.75 | 8.79 | 7.48 | 17.4 | 17.8% | 0 | 5.18% |
  | marks Too far | 1 | 0 | 9.75 | 8.71 | 7.22 | 8.7 | 18.1% | 0 | 4.54% |
  | | 9 | 2.88 | 6.60 | 6.13 | 5.34 | 17.1 | 29.7% | 0 | 4.89% |
  | | 26 | 5.72 | 9.75 | 8.72 | 7.22 | 17.3 | 18.1% | 0 | 4.36% |
  | | 52 | 6.08 | 9.07 | 8.15 | 7.04 | 17.3 | 19.8% | 0 | 5.26% |

  The reader who marks Common ground is the reader who marks nothing, row for row: with the stance check off nothing is verified, so there is nothing to mark. Run with DeBERTa as the judge (§3's candidate, not shipped; measured before this rerun, on the corpus as it then was) 39 verified reasons are shown over the year to the reader who marks nothing, and every one that falls on a labelled pair is a `shared-claim` (precision 100%); but none is strange, so the reader who marks Common ground still marks nothing. Against §8's expectations: **groups met** rise for every kind (8.7 in week 1, 16.1 by week 4, 17.3 by week 13: by then every group in reach has been met); **distinct groups and subjects in a week's view** barely move for the reader who marks nothing (8.72 to 8.75 and 7.35 to 7.42, weeks 1 to 4 against the last quarter), and fall for the reader who marks Too far (7.51 to 7.19 and 6.40 to 6.13), whose left-out entries leave the view short; **the top group's share** holds for the first (18.1% to 17.9%) and rises for the second (23.4% to 24.3%); **verified precision** has nothing to judge as shipped. With the stand-ins the same shapes hold, and CI holds them as findings, not as the targets they missed. **Proposed:** a per-group cap stays out (§6's trigger isn't met: the most-shown group's share of a view averages at most 18% for the reader who marks nothing and 30% for the one who marks Too far).
- **The founder's bar for the hostile share (2026-11-19), and the rerun that meets it.** A first bar, a flat hostile share by one week of one seed, wasn't met (the rerun with one nudge a view, #480, changed no hostile share), since a week's view is about 390 rows, so one hostile entry more or less is 0.26 points, and the order turns with the seed. The founder then set this bar: *"use the ten-seed bar. Call the hostile share flat if the ten-seed last-quarter mean is within 0.5 points of weeks 1 to 4."* The hostile share is the share of all rows shown that week whose entry is labelled `hostile`; weeks 1 to 4 and the last quarter (weeks 40 to 52) are each the mean of their weeks, per seed, then the mean over seeds 1 to 10. Real embedder, check off, rerun on 2026-11-20 on main:

  | Reader | Weeks 1–4, ten-seed mean | Last quarter, ten-seed mean | Difference | Per seed, weeks 1–4 | Per seed, last quarter | Per seed, difference | Flat by the bar (≤ 0.5)? |
  |---|---|---|---|---|---|---|---|
  | marks nothing (and Common ground) | 4.66% | 4.82% | +0.16 points | 4.29% to 5.00% (sd 0.23) | 4.50% to 5.38% (sd 0.23) | −0.40 to +1.09 | **yes** |
  | marks Too far | 4.85% | 4.85% | −0.00 points | 4.60% to 5.15% (sd 0.18) | 4.70% to 5.06% (sd 0.13) | −0.37 to +0.24 | **yes** |

  **It passes** for both kinds, with the shared-enemy check off as it ships (the bar's first reading, before this rerun, was +0.36 points). One seed of ten is over 0.5 on its own (seed 7, the reader who marks nothing, +1.09); the bar is the ten-seed mean's, which is why it is set over ten seeds. The stand-ins' seed 1, which CI holds, is inside it too: 5.60% to 5.70% for the reader who marks nothing, 4.49% to 4.91% for the one who marks Too far. What drifts is the dial's move from middle entries toward strange ones, where the hostile entries mostly sit; a check that knew the labels showed nothing hostile all year (§6), so a shared-enemy check of its own stays the next step if a pilot shows a rise. **Trigger to revisit:** a pilot shelf or a corpus change whose ten-seed rerun puts the difference over 0.5 points.
- A part that misses its target ships in its weaker form: unverified wording everywhere if the stance check misses (it did, #478), and the shared-enemy check off if it's unmeasured.

## Why

- A sentence is the smallest unit that can be both checked for stance and shown to the reader as the reason.
- Similarity finds the same subject, not the same side, so agreement is never claimed from similarity alone.
- Leaving a doubtful pair out costs one missed match. Labelling a group as the reader's opponent wrongly misstates that group in Reconcile's voice.
- A feed that leads outward from one shared point has the shape of a radicalization pathway, so the safeguards are part of the algorithm.

## Consequences

- **The history is high-risk data by this project's own definition:** a dated list of public statements a person agreed with. The founder chose it over keeping only the dial's position, for a stretch that can hide what was seen and respond to marks. Sealing protects a locked phone, not an unlocked or coerced one, which is why it expires, stays out of every backup, and has its own erase.
- **A device with no vault keeps no history.** Bedfellows still works there from the clock alone, kept in memory for the session.
- **The CSP loosens by one keyword.** `'wasm-unsafe-eval'` lets the page compile WebAssembly from its own origin; it doesn't allow `eval` or inline script.
- **Two models, about 50 to 115 MB together by estimate,** stretch ADR-0077's "app size and battery matter". The 60 MB budget in §8 decides whether the stance model ships at its smallest size or not at all. For now it doesn't ship (#478, §3), so the download is the embedder's 38.5 MB.
- The app gains its first machine-learning dependency. It is pinned exactly and imported by one module.
- #428's term-overlap module becomes the fallback, and #433 shows quotes, a dial and marks instead of shared terms.
- The shelf is public, so anyone can run the same open model over it and draw a likeness graph of publishing groups. Reconcile never computes or publishes one.

## Open questions

- Whether a small inference model can read implied values at all. The opposed-pair set in §8 answers it: at 13 to 87 MB, no (#478, §8). A larger model, or one trained on stance rather than inference, is the next thing to try, measured by the same harness.
- Whether a zero-shot use of the stance model is enough for the shared-enemy check, or it needs a classifier of its own. Answered for models of this size (#481, §6): not enough; the check ships off, and a classifier of its own is a third download, the founder's call.
- The pace of the clock and the size of each tier's floor. #479 set first values (§6); the simulation kept them (#481, §4 and §6), since the corpus shelf has too few close kin to test the close floor; the pilot corrects them.
- The model files' licenses, checked before either ships (ADR-0024). The embedding model's are (#476, §2). No stance model ships (#478, §3); of the candidates, MobileBERT-MNLI's author states no license, so it can't ship whatever it scores.
