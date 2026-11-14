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
  - Badges (#116) open the block, as an eyebrow, so the word says the class and color is never the only signal. *Entrenched* has a `clay` outline, a lock glyph and the eyebrow "ENTRENCHED", in `clay`. *Eternal* has a double `ink` rule above and below and the eyebrow "ETERNAL", in `ink`. An ordinary section has none.
  - An eternal section offers no change, removal, move or protection. In their place, one caption line says it can't be changed; its History stays, as on every section.
  - **History** (#104): each section's quiet History opens its history in a side sheet: a React Aria Modal on `surface` over the `scrim`, standing at the inline end with `lg` corners on its open edge and the one soft shadow, and the whole screen below 40rem. Its heading and Close stay at the top as it scrolls.
    - Each pass, newest first: its Proposal's title (heading-3), the text it left in Newsreader (or "This removed the section." in body; a move or a class change sets its line, such as "Moved to the top" or "Made eternal", in body over the text), "Proposed by <name> · Decided <date>" (caption, `muted`), its why (body), one totals line (caption), then "See the full result →". A coalition motion lists each group with "Passed" or "Didn't pass" in place of totals, never a count from inside a group.
    - It ends with the founding text, "Written by <name> · Founded <date>", or the Proposal that created the section. "Proposals that didn't pass (N)" is a disclosure under them: each title with its outcome and day.
  - **Change log** (#104): a Document's passed changes, newest first, as `surface` cards under the eyebrow "Change log" and the Document's title: the Proposal's title (heading-3), what it did in body ("Changed ‘Quiet hours start…’", "Added a section", "Removed ‘…’", "Moved after ‘…’", "Made eternal"), and its day (ui, `muted`). Each change opens its section's history; the Document's beginning, its founding text or the Proposal that started it, is a plain card at the end. The Document view links to it under its title, as a forward link.
- **Protection choice** (#116): a radio group of cards, as the Level picker's, each class's name over its one line. While Eternal is chosen, the line "This is permanent…" follows in `body`, set off by a `clay` rule at its start, never an alert color.
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
- **Consent meter:** two plain bars, at the Proposal's own bar (3.0 and 5% for an entrenched one):
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
  - A coalition's Dispatch (#124) comes from a passed motion, whose vote lives inside each member group, so "From the Proposal ‘<title>’" keeps its title as plain text there, and Open goes to the coalition's own Document.
  - A Dispatch that rose from a member group (#126) reads "From <seat> · <date>" on the coalition's home, <seat> being the member group or coalition that passed it below, named as the coalition names it. It has no Open link: its Document stays in the group it started in.
  - On Discover's feed (#429), one line opens the card, above its title: an eyebrow naming the group or coalition it's shown from, in `<bdi>`, as a link to that place's home. A dissolved group's adds " · Ended", in words.
- **A reconcile card's link** (#114, #424; ADR-0077 §6): once the relay holds the card, the link in a read-only field, "Card link", with the warning on who can read it as its hint, then one line in body saying that whoever runs a chat app it goes through can read the link too, then Copy and **Share** (secondary) side by side. Copy is primary on "Your card is ready", and secondary on a formed coalition's row in Coalitions, where a card for another group is made. Share hands the device's share sheet the link alone, never a title or words that name a group; where there's no sheet, or it refuses, Share copies and says so, and closing the sheet says nothing.
- **Following a coalition** (#124):
  - **Share a follow link** sits last on a participant's coalition home, under the eyebrow "Followers": the plain warning first, as body text, then the chat-app line in body, as on a card's link, then the button (secondary: the home has no one primary action) with **Share** (secondary) beside it (#424), then the link in a read-only field with how copying or sharing went, as Copy invite link does. Share sends the link on show at once, or makes one and sends it once it's ready, from the same tap; with no share sheet it copies as the button does.
  - **Follow:** the eyebrow "Follow a coalition", the coalition's name as the heading, then a `surface` card: the eyebrow "Its member groups" over the names on one line, a `muted` "·" between each, then under a hairline "From its statement" over the excerpt in Newsreader. Every name is plain text in `<bdi>`. Then "Follow this coalition?" (heading-2), one line in `body` saying what following shows of you, which is nothing, Follow (the one primary action) and Not now (quiet).
  - **A follower's coalition home:** the eyebrow "Following", the name, the member groups on one line as on Follow, then Dispatches, Documents and Decided, and Unfollow (secondary) at the end, which opens the same alert dialog as Leave. Nothing to propose or take part in.
  - **Start's Following:** one card link per coalition, its name (heading-3) over its member groups (caption).
- **Front door** (#121): the public page a group opens by Proposal.
  - The eyebrow "Front door", the group's name as the heading, then a `surface` card: the eyebrow "From their Document" over the excerpt in Newsreader at document size, and, only when the group chose it, how many people are in it (ui, `body`). Never a member's name.
  - "Ask to join" (heading-3), then two fields, the name to use and why, one line in `body` (ui) saying not to include anything the group shouldn't read, and Send, the page's one primary action. No contact field.
  - A closed door reads "This front door is closed." under the heading "Front door", with one quiet line and no form.
  - **Applications** on group home: one `surface` card each, the name (heading-3) and the day it arrived (meta) on one line, the message as plain body text, "Invited by <name>" in caption, then Send an invite (secondary) and Dismiss (quiet).
- **Coalition room** (#125): a list and a box, never a chat product.
  - The eyebrow "Room", the coalition's name as the heading, then one line in `body` saying who can read it (only the coalition's member groups: not the relay, not its followers) and that each device deletes a message 30 days after the relay received it.
  - Messages run oldest at the top to newest at the bottom, as hairline rows on the paper: the author's coalition name (ui, 650, `ink`) and the relay's time (caption, `muted`; the time alone today, the day and time before) on one line, then the text in body as plain pre-wrapped text inside `<bdi>`: line breaks and spaces show as typed, and Markdown and addresses stay text, never formatting or links. No avatars, reactions, counts or read receipts.
  - A message the relay doesn't have yet sits last, under the writer's name, with its send status (caption, `muted`) under its text.
  - At the bottom, the box ("Message", a few lines tall, taller on drag) and Send, the view's one primary action. Someone who hasn't taken part gets Take part (secondary) there instead, and anyone else one line in `body` saying who writes here.
  - New messages are announced politely, only while the person is at the bottom.
  - On the coalition's home, a card link "Open the room" in its own section, shown only on a device in a member group.
- **Notification switches** (Settings, #99): the disclosure first, as plain body text, then one React Aria switch per group, "Notify me about <group>", all off to start.
  - Each switch is a card on `surface` with a `hairline` border, and a tap anywhere on it toggles it. The track sits at the row's end, at least a 44px target with the card.
  - Off: a `muted` ring with a `muted` thumb at the start. On: the track fills `primary` and the thumb, in `surface`, moves to the end, so the state never rests on color alone.
  - Why one didn't turn on ("Notifications are blocked…", "This device can't get notifications…") is one line in `body`, never an alert color.
- **Erase card** (Settings): one card, "Erase Reconcile from this device", in the same calm style as any setting.
  - It reveals a press-and-hold confirm. Releasing early cancels, and a polite live region announces the progress.
  - `negative` appears only on that final confirm.
  - No skulls, no red banners, no "stealth" language.
- **Passkey offer** (#95, #389): the offer after the pilot notice, and Settings' Lock with a passkey. It never pressures and never hides Not now.
  - What a passkey does (body), then the two taps: Make a passkey (primary; secondary in Settings, whose one primary action is Make a backup file) with Not now (quiet) on its line.
  - **A way back first** (#389). With groups and no way back, "First, a way back to your groups" (heading-3) and one line in body take setup's place, then Save a backup's own form, whose Make a backup file is the one primary action, then "Choose recovery contacts instead →" as a forward link, then Not now. Once the file is saved, setup takes the form's place under one line saying so.
  - On a device with no group yet, one line says the offer waits, with Continue (primary) and Not now (quiet).
  - In Settings, one line in body points to the sections above. A device locked before #389 with no way back keeps its "locked" line, with a notice under it (`sunken` ground, `warning` rule) asking for a backup file or recovery contacts. It never offers to unlock or unseal.
- **Linking code** (#96): the code a second device scans.
  - An inline SVG of the QR modules, `qr-dark` on `qr-light` in both themes, with a 4-module quiet zone, a `hairline` border and `md` corners. Never a `data:` image (the CSP refuses one) or a light-on-dark code, which many cameras can't read.
  - Beside it on wide screens, under it on phones, the same code as selectable `mono` text on `sunken`, which selects as a whole, and Copy the code (secondary).
  - The six-digit number both devices show sits in a `surface` card with a `hairline` border: the prompt (heading-3), then the digits in two groups of three, in JetBrains Mono at `display` size.
  - Match is the one primary action on the existing device. The new device shows the number with only Cancel.
- **Recovery contacts** (#109; ADR-0008, ADR-0043): trust, never growth. Nothing counts, ranks or invites anyone.
  - Settings shows what contacts are, then "<n> recovery contacts · <t> needed" (heading-3) over one line per contact: the name (ui, `ink`), then "in <group>" (caption, `muted`). A contact who has gone carries "No longer in a shared group" as caption words on a `sunken` chip, never a color alone. Below t, a notice with a `warning` rule asks the person to choose again. Choose (secondary) opens the picker.
  - The picker (`#/recovery`) puts the issue's words on whom to pick in body text, then two counts as number fields with a step either side, "People to pick" (3–7, 5 to start) and "Needed to help you back in" (2–5, 3 to start), and one line saying what they mean. Each group is a card on `surface` with a `hairline` border: "People in <group>" (heading-3), then a checkbox per person. A live line counts the picks, and Save recovery contacts (primary) is ready once they match.
  - A held share is one line, "You're holding a recovery share for <name> (<group>)": listed under "Shares you hold" in Settings, and once on that group's home on the backup card's `sunken` ground, with OK (quiet) to put it away. Never a modal.
- **Recovering with contacts** (#118; ADR-0043 §2): the same calm as recovery contacts. Nothing counts down, flashes or uses fear words.
  - The new device (`#/recover`) shows the code in a read-only field (as an invite link is shown), Share the code (primary), then both numbers in the linking number's card: what to do (heading-3), then "First number" (the check) and "Second number" (#398), each an eyebrow over its six digits in two groups of three, JetBrains Mono at `display` size, side by side where there's room and stacked on a phone, then why the second matters in caption. The wait follows in caption, then one live line ("Waiting for your contacts.", or "1 of 2 shares have arrived."), with a caption under it once a share came with a different second number, then Stop recovering (secondary) with what it does in caption.
  - Once a backup opens (#398), "Are these your groups?" (heading-2) takes the code's place, so Yes is the view's one primary action: one line in body, then the names on a `surface` card with a `hairline` border, one per line (ui, `ink`) in `<bdi>`, then Yes, restore them (primary) beside No, they aren't mine (secondary), with Restoring… as a live status. After No, the code comes back under a notice (`sunken` ground, `warning` rule) saying nothing was restored and what to do next.
  - Help someone recover (`#/help-recover`) lists each recovery the device helps with as one line (ui, `ink`), the name in `<bdi>`: "Holding <name>'s share until <date>. Open Reconcile after then to send it.", then ready, sent or cancelled in plain words. A sent share names the second number it went with, and while it can go again, Send it again with another number (quiet) opens the second number's field under the line, with Send again (secondary) beside Cancel (quiet) (#398). Its form takes the code (primary Continue), then "Which person?" as the level picker's radio cards, the call line in body, the two number fields, and Approve (primary) beside Back (secondary). A wrong number is one `form-error` line.
  - The alert is a notice: `sunken` ground, a 3px `warning` rule, `sm` corners, the issue's words in ui, then Cancel this recovery (secondary) with a live status under it. It comes first on Start and first among group home's quiet cards, never a modal or a banner. Once cancelled, the rule turns `hairline` and the words say so, so the state never rests on color alone.
  - After a recovery, the picker and Settings ask the person to choose again in a notice with a `warning` rule.
- **Gift prompt** (ADR-0025):
  - an inline card on `ochre-soft` with plain context ("Reconcile is free to use and runs on reciprocity…")
  - a suggested amount, then *Gift* (primary) and *Not now* (quiet text button) on the same line
  - never modal, never repeated in the same session, never guilt-tripping
- **Tab bar** (#423; ADR-0077 §7): the app's three places, one tap apart: **Groups** (Start, still the opening screen), **Discover** and **Me** (Personal, with Settings a quiet forward link at its end).
  - A `nav` named "Main" along the bottom of the viewport: `surface` with a `hairline` rule on its top edge, and padded below by `env(safe-area-inset-bottom)` so it clears the iPhone home indicator in the installed app. Three equal columns, held to the reading column on wide screens.
  - The page scrolls in its own full-width region above the bar, as an installed app's does, so nothing ever sits under the bar: a control at the bottom edge is never half covered, and a focused one is never hidden.
  - Each tab is one link: a 24px line glyph (1.75px `currentColor` strokes, round ends) over its word in caption, at least 44px tall, `muted` at rest. Groups is two people, Discover a compass, Me one person.
  - The current place says so three ways, never by color alone: `aria-current` ("page", or "true" on Settings, a page of Me's), its glyph and word in `primary` with the word at 650, and a 3px `primary` pill, 32px wide, on its top edge.
  - Never a count, a badge or a dot. It shows only on Start, Discover, Personal and Settings: never behind first run, on a shared page or a link's own page, or on a screen whose one primary action is a form or a ballot.
- **Discover** (#423, #429; ADR-0077 §6–§7): the eyebrow "Reconcile" and the heading "Discover", then the feed, or the empty state's one sentence as a lede while there's nothing to read, then "Open a card or link" (heading-3) over one field, "Card or link", whose hint names every kind it opens, and Open, the page's one primary action. It opens an invite, a reconcile card, a follow link or a front door link exactly as Start's field does, through the same shared field; anything else gets one line in the field's error, which never repeats the text.
  - **The feed** (#429): every Dispatch the device holds, from the person's groups and the coalitions they're in or follow, newest first, one Dispatch card each, as on the Dispatches view, with the eyebrow over its title. A Dispatch that rose shows once, from the highest level it reached. Never a count, a "new" badge or a reaction.
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
