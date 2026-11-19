<!--
Draft for ADR-0077, to append after "## Open questions" once the founder picks a band (#428).
Not committed. Fill in the three marked places, then:
- set KINSHIP_BAND in client/src/discover/kinship.ts to the pick, if it isn't 0.11 to 0.5,
  and its doc comment's words ("about a ninth", "less than half");
- if the pick takes in passing mentions (a floor at or under 0.08), the sample test
  "leaves out one thing mentioned only in passing" in kinship.test.ts flips to "takes in",
  and "leaves out the unrelated" must then expect the boards/winter coincidence in the band;
- update KINSHIP_METHOD only if the founder picks another method.

What it should record: the method in a sentence or two, the band and the founder's words
for it, the three things the method can't see and what the founder decided about each
one that's a product call (the opposed pair, the passing mention), the privacy line, and
when to measure again.
-->

## Amendment (2026-11-__, kinship spike, #428)

§4's first values are set.

- **The method:** term overlap on the device (`client/src/discover/kinship.ts`). Each text loses stop words, numbers and words under three letters. Its words fold to a light English stem, and two words side by side also count as a phrase, at twice a word. An entry's score is the share of its terms that the reader's single closest Document also has, from 0 (nothing shared) to 1 (the reader already says all of it). Its shared words and phrases are the "You both write about …" line.
- **The band:** Bedfellows shows entries scoring from **__LOW__** up to, not including, **__HIGH__**, in the founder's words: "__FOUNDER'S WORDS__". The spike proposed 0.11 to 0.5, from sample writing where that range took in every pair sharing one thing and left out every near copy and every unrelated pair.
- **What it reads:** the reader's personal Documents and their groups' Documents, and an entry's title and text. It never reads the names on an entry, a vote, a membership or a follow. It sends nothing and stores nothing: scores are worked out when the view opens and kept only while it's open, so no likeness between groups is ever written down (ADR-0001).
- **What it can't see**, and what the founder decided:
  - The same idea in other words ("reading room" for "library") scores near 0. Accepted.
  - It can't tell agreement from the other side of one subject: an animal-rights call to end deer season reads as kin to a hunter. __KEEP / A LATER ISSUE TO TELL THEM APART__.
  - A thing mentioned only in passing (two words in one clause) scores like a coincidence: __LEFT OUT / TAKEN IN, WITH ITS COINCIDENCES__.
  - Which sense a word has ("boards" in a chess park and a housing board), and words in scripts written without spaces. The stemming is English only.
- **Speed:** 500 entries against 20 Documents take about 0.3 s in Chromium with phone emulation at 4× CPU throttling, and about 45 ms on a desktop.
- **Measure again** once the pilot shelf holds real entries. Weighting rare words by how few shelf entries use them made no difference on 14 samples, but may on a full shelf.
