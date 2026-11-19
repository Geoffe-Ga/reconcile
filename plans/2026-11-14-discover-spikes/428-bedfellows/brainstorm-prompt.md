# Design brief: the "strange bedfellows" matching algorithm, ending in a decision sheet

I'm the founder of **Reconcile**. I need you to research and design the algorithm behind one of its central features, then hand me the choices as a **decision sheet**: a JSON document in the schema at the end of this brief. Think broadly first, then be rigorous. This is a major feature, not an afterthought.

## What Reconcile is

Reconcile is an app where groups (tenants' unions, church groups, fan communities, recovery fellowships, movements) govern shared documents by voting. Groups that disagree about most things can find what they genuinely share and form coalitions: "strange bedfellows". Reconcile means reconciling people and groups, nothing to do with finance.

- **Local-first.** Each group's data lives on its members' devices. The server is a blind relay that stores encrypted blobs and can't read or enumerate who is in which group, what anyone voted, or who is allied with whom.
- **No global identity.** A person has a separate keypair per group. There are no accounts, emails, phone numbers or real names.
- **The threat model is weaponization.** A database of people, their beliefs and their associations would be valuable to hostile states, extremists, data brokers and harassers. The design must never create:
  - a central record of who believes what;
  - a list of members or affiliations;
  - a graph of which groups resemble or ally with which.

## The feature: Bedfellows on Discover

Discover has a **public shelf**. Groups that opt in by vote publish single short posts called **Dispatches**: a title and up to 500 characters, with the publishing group's name and a "front door" address where readers can ask to join or propose reconciling.

The **Bedfellows view** shows each reader the shelf entries from groups that share *something* with them, but not *everything*. In my words when the feature was decided: "an index that shows things that are from groups that share SOMETHING but not EVERYTHING… the main goal is still to build strange bedfellows."

### What the reader's device has to work with

- The reader's **personal Documents**: their own statements of belief, any length.
- The **Documents of the groups they're in**: mission statements, house rules and the like.
- **Shelf entries**: title, text up to 500 characters, and the publishing levels' names.
- Text may be in several languages, often English. Scale: a few dozen entries in the pilot, thousands later.

### Rules that stand

These come from the existing decision record (ADR-0077 §4). If your design needs one relaxed, say so as a separate, explicit decision in the sheet with its cost. Don't assume it away.

- **Everything runs on the reader's device.** No text, term, score, profile or embedding leaves it. Nothing is stored about how groups resemble each other.
- **No third-party services or scripts.** A model may ship as part of the app, served from our own origin. No calls to model APIs, and nothing that reaches another company's server.
- **Votes, group membership and follows are never signals.**
- **The result must be explainable in words.** Each match shows a line like "You both write about…". With semantic matching this should become something better, like "You both care about keeping the library open".
- **It runs in a PWA on ordinary phones:** a mid-range Android and an iPhone, with WebAssembly and sometimes WebGPU. App size and battery matter.

## What we tried, and why I rejected it

A first spike scored term overlap: stop words removed, light stemming, and two-word phrases at double weight. On an invented corpus of 4 readers and 14 shelf entries, it scored the share of an entry's terms that the reader's closest Document also has. The middle band, about 0.11 to 0.5, caught every pair sharing one thing and left out near-copies and coincidences. It ran in about 0.3 s on a throttled phone profile for 500 entries against 20 Documents. Where it failed:

- **Same idea, other words:** "reading room" against "library" scored 0.05, and was missed.
- **Stance:** an animal-rights call to end deer season scored 0.18 against a hunter. It landed in the band as "kin", but for and against are not common ground.
- **Word sense:** a chess club's "boards" matched a housing board.
- **Passing mentions:** two words in one clause scored like a coincidence.

**My direction now:**
- **Semantic matching**, so "anti-war" matches "pro-peace".
- **Stance-aware**, so "the devil's in the details" doesn't match "warriors against the devil", and opposite sides of one subject don't count as common ground.
- **Learn from affinity-based feeds while rejecting their worst tendency**, which is pushing people into ever narrower, radicalizing niches. This feed should do the opposite. Reconcile people and groups that are almost alike, then, over time, stretch each reader toward stranger and stranger bedfellows. The aim is a more comprehensive reconciliation of ontologies.
- **Dynamic stretching.** Give readers things they strongly and weakly agree with, and gradually widen the distance.

## What to do

### Part 1: research and brainstorm (show your work briefly)

Survey what's relevant, citing only what you're confident exists. Where you're unsure of a name, paper or number, say so instead of inventing one. Cover:

- **Semantic similarity on device:** small sentence-embedding models, multilingual versus English-first, quantization, browser runtimes (WASM, WebGPU), model size and latency on phones.
- **Stance and agreement detection:**
  - natural-language inference;
  - stance datasets and how well models trained on them transfer;
  - extracting (topic, stance) claims from short texts;
  - where these fail on short, informal, value-laden text.
- **Recommenders that avoid radicalization and filter bubbles:** diversity, novelty and serendipity work, and what's known about engagement-optimized feeds pushing people toward extremes.
- **Bridging-based ranking:** systems that surface what people who usually disagree both value, such as Community Notes' bridging algorithm and Polis' consensus statements.
- **Exploration schedules** that widen what a reader is shown over time without a server-side profile.
- **Explanations** that name shared claims or values rather than shared words.

Then brainstorm **at least 8 distinct candidate designs**, including hybrids. For example:
- embeddings alone;
- embeddings plus a stance classifier;
- claims extracted into (topic, stance) pairs and matched as sets;
- topic agreement with value disagreement treated as its own lane;
- a small on-device generative model;
- lexical and semantic signals combined.

Don't stop at these. For each, say in a few lines:
- how it works;
- what it would match and miss on the four failure cases above;
- model size and phone latency, estimated with your uncertainty stated;
- how it explains a match in words;
- what it stores on the device, and for how long.

Pay special attention to privacy:
- **Derived data is sensitive data.** Any embedding, stance vector or reading history computed from a person's own writing is a profile of their beliefs, even if it never leaves the device. A seized or shared phone is in the threat model.
- **For each design, say:**
  - what it keeps at rest;
  - whether that can be avoided, by computing at view time and discarding it;
  - or, if it must be kept, how to seal it behind the device's passkey vault and erase it.
- **Stretching over time** needs some memory of what a reader has seen or how they responded. Treat that as a privacy decision, not an implementation detail.

### Part 2: the decision sheet

Turn your findings into **4 to 7 decisions** I can make at my own pace, ordered so that upstream choices come first. Say in a decision's summary when it depends on an earlier one. A sheet that covers these would serve, but reshape them if your research says otherwise:

1. **The matching method**: the representation and model family.
2. **The model**: what ships with the app, its size, its languages, when it loads (with the app, or on first opening Bedfellows), and how it's updated.
3. **Stance**: how agreement and disagreement on a shared subject are detected, and what the view does with "same subject, other side": leave it out, give it its own clearly labelled lane, or something else.
4. **The band and the stretch**: what "something but not everything" means in the new representation, and the schedule by which a reader is moved toward stranger bedfellows.
5. **Reader signals and memory**: what the stretch may learn from, how long it's kept, how it's sealed and erased. Options might include:
   - nothing at all;
   - explicit "more like this" / "less like this";
   - time spent.
6. **Safeguards against niching and radicalization**: diversity constraints, caps, a bridging bonus, no engagement optimization.
7. **How a match is explained** to the reader.

Include an evaluation plan, either as part of a decision or in the sheet's context:
- a labelled corpus, extending the existing 4 readers × 14 entries with the failure cases above and many more;
- what metrics would show the stretch is reconciling and not radicalizing;
- an on-device latency and size budget for each phone class.

For each decision, give honest trade-offs, costs and risks, and real precedents. Set `recommended` only where you have a defensible lean, and say why. Privacy and weaponization risk must appear as a trade-off dimension in **every** decision.

## The decision-sheet schema

Output a single JSON object as the last thing in your answer, and nothing after it. It must follow these rules exactly, because a script validates it and turns it into an interactive page:

- **Top level:**
  - `id`: use `2026-11-14-bedfellows-algorithm`.
  - `title`: a short noun phrase, e.g. "Bedfellows Algorithm Calls".
  - `prompt`: one sentence restating this brief.
  - `context`: 1–3 sentences on what's settled and what this sheet decides.
  - `created`: "2026-11-14".
  - `decisions`: an array of 4–7 decisions.
  - Don't include a `theme`; I'll add our brand colours.
- **Ids:** every `id` uses only lowercase letters, digits and hyphens. No option may be called `__defer` or `__other`.
- **Each decision has:**
  - `id`.
  - `title`: the short name of the fork.
  - `question`: the choice as one question.
  - `summary`: 2–4 sentences on what's being decided, why it matters now, and what it blocks.
  - `options`: 2–4 real alternatives. Don't add "other" or "later": the page provides both.
  - `multi`: optional, `true` only when several options can be chosen together.
  - `recommended` and `recommendation_reason`: optional, an option id and one or two sentences of reason. Set them only when you have a real lean.
  - `tradeoffs`: an array of 3–6 `{ "dimension": "…", "values": { "<option id>": "…" } }`, with a value for **every** option in every row. One row must be privacy and weaponization risk.
  - `costs`: an array of `{ "item": "…", "values": { "<option id>": "…" } }`, covering at least build time, running cost (including phone battery and storage), complexity and reversibility. Again, a value for every option.
  - `risks`: an array of `{ "risk": "…", "severity": "low" | "medium" | "high", "mitigation": "…", "options": ["<option id>", …] }`. Leave out `options` when a risk applies to every choice.
  - `examples`: an array of `{ "title": "…", "detail": "…", "url": "https://…" }`. Real precedents only. Include `url` only when you're certain it exists; otherwise give the title and detail without a link.
- **Each option has:**
  - `id`;
  - `label`: 1–4 words;
  - `summary`: one sentence on what choosing it means;
  - `pros` and `cons`: up to 3 short strings each.

Before the JSON, give me:
- a short memo (under 800 words) with your research findings, the candidate designs, and your overall recommendation for the pilot and for later growth;
- what you're least sure of, and how the evaluation plan would find out.
