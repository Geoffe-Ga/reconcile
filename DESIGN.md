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
  negative-soft: "#f5ddd5" # tint under deleted words in a word diff (ink on it: 13.1:1)
  scrim: "#1d1c1973"       # ink at 45%: behind a modal dialog, and its one soft shadow
  qr-dark: "#1d1c19"       # a linking code's modules (#96): light ink, in both themes
  qr-light: "#fffdf8"      # its ground and quiet zone: light surface, in both themes
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
  negative-soft: "#402a22" # ink on it: 11.4:1
  scrim: "#0a0a07b3"       # near-black at 70%: dark in both themes, never a light wash
  qr-dark: "#1d1c19"       # unchanged in dark: a camera reads dark modules on light
  qr-light: "#fffdf8"
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

**Self-host every font in the PWA** through `@fontsource` packages (`@fontsource-variable/newsreader`, `@fontsource-variable/public-sans`, `@fontsource-variable/jetbrains-mono`). The app must never call Google Fonts or any other third-party host. The client rule in [`client/CLAUDE.md`](client/CLAUDE.md) says so: the app's only network calls go to the relay and, once a group has turned its bot on by Proposal, that group's Discord webhook (#119). Decision-sheet artifacts may use the Google Fonts CSS for the same families.

## Colors

- **`primary` (forest):** primary buttons, selected states, links in UI chrome, and the "passes" side of the consent meter.
- **`ochre`:** highlights, and "Claude's lean" and recommendation markers. Use `ochre-ink` for small ochre text.
- **`clay`:** entrenched-Atom accents and warm emphasis. Never errors.
- **Semantic** (`positive`, `warning`, `negative`): system status only. Never use `primary` to mean success.
- **Diff tints** (`primary-soft`, `negative-soft`): the backgrounds under added and deleted words in a word diff. Text on them uses `ink`, and the strike line on `negative-soft` uses `negative` (4.6:1 light, 4.3:1 dark).
- **Ballot scale** (`score-0`…`score-4`): a diverging clay → stone → forest ramp. **Always show the number and its label** ("0 · Strongly opposed" … "4 · Strongly supportive"). Color is never the only signal.

All text tokens meet WCAG 2.2 AA (4.5:1) on every surface in both themes, and score pills meet 3:1 as UI graphics with paper-colored numerals at 4.5:1 or better. These were checked when the tokens were set (2026-11-07). Check every new pairing.

- Numerals and text on a score color use `surface`, the lighter paper: at least 4.86:1 in light and 5.35:1 in dark. `canvas` falls just short on `score-1` and `score-2` in light (4.46 and 4.39:1), so don't use it there (#66).

## Typography

| Role | Face | Use |
|---|---|---|
| display, heading-1/2 | Newsreader | page titles, Document titles, Atom headings |
| document | Newsreader 19px / 1.6 | all Atom text, ballot versions, diffs |
| heading-3, body, ui, caption | Public Sans | everything interactive or explanatory |
| eyebrow | Public Sans caps, 0.08em tracking | section labels ("PROPOSAL 3 · OPEN", "ENTRENCHED") |
| mono | JetBrains Mono | version hashes, ids, recovery phrase |

Keep running text to 60–70 characters per line. Use `text-wrap: balance` on headings.

## Layout

- 4px spacing base. Use the scale only.
- Single column on phones with a 16px side gutter. Reading column max 42rem. App shell max 72rem.
- Touch targets are at least 44px.
- Pressable controls respond to the first tap without waiting out double-tap zoom, and pinch zoom always stays on (`touch-action: pan-x pan-y pinch-zoom`, in `client/src/styles/pressable.css`).
- Lay out with grid or flex and `gap`. Avoid margin stacks.

## Shapes and depth

- Radius: `sm` 6px for inputs and chips, `md` 10px for cards and ballots, `full` for buttons and score pills.
- Depth comes from surface contrast (`canvas` → `surface` → `sunken`) and 1px `hairline` borders. One soft shadow at most, and only for floating layers (menus, dialogs).
- A modal dialog sits on `surface` over a `scrim`, which darkens the page in both themes, and its shadow uses the same `scrim`.

## Components (Reconcile-specific)

Build on **React Aria Components** (unstyled, accessible). Style everything from these tokens.

- **Atom block:** Newsreader text with a left gutter for its badge.
  - Badges: *Entrenched* has a `clay` outline and a lock glyph. *Eternal* has a double `ink` rule and the eyebrow "ETERNAL". #116 builds them.
  - **History** (#104): each section's quiet History opens its history in a side sheet: a React Aria Modal on `surface` over the `scrim`, standing at the inline end with `lg` corners on its open edge and the one soft shadow, and the whole screen below 40rem. Its heading and Close stay at the top as it scrolls.
    - Each pass, newest first: its Proposal's title (heading-3), the text it left in Newsreader (or "This removed the section." in body), "Proposed by <name> · Decided <date>" (caption, `muted`), its why (body), one totals line (caption), then "See the full result →". A coalition motion lists each group with "Passed" or "Didn't pass" in place of totals, never a count from inside a group.
    - It ends with the founding text, "Written by <name> · Founded <date>", or the Proposal that created the section. "Proposals that didn't pass (N)" is a disclosure under them: each title with its outcome and day.
  - **Change log** (#104): a Document's passed changes, newest first, as `surface` cards under the eyebrow "Change log" and the Document's title: the Proposal's title (heading-3), what it did in body ("Changed ‘Quiet hours start…’", "Added a section", "Removed ‘…’"), and its day (ui, `muted`). Each change opens its section's history; the Document's beginning, its founding text or the Proposal that started it, is a plain card at the end. The Document view links to it under its title, as a forward link.
- **Proposal card:** title (heading-3), justification (body), a countdown (ui, `muted`), and a "Join discussion" link to the group's linked chat.
- **Ballot:**
  - Competing versions sit side by side on wide screens and stack on phones.
  - Each version shows a word diff of the Markdown source against the current text, in Newsreader with its line breaks kept: additions underlined on `primary-soft`, and deletions struck through on `negative-soft`, the `negative` tint. Each change is also marked "added" or "removed" in text for screen readers, so color is never the only signal.
  - Each version has a 0–4 segmented control of score pills.
  - Choosing 0 reveals a **required** reason field.
  - A priority vote's options (#107) are cards like versions, each headed by the option as plain text in Newsreader, with its own pills and consent meter. Phones stack them; wide screens set two columns, then three.
- **Level picker** (#90): the three involvement levels as a radio group of cards, Member to Co-Creator.
  - Each card shows the level's name (ui, semibold) over its one line (caption, `body`). A tap anywhere on the card picks it.
  - The chosen card takes a `primary` border on `primary-soft`, and its ring fills with a dot, so the choice never rests on color alone.
  - On People, Save your choice (secondary) appears only once the choice differs from the person's level.
- **Consent meter:** two plain bars:
  - the average against the 2.0 line
  - the share of zeros against the 10% line
  - Each bar is labeled in words ("Passes", "Short by 0.3"). No gauge dials.
- **Result:**
  - The outcome sentence comes first.
  - Totals come next.
  - Individual ballots appear under a disclosure, with the expiry date shown under its toggle ("Individual scores and notes are visible until Sat 12 Dec. Screenshots taken before then can outlast this.", #111).
  - Once they expire, a caption takes the disclosure's place ("Individual scores and notes were cleared on Sat 12 Dec."), and the totals stay.
  - A priority vote's result (#107) names the focus, then lists the options that passed, best first, and those that didn't clear the floor, by their text alone. Its totals go under the disclosure with the ballots. Once the ballots expire, that disclosure, now "Totals", keeps the totals, with the cleared caption in the ballots' place.
- **Dispatch card** (#112): a `surface` card with a `hairline` border, as every card.
  - The title in heading-3, then "From <name> · <date>" (caption, `muted`). A Dispatch a Proposal carried reads "From the Proposal ‘<title>’", the title a link to it.
  - The text in body, as plain pre-wrapped text: line breaks and spaces show as typed, and Markdown and addresses stay text, never formatting or links.
  - "Open <Document title> →" as a forward link when it points to a Document.
  - On the Dispatches view, Send a Dispatch is the one primary action; on Group home, it's secondary, beside See all.
- **Front door** (#121): the public page a group opens by Proposal.
  - The eyebrow "Front door", the group's name as the heading, then a `surface` card: the eyebrow "From their Document" over the excerpt in Newsreader at document size, and, only when the group chose it, how many people are in it (ui, `body`). Never a member's name.
  - "Ask to join" (heading-3), then two fields, the name to use and why, one line in `body` (ui) saying not to include anything the group shouldn't read, and Send, the page's one primary action. No contact field.
  - A closed door reads "This front door is closed." under the heading "Front door", with one quiet line and no form.
  - **Applications** on group home: one `surface` card each, the name (heading-3) and the day it arrived (meta) on one line, the message as plain body text, "Invited by <name>" in caption, then Send an invite (secondary) and Dismiss (quiet).
- **Notification switches** (Settings, #99): the disclosure first, as plain body text, then one React Aria switch per group, "Notify me about <group>", all off to start.
  - Each switch is a card on `surface` with a `hairline` border, and a tap anywhere on it toggles it. The track sits at the row's end, at least a 44px target with the card.
  - Off: a `muted` ring with a `muted` thumb at the start. On: the track fills `primary` and the thumb, in `surface`, moves to the end, so the state never rests on color alone.
  - Why one didn't turn on ("Notifications are blocked…", "This device can't get notifications…") is one line in `body`, never an alert color.
- **Erase card** (Settings): one card, "Erase Reconcile from this device", in the same calm style as any setting.
  - It reveals a press-and-hold confirm. Releasing early cancels, and a polite live region announces the progress.
  - `negative` appears only on that final confirm.
  - No skulls, no red banners, no "stealth" language.
- **Linking code** (#96): the code a second device scans.
  - An inline SVG of the QR modules, `qr-dark` on `qr-light` in both themes, with a 4-module quiet zone, a `hairline` border and `md` corners. Never a `data:` image (the CSP refuses one) or a light-on-dark code, which many cameras can't read.
  - Beside it on wide screens, under it on phones, the same code as selectable `mono` text on `sunken`, which selects as a whole, and Copy the code (secondary).
  - The six-digit number both devices show sits in a `surface` card with a `hairline` border: the prompt (heading-3), then the digits in two groups of three, in JetBrains Mono at `display` size.
  - Match is the one primary action on the existing device. The new device shows the number with only Cancel.
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
- Don't show a part-ways action on vote results (ADR-0015, ADR-0068).
