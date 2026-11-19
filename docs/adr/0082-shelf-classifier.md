# ADR-0082: The Shelf Classifier Is Built Behind a Flag, Runs on the Steward's Device Only, and Waits for the Covenant's Words to Turn On

- **Status:** Accepted (2026-11-19). The founder answered `/decide` sheet `2026-11-18-shelf-classifier`; see [Decision](#decision). This ADR records the spike (#492), its measurements and the answers. #493 builds it.
- **Date:** 2026-11-18 (proposed), 2026-11-19 (accepted)
- **Answers:** the spike that [ADR-0081](0081-listed-doors-and-exception-moderation.md) §4 and [the spec](../spec/listed-doors.md) §6.6 call for: which model, how it runs under the CSP, which languages, and its measured error rate on political speech
- **Builds on:** [ADR-0005](0005-pwa-client.md), [ADR-0020](0020-us-nonprofit-zero-knowledge.md), [ADR-0024](0024-source-available-license.md), [ADR-0035](0035-reconcile-group-minimal-eternal-core.md), [ADR-0081](0081-listed-doors-and-exception-moderation.md); ADR-0080 §2 (Bedfellows, on an unmerged branch with #476) for the in-browser runtime

## Context

ADR-0081 lets a text classifier bundled with the app put a shelf entry in the steward's queue. The classifier only flags: it hides nothing, and no reader sees a flag. The spec (§6.6) left the rest to this spike.

Three facts shape the question:

- **There is no fixed text to detect against.** ADR-0035's eternal core has a placeholder: "Reconcile does not carry calls for violence against people, or speech that denies any group's humanity." Its final wording is deferred. The covenant adds no spam and no impersonation (ADR-0081 §3).
- **"Nothing third-party" rules out a hosted moderation API.** The classifier runs on a device, and it calls nothing except its own model file on the app's origin.
- **The deploy CSP on `main` has no `'wasm-unsafe-eval'`,** so no WebAssembly runtime loads there. #476 (unmerged) adds it for Bedfellows. It runs ONNX Runtime Web 1.31.1 with SHA-256-pinned model files served from `/models/`, loaded lazily (ADR-0080 §2).

The text to read is small. A listing's name is at most 120 code points. An entry's title is at most 80 and its text at most 500. A listing holds at most 4 live entries and adds at most one a day.

## The spike

### The sample

Every item was written for this spike, by the spike's author. None comes from a third party, and none names a real person or group. Targets are generic classes ("immigrants", "the mayor"). There are no slurs. Reclaimed terms appear only in their reclaimed use. Each item is shelf-sized, and each has one label: should the steward be asked to look?

| Slice | Items | Label |
|---|---|---|
| Calls for violence, some without a violent word ("make one happen") | 12 | flag |
| Dehumanization ("vermin", "not really people") | 12 | flag |
| Direct and veiled threats, doxxing | 8 | flag |
| Hate that swears | 8 | flag |
| Heated political speech from left and right ("Eat the rich", "Abortion is murder", "Kill the bill", "Death to the death penalty", "Back the blue") | 40 | don't flag |
| Quotation and counter-speech (a group quoting the hate it opposes, history, Shakespeare) | 25 | don't flag |
| Reclaimed language ("Dyke March", "Crip Camp", "Queer Muslims' iftar", "Fat femme fashion swap") | 20 | don't flag |
| Ordinary community life ("we murdered trivia night", "A year ago I wanted to kill myself. Today I'm 365 days sober") | 25 | don't flag |
| Swearing that isn't hate ("Fuck cancer. Charity run on Sunday") | 10 | don't flag |
| Spam, which breaks the covenant but is reported apart | 8 | flag |
| Spanish: 5 violence or threat, 3 dehumanization, 2 swearing hate; 10 political, quotation, reclaimed or ordinary | 20 | 10 flag, 10 don't |

That makes 188 items. The sample is **not committed**, and it stays out of the repository ([Decision](#decision), `sample`). Its limits:

- **One labeller.** The spike's author wrote and labelled everything.
- **It is small:** 40 English items should flag. One item is 2.5 points of false-negative rate, and one of 120 is 0.8 points of false-positive rate.
- **It doesn't come from a real shelf.** Real hostile entries will be written to slip past whatever runs.

### How it was run

- Each model scored all 188 items on a 4-core Linux machine, with ONNX Runtime 1.32.0 (CPU, Python) and Hugging Face `tokenizers` 0.23.3, in a scratch directory. No code was committed, and nothing was added to `client/package.json`.
- **Cross-check against the browser runtime:** the 23 MB model was also run under #476's ONNX Runtime Web 1.31.1 (plain WebAssembly, one thread, in Node) with #476's `@huggingface/tokenizers`. Its scores differ from the native ones by at most 0.031, and no flag changed.
- **Thresholds were fixed before scoring:** 0.5 on each model's own output, as each model card uses them. Two rules per toxicity model:
  - **broad:** `toxic` ≥ 0.5;
  - **narrow:** `threat` or `identity_hate` (`identity_attack`) ≥ 0.5, which is closer to the draft core's two clauses.
- **The pure-TypeScript linear model was trained for this spike:** logistic regression on hashed word 1–2-grams and character 4-grams (2^18 weights, FNV-1a hashing that TypeScript can reproduce exactly). It used 400,000 comments of [Civil Comments](https://huggingface.co/datasets/google/civil_comments) (CC0-1.0), shard `train-00000-of-00002` at revision `f2970eb`, with labels `toxicity ≥ 0.5`. A 50,000-comment validation split gave F1 0.637 at threshold 0.45. Both 0.5 and 0.45 were scored; neither was tuned on the sample.
- **Zero-shot NLI**, the method #478 and #481 used for Bedfellows' stance check, put each item against three hypotheses taken from the draft core: "This text calls for violence against people." / "This text says a group of people is not human." / "This text threatens someone." It flags when any entailment probability is ≥ 0.5.

### Results

FN is should-flag items missed, out of 40 English. FP is don't-flag items flagged, out of 120 English. Spam and Spanish are counted apart.

| Option | Model and rule | Download (steward's device only) | FN | FP | FP on quotation | FP on reclaimed | Spam caught | Spanish FN / FP |
|---|---|---|---|---|---|---|---|---|
| A. Pure TypeScript | Word list ([LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) `en` + `es`, CC-BY-4.0, 471 entries) | about 4 KB | 34 (85%) | 9 (7.5%) | 2/25 | 2/20 | 0/8 | 9/10 · 1/10 |
| A. Pure TypeScript | Linear, trained on Civil Comments, p ≥ 0.5 | 512 KB as fp16, 145 KB as gzipped int8 | 25 (62.5%) | 16 (13.3%) | 4/25 | 5/20 | 0/8 | 10/10 · 1/10 |
| A. Pure TypeScript | Linear, p ≥ 0.45 (Civil Comments validation) | same | 25 (62.5%) | 19 (15.8%) | 5/25 | 5/20 | 0/8 | 10/10 · 2/10 |
| A. Pure JavaScript | TensorFlow.js `toxicity` (Apache-2.0) on the CPU backend, no WebAssembly | **unmeasured**: the proxy refuses `tfhub.dev` and `kaggle.com`, where its weights live | — | — | — | — | — | — |
| B. WebAssembly in the app | MiniLMv2-toxic-jigsaw, 8-bit, narrow | 23.6 MB (model 22.9, tokenizer 0.7), plus #476's 14.8 MB runtime if Bedfellows hasn't fetched it | 31 (77.5%) | **0 (0%)** | 0/25 | 0/20 | 0/8 | 10/10 · 0/10 |
| B. WebAssembly in the app | MiniLMv2-toxic-jigsaw, 8-bit, broad | same | 25 (62.5%) | 8 (6.7%) | 0/25 | 1/20 | 0/8 | 10/10 · 0/10 |
| B. WebAssembly in the app | toxic-bert, 8-bit, narrow | 111.4 MB + runtime | 25 (62.5%) | 3 (2.5%) | 2/25 | 0/20 | 0/8 | 10/10 · 0/10 |
| B. WebAssembly in the app | toxic-bert, 8-bit, broad | same | 22 (55%) | 15 (12.5%) | 2/25 | 2/20 | 0/8 | 10/10 · 0/10 |
| B. WebAssembly in the app | nli-deberta-v3-xsmall, 8-bit, zero-shot on the draft core | 95.9 MB + runtime | 17 (42.5%) | 30 (25%) | **17/25** | 2/20 | 0/8 | 5/10 · 2/10 |
| B. WebAssembly in the app | xtremedistil-l6-h256 NLI, 8-bit, zero-shot | 13.8 MB + runtime | 1 (2.5%) | 117 (97.5%): it flags nearly everything | 24/25 | 19/20 | 7/8 | 1/10 · 4/10 |
| C. The steward's machine | Detoxify `unbiased` (RoBERTa, fp32), narrow | 501 MB | 21 (52.5%) | 10 (8.3%) | 6/25 | 0/20 | 0/8 | 10/10 · 0/10 |
| C. The steward's machine | Detoxify `unbiased`, broad | same | 16 (40%) | 26 (21.7%) | **12/25** | 2/20 | 0/8 | 8/10 · 0/10 |
| C. The steward's machine | Detoxify `multilingual` (XLM-R, 8-bit), narrow | 296 MB (model 279.4, tokenizer 17.1) | 24 (60%) | 7 (5.8%) | 5/25 | 1/20 | 0/8 | 2/10 · 1/10 |
| C. The steward's machine | Detoxify `multilingual`, broad | same | 15 (37.5%) | 23 (19.2%) | **11/25** | 3/20 | 0/8 | **1/10** · 4/10 |

Misses by kind, for the rules a build would start from:

| Model and rule | Calls for violence missed | Dehumanization missed | Threats missed | Hate that swears missed |
|---|---|---|---|---|
| Linear, p ≥ 0.5 | 10/12 | 7/12 | 8/8 | 0/8 |
| MiniLMv2, narrow | 12/12 | 8/12 | 7/8 | 4/8 |
| toxic-bert, broad | 11/12 | 5/12 | 6/8 | 0/8 |
| Detoxify `multilingual`, broad | 7/12 | 1/12 | 7/8 | 0/8 |
| DeBERTa NLI | 7/12 | 2/12 | 7/8 | 1/8 |

Desktop time per item: MiniLMv2 1.7 ms, toxic-bert 7.5 ms, `multilingual` 9.1 ms, `unbiased` fp32 21 ms, DeBERTa NLI 42 ms for three asks. Even the slowest reads a 1,000-entry shelf in under a minute, so speed separates nothing.

### What the numbers say

1. **Nothing measured catches what the draft core names.** Calls for violence without swearing ("Torch the mosque before the weekend", "Run your car into the protesters") get past every small model: 10 to 12 of 12 are missed. Even the 300 MB and 500 MB Detoxify models miss 7 or 8 of 12. Veiled threats and doxxing ("We're publishing the home addresses of every member") get past every model that doesn't flag everything: 6 to 8 of 8 are missed. These models were trained to find rude comments, and a rude comment is not a covenant breach.
2. **What they catch well is hate that swears.** With a slur-free sample, that is 0 to 1 of 8 missed by the broad rules. A reader would report those entries anyway.
3. **The false positives fall on the people the covenant protects.** Higher recall costs flags on counter-speech: 11 to 17 of 25 quotations for `unbiased`, `multilingual` and the NLI model, such as "Someone spray-painted 'kill all gays' on the center. We're repainting it Sunday". Identity terms trip the broad rules too: "Queer Muslims' iftar this Friday" is flagged by the linear model and by `multilingual`. A steward who works the queue would look at anti-hate groups and queer groups more often than at anyone else. That is a bias in where scrutiny goes, even though a flag hides nothing.
4. **Swearing is the other false positive.** "Holy shit, we hit our fundraising goal" is flagged by most broad rules (4 to 6 of 10).
5. **Political speech mostly passes,** at 0 to 8 of 40. "The senator is a liar and a coward" and "Death to the death penalty" are the usual trips.
6. **Spam is never caught** (0 of 8, except by the model that flags everything). The covenant's spam rule needs ADR-0081's mechanical limits and readers' reports, not this.
7. **Only Detoxify `multilingual` reads Spanish** (1 of 10 missed). The English toxicity models miss 8 to 10 of 10, and DeBERTa NLI misses 5. Its card lists seven languages: English, French, Spanish, Italian, Portuguese, Turkish and Russian.
8. **Zero-shot NLI is the only method that takes the covenant's own words,** so it could follow ADR-0035's final text without retraining. On the draft text it has the worst precision on quotation (17 of 25 flagged). The 13 MB NLI model, which fits the phone budget, is unusable: it flags 117 of 120. That matches #481's finding, where xtremedistil caught 0 of 9 held-out hostile entries at its tuned bar.

## Options

### A. A small model in plain TypeScript

The linear model above, or a word list, ships as a file in `/models/` and is scored by about 100 lines of TypeScript. Nothing else is needed.

- **Size:** 145 KB to 512 KB for the linear model, 4 KB for the word list.
- **Source and pinning:** we train it ourselves from Civil Comments (CC0-1.0), with a script and a dataset revision we pin. The weights' SHA-256 goes in `modelPins.ts` like any model file. The word list is CC-BY-4.0, so `/models/NOTICE.txt` would need its attribution.
- **CSP:** no change. It works on `main` as it is.
- **Languages:** English only. Civil Comments is English. Spanish missed 10 of 10.
- **Upkeep:** we own a training pipeline: a Python script, a pinned dataset, and a re-measure on this harness whenever the clauses change. Hashed n-grams can't tell quotation from use. Retraining fixes nothing structural.
- **TensorFlow.js `toxicity`** would also run without WebAssembly, on its CPU backend. It is unmeasured because its weights are on hosts the proxy refuses, and it would add TensorFlow.js as a client dependency.

### B. A WebAssembly model in the app, reusing #476's runtime

MiniLMv2-toxic-jigsaw (Apache-2.0, a 23 M-parameter student of `unitary/toxic-bert`, trained on Jigsaw's first Kaggle toxicity competition) runs in the steward's console through the same ONNX Runtime Web build and tokenizer that Bedfellows loads.

- **Size:** 23.6 MB. Only the steward's device fetches it, when the console opens. If Bedfellows hasn't loaded the 14.8 MB runtime on that device yet, it is fetched too.
- **Source and pinning:** a third party's export, `minuva/MiniLMv2-toxic-jigsaw-onnx` at revision `c035f27`, with file `model_optimized_quantized.onnx` at SHA-256 `bcd9dfb4…69a0`. It would be pinned in `modelPins.ts` and checked on the device before first use, as #476 does. Exporting our own copy from the Apache-2.0 checkpoint `minuva/MiniLMv2-toxic-jigsaw` would remove that third party from the chain.
- **CSP:** none beyond #476's `'wasm-unsafe-eval'` in `script-src`. If #476 merged first, B adds no CSP change of its own. If B were built first, it would have to make that change itself, and that is #476's decision to take, not this one's.
- **Languages:** English only.
- **Upkeep:** a model swap is a file and a pin. Runtime upgrades ride along with Bedfellows'. Larger models in this option (toxic-bert at 111 MB, DeBERTa NLI at 96 MB) catch more but break no budget that matters here, since the phone budget is Bedfellows' and the steward's console doesn't run on a phone.

### C. A process on the steward's own machine

A small Python program on the steward's computer reads `GET /v1/shelf`, which is public, so it needs no key and no account. It scores each entry with Detoxify `multilingual` and prints the entries worth a look. The steward opens those in the console.

- **Size:** 296 MB, on one machine. `unbiased` is 501 MB.
- **Source and pinning:** `unitary/multilingual-toxic-xlm-roberta` (Apache-2.0). The 8-bit export measured here is a third party's (`hoan/multilingual-toxic-xlm-roberta-dynamic-quantized` at `87059f2`, SHA-256 `783cfd05…dbf2`). We would export our own copy, then pin the model's hash and the program's dependencies (`onnxruntime`, `tokenizers`) in a lock file of its own.
- **CSP:** none. The app doesn't talk to it. `connect-src 'self'` would block a page from reaching a local port anyway.
- **Languages:** seven: English, French, Spanish, Italian, Portuguese, Turkish and Russian.
- **Upkeep:** a second program with its own install, outside the app's release and CI. The founder has to keep it working. It also departs from ADR-0081's "a text classifier bundled with the app", so choosing it amends ADR-0081 §4.

### Comparison

| | A. Pure TypeScript (linear) | B. WebAssembly in the app (MiniLMv2) | C. Steward's machine (Detoxify `multilingual`) |
|---|---|---|---|
| Download, steward only | 0.15–0.5 MB | 23.6 MB (+14.8 MB runtime if not cached) | 296 MB, once |
| CSP change | none | #476's, nothing more | none |
| Model source | trained by us, on CC0 data | third-party fine-tune, Apache-2.0 | Unitary, Apache-2.0; our own export |
| Integrity | SHA-256 in `modelPins.ts` | SHA-256 in `modelPins.ts`, checked on the device | hash in the program's lock file; outside the app's pins |
| Languages | English | English | 7 |
| FN / FP, best rule for few flags | 62.5% / 13.3% | 77.5% / 0% (narrow) | 60% / 5.8% (narrow) |
| FN / FP, best rule for catching | 62.5% / 13.3% | 62.5% / 6.7% (broad) | 37.5% / 19.2% (broad) |
| Upkeep | a training pipeline | a file and a pin | a second program to install and keep working |
| Bundled with the app (ADR-0081 §4) | yes | yes | no: amends ADR-0081 |

## Why this isn't ADR-0020's "client-side scanning"

Client-side scanning is software on a person's own device that inspects their private content, whether messages, files or drafts, for someone else, before or after encryption, and acts on what it finds or reports it. The shelf classifier is none of that:

- **What it reads is already public.** Shelf entries and listing names are published to everyone. Anyone can fetch and archive them (ADR-0081, "Why"), and any outsider could run this model over them without our help.
- **Whose device runs it:** only the steward's, and only in the steward's console, a job the steward took on. No member's, reader's or author's device runs it, or ever downloads the model.
- **What it does with a result:** it puts an entry in a queue on that same device. It sends nothing, tells nobody, and hides nothing. A person decides every hold.
- **It never reads anything sealed,** including the steward's own groups' logs.

**What would make it client-side scanning.** Each of these would, and each needs a new ADR that amends ADR-0020:

- running it on any device but the steward's, including the author's device "to warn before publishing". An unpublished Dispatch is private, and checking a draft is the textbook case;
- giving it anything sealed: a group's log, Working Copies, applications, attached personal Documents, a sealed Dispatch;
- sending a score, a flag or a match off the device, to the relay, to Reconcile, or to anyone, automatically;
- letting a flag hide, delay or refuse an entry with no person deciding;
- matching against a list or model supplied by a party outside Reconcile's own governance, such as a hash list or a government's lexicon.

## What the spike recommended

The founder's answers below replace this where they differ: the classifier is built now, behind a flag.

- **Don't build the classifier until the trigger.** The trigger is ADR-0081 §5's: before any group beyond the founder's is released onto the shelf. Until then the covenant gate holds every listing except the founder's own (ADR-0081 §3), so there is nothing for a classifier to watch. Readers' reports and the steward's console are enough.
- **When the trigger comes, build B with the narrow rule, if the pilot shelf is English.** It is bundled with the app as ADR-0081 says. It reuses #476's runtime and CSP, and it is pinned like Bedfellows' models. On this sample its narrow rule flagged none of the 120 entries that should pass, so it never sends counter-speech or reclaimed language to the queue. It catches only the obvious cases (9 of 40), and the ADR says so plainly. Readers' reports remain the main signal.
- **If a listed group writes in another language,** C with Detoxify `multilingual` is the only option measured that reads one. Choosing it amends ADR-0081 §4.
- **Before the build, re-measure.** Use a sample labelled against the covenant's final clauses, by at least two labellers, with a held-out split, on this harness. Ship only if the narrow rule's false positives on quotation and reclaimed language stay at or under 1 in 20.
- **What the console shows with a flag:** the rule that fired, never a ranking. The queue keeps its order (oldest first), so the classifier can't decide what the steward sees first.

## Decision

The founder answered the sheet on 2026-11-19.

1. **Timing: build it now, behind a feature flag that stays off until the trigger.** The trigger is still ADR-0081 §5's: before any group beyond the founder's is released onto the shelf. Building now means the trigger finds it ready; the flag keeps a rudeness filter from posing as a covenant check before then. The re-measure (a sample labelled by at least two people against the covenant's final clauses, with a held-out split, and at most 1 in 20 false flags on quotation and reclaimed language) is a precondition of turning the flag on, not of building.
2. **Where: B, the small WebAssembly model.** MiniLMv2-toxic-jigsaw (Apache-2.0, about 23.6 MB) on #476's ONNX Runtime Web runtime, its SHA-256 pinned in `modelPins.ts`, fetched and run on the steward's device only. It is bundled with the app as ADR-0081 §4 says, and needs no CSP change beyond #476's.
3. **Rule: narrow,** `threat` or `identity_hate` ≥ 0.5. It flagged none of the 120 entries that should pass, so counter-speech and reclaimed language never reach the queue because of it.
4. **Console: the rule's name only, and the queue keeps its order.** The classifier can't rank entries or decide what the steward sees first.
5. **Sample: it stays outside the repository,** kept by the founder. The repository is now public. The sample holds hateful test text, written by one labeller against placeholder clauses, and committing it would publish it with no review. The build re-measures against a new two-labeller sample at the trigger anyway. #493's tests use a small, clearly labelled fixture with no hateful text: synthetic score vectors, or neutral sentences with stubbed model outputs.

ADR-0080 (Bedfellows, which owns #476's runtime and its `'wasm-unsafe-eval'`) is not on `main` yet, so #493 lands after #476.

## Should it be turned on before ADR-0035's wording is settled?

**No.** The spike first asked whether to build it; the founder chose to build it and keep it off. These four reasons now govern the flag:

1. **Nothing measured detects the draft core's clauses.** Calls for violence and threats are what the core names, and they are what every model here misses. Building now would ship a flagger for rudeness labelled as a covenant check.
2. **The final wording decides the labels.** A sample can only be labelled against settled words. A model or threshold tuned to the placeholder would have to be re-measured anyway.
3. **There is nothing on the shelf to watch yet.** The gate releases only the founder's groups until the wording is settled and read by counsel (ADR-0081 §3).
4. **Building early costs little.** B is a few days' work once #476 has merged: a pin, a worker call and a column in the console. With the flag off, it changes nothing anyone sees.

## Consequences

- §6.6 of [the spec](../spec/listed-doors.md) records this decision. #493 builds B behind a flag that is off by default.
- The steward's device needs #476's runtime, so #493 depends on #476 (and ADR-0080) merging.
- ADR-0081 §4 stands as written: the classifier is bundled with the app. C is not built. If a listed group writes in a language other than English, C with Detoxify `multilingual` is the only option measured that reads one, and choosing it would amend ADR-0081 §4.
- Turning the flag on needs the re-measure, which needs ADR-0035's final wording and a second labeller.
- None of the measured models flags spam. The covenant's spam rule rests on ADR-0081's limits and readers' reports.

## Open questions

- **ADR-0035's final wording** (deferred). It sets the labels the re-measure uses.
- **Who votes on the moderation policy** (ADR-0081 §5, open). Choosing the classifier and its rule is moderation policy. The founder's steward seat decides it for the pilot, and the body ADR-0081 §5 names should ratify it.
- **TensorFlow.js `toxicity`** is unmeasured, because its weights' hosts are refused here. Measuring it needs a session that can reach them.
