---
version: 1
name: Reconcile
description: A warm, civic, paper-and-earth system for reading, amending, and voting on living documents. Documents read like print; controls are plain, friendly, and accessible; safety stays quiet.

colors:
  # Light (default)
  canvas: "#f6f1e7"        # warm paper, the resting state
  surface: "#fffdf8"       # cards, ballots, dialogs
  sunken: "#ece5d6"        # table heads, wells, code
  hairline: "#ddd5c4"      # borders and rules
  ink: "#1d1c19"           # headings, primary text
  body: "#3d3a33"          # running text
  muted: "#6b665b"         # secondary text, captions (≥4.6:1 on every light surface)
  primary: "#1f4a33"       # forest: the one decisive action color
  on-primary: "#f6f1e7"
  primary-soft: "#dfe8dc"  # selected state fill
  ochre: "#a8741a"         # highlight, recommendation marker (non-text or large text only)
  ochre-ink: "#7a5410"     # ochre for small text (≥5.4:1 on every light surface)
  ochre-soft: "#f1e3c4"
  clay: "#8a4b3c"          # warm emphasis, entrenched-Atom accents
  positive: "#2f6b45"
  warning: "#85560f"
  negative: "#b3362a"
  # Ballot scale 0–4 (diverging; always paired with the number and label)
  score-0: "#b3362a"
  score-1: "#a85a35"
  score-2: "#76705f"
  score-3: "#4f7746"
  score-4: "#1f4a33"

colors-dark:
  canvas: "#15140f"
  surface: "#1e1d17"
  sunken: "#26241d"
  hairline: "#3a372d"
  ink: "#f1ece0"
  body: "#d6d0c2"
  muted: "#a39d8f"
  primary: "#8fbf98"       # sage-light on dark keeps the forest hue
  on-primary: "#10170f"
  primary-soft: "#233a2a"
  ochre: "#d9a54a"
  ochre-ink: "#e2b663"
  ochre-soft: "#3a2f18"
  clay: "#d08a76"
  positive: "#7fbf8e"
  warning: "#e0b25c"
  negative: "#e0705f"
  score-0: "#e0705f"
  score-1: "#d9946a"
  score-2: "#a39d8f"
  score-3: "#93b986"
  score-4: "#8fbf98"

typography:
  families:
    serif: '"Newsreader", "Iowan Old Style", Georgia, serif'      # Documents and display
    sans: '"Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif'  # all UI
    mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'      # hashes, ids, keys
  display:   { family: serif, size: 40px, weight: 500, lineHeight: 1.1 }
  heading-1: { family: serif, size: 30px, weight: 500, lineHeight: 1.15 }
  heading-2: { family: serif, size: 23px, weight: 500, lineHeight: 1.2 }
  heading-3: { family: sans,  size: 18px, weight: 650, lineHeight: 1.3 }
  document:  { family: serif, size: 19px, weight: 400, lineHeight: 1.6 }   # Atom text
  body:      { family: sans,  size: 16px, weight: 400, lineHeight: 1.55 }
  ui:        { family: sans,  size: 15px, weight: 500, lineHeight: 1.4 }
  caption:   { family: sans,  size: 13px, weight: 400, lineHeight: 1.4 }
  eyebrow:   { family: sans,  size: 12px, weight: 700, lineHeight: 1.2, letterSpacing: 0.08em, transform: uppercase }
  mono:      { family: mono,  size: 13px, weight: 400, lineHeight: 1.5 }

rounded:
  none: 0px
  sm: 6px      # inputs, chips, badges
  md: 10px     # cards, ballots, dialogs
  lg: 16px     # sheets, large panels
  full: 9999px # buttons, score pills, avatars

spacing: { base: 4px, scale: [4, 8, 12, 16, 24, 32, 48, 64] }

touch-target: 44px
---

# Reconcile Design

## Overview

Reconcile should feel like a well-kept **commons ledger**: warm paper, plain speech, and documents that read like print, because the canonical Document is the point. It isn't a social feed, a fintech dashboard, or a security product. It's civic infrastructure that people of very different politics can sit down at together, and it's friendly to anarchists and mutual-aid groups without looking clandestine.

**Lineage.** This is an original system, mixed from analyses in [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT):
- an earth palette in the spirit of the Oura analysis, adapted, with forest as the single action color
- editorial serif hierarchy from the Wired analysis, applied to Documents
- friendly, rounded, high-contrast controls from the Wise analysis
- **Public Sans**, the US government's open-source civic typeface, as the interface voice

Don't reproduce any of those brands' marks, typefaces, or layouts.

**Key characteristics:**
- Warm paper canvas (`canvas`), not white. Dark mode is a warm charcoal, not blue-black.
- **Forest (`primary`) is the only action color.** Every other color is information.
- Documents are set in **Newsreader** at reading size, with generous measure (60–70 characters) and leading. The UI is set in **Public Sans**. Hashes and keys use **JetBrains Mono**.
- Flat surfaces and hairline rules. No gradients, glassmorphism, or drop-shadow stacks.
- Quiet confidence: no streaks, like counts, confetti, or engagement bait.

## Fonts and privacy

**Self-host every font in the PWA** through `@fontsource` packages (`@fontsource-variable/newsreader`, `@fontsource-variable/public-sans`, `@fontsource-variable/jetbrains-mono`). The app must never call Google Fonts or any other third-party host (client rule: the only network calls are to the relay and the push service). Decision-sheet artifacts may use the Google Fonts CSS for the same families.

## Colors

- **`primary` (forest):** primary buttons, selected states, links in UI chrome, and the "passes" side of the consent meter.
- **`ochre`:** highlights, "Claude's lean" and recommendation markers, unread dots. Use `ochre-ink` for small ochre text.
- **`clay`:** entrenched-Atom accents and warm emphasis. Never errors.
- **Semantic** (`positive`, `warning`, `negative`): system status only. Never use `primary` to mean success.
- **Ballot scale** (`score-0`…`score-4`): a diverging clay → stone → forest ramp. **Always show the number and its label** ("0 · Strongly opposed" … "4 · Strongly supportive"). Color is never the only signal.

All text tokens meet WCAG 2.2 AA (4.5:1) on every surface in both themes, and score pills meet 3:1 as UI graphics with paper-colored numerals at 4.5:1 or better. These were checked when the tokens were set (2026-11-07). Check every new pairing.

## Typography

| Role | Face | Use |
|---|---|---|
| display, heading-1/2 | Newsreader | page titles, Document titles, Atom headings |
| document | Newsreader 19px / 1.6 | all Atom text, ballot versions, diffs |
| heading-3, body, ui, caption | Public Sans | everything interactive or explanatory |
| eyebrow | Public Sans caps, 0.08em tracking | section labels ("OPEN PITCH", "ENTRENCHED") |
| mono | JetBrains Mono | version hashes, ids, recovery phrase |

Keep running text to 60–70 characters per line. Use `text-wrap: balance` on headings.

## Layout

- 4px spacing base. Use the scale only.
- Single column on phones with a 16px side gutter. Reading column max 42rem. App shell max 72rem.
- Touch targets are at least 44px.
- Lay out with grid or flex and `gap`. Avoid margin stacks.

## Shapes and depth

- Radius: `sm` 6px for inputs and chips, `md` 10px for cards and ballots, `full` for buttons and score pills.
- Depth comes from surface contrast (`canvas` → `surface` → `sunken`) and 1px `hairline` borders. One soft shadow at most, and only for floating layers (menus, dialogs).

## Components (Reconcile-specific)

Build on **React Aria Components** (unstyled, accessible). Style everything from these tokens.

- **Atom block:** Newsreader text with a left gutter for its badge.
  - Badges: *Entrenched* has a `clay` outline and a lock glyph. *Eternal* has a double `ink` rule and the eyebrow "ETERNAL".
  - History opens in a side sheet.
- **Pitch card:** title (heading-3), justification (body), a countdown (ui, `muted`), and a "Join discussion" link to the group's linked chat.
- **Ballot:**
  - Competing versions sit side by side on wide screens and stack on phones, with Markdown line diffs (additions on `primary-soft`, deletions on a `negative` tint with strike-through).
  - Each version has a 0–4 segmented control of score pills.
  - Choosing 0 reveals a **required** reason field.
- **Consent meter:** two plain bars:
  - the average against the 2.0 line
  - the share of zeros against the 10% line
  - Each bar is labeled in words ("Passes", "Short by 0.3"). No gauge dials.
- **Result:**
  - The outcome sentence comes first.
  - Totals come next.
  - Individual ballots appear under a disclosure, with the expiry date shown ("Individual votes visible until 12 Dec").
- **Rejected events view:** `sunken` rows in mono, for auditing. Factual tone, never alarming.
- **Safety settings** (app lock, panic wipe, and later duress):
  - neutral styling with the same calm cards as any setting
  - `negative` appears only on the final confirm of a wipe
  - no skulls, no red banners, no "stealth" language
- **Gift prompt** (ADR-0025):
  - an inline card on `ochre-soft` with plain context ("Reconcile is free to use and runs on reciprocity…")
  - a suggested amount, then *Gift* (primary) and *Not now* (quiet text button) on the same line
  - never modal, never repeated in the same session, never guilt-tripping
- **Empty states:** one sentence and one action. No illustrations of crowds or protest imagery.

## Voice

Plain, warm, and direct. Use "your group", not "the community". Write in the active voice and present tense. Say what happens and what doesn't ("Removed members keep what they already had. They won't see anything new."). Don't say "Oops", don't use exclamation marks for errors, and don't use fear language.

## Do

- Let Documents be the visual center: generous serif text on paper.
- Use `primary` for exactly one primary action per view.
- Pair every color signal with text or a glyph.
- Show what's private and what's visible, in words, at the moment it matters.

## Don't

- Don't add a second action color or use semantic colors decoratively.
- Don't add engagement metrics: no likes, streaks, view counts, or leaderboards.
- Don't make safety features loud, or suggest the app is for illegal activity.
- Don't load fonts, icons, or images from third-party hosts in the app.
- Don't show a fork or split action on vote results (ADR-0015).
