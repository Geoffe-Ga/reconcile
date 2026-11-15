# ADR-0077: The Landing Page Is the First Step of First Run; Screens Show Painted Edges

- **Status:** Accepted
- **Date:** 2026-11-15
- **Decided via:** the founder's instructions while the landing page was built (PR for `claude/amazing-wright-7fyzc1`): "Ship this as the landing page, with a link to the landing page we have now for actually downloading the app from Safari through the create or join a group page", and "put these images behind every screen for which it makes sense to (not ones where you need deep focus or where aesthetics don't matter), so that there are a few pixels through which you can see them at the borders of the page."
- **Amends:** spec §8.1 (first run), [`DESIGN.md`](../../DESIGN.md)

## Context

Until now a new visitor to Reconcile's address landed straight on first run: the install guide on an iPhone or iPad, the pilot notice everywhere else. Nothing said what Reconcile is.

The app is one page at `/`, with every route after `#` (spec §8). The installed app starts at `/` too, and the relay keeps no cookies or sessions, so the server can't tell a new visitor from someone opening the app they installed.

The app's screens were plain paper. The founder wanted them a little friendlier, without spending the reader's attention.

## Decision

### 1. The landing page is a screen of the app, shown before first run

- `FirstRunGate` shows the landing page (`src/screens/Landing.tsx`) when all three hold: the visit is plain (no invite link), the page runs in a browser tab (not the installed app), and this device hasn't accepted the pilot notice.
- Its **Start a Group** button moves on to first run as it was: the install guide on an iPhone or iPad, where Safari's Add to Home Screen installs the app, and the pilot notice everywhere else, then Start with Create group and Join.
- An invite link, the installed app and a device that has accepted the notice all skip it.
- **It stores nothing and makes no keys.** Having seen it is kept in memory only, so first run's rule holds: nothing is recorded before the notice is accepted.
- It explains each feature through a case study, at about a 7th-grade reading level. Its words live in `messages.landing`.

**Not chosen:**
- *A static page at `/` with the app moved to `/app/`.* It would change the installed app's scope and start address, every invite link, the service worker's scope, the Caddyfile and the CSP checks, and strand anyone who has already installed the app.
- *A static page at another address, such as `/welcome`.* It wouldn't be what a visitor to Reconcile's address sees, which is what a landing page is for.

### 2. The landing page's painting is never kept on the device

The page sits over one tall painting, made by `painting/paint.py` and cut into a piece per section (`client/public/painting/`, a few megabytes). The service worker's list of files to keep leaves that folder out: only a new visitor sees it, and a new visitor is online.

### 3. Some screens show the painting at their edges

- A screen that names a scene (`data-scene` on its page shell) shows **a few pixels of the painting around the window**: 6px on a phone, 10px on wider windows. Inside the edge the page is plain paper, as before. The edge is a ring drawn over the page, so words scroll under it and never across it.
- **Painted:** the install guide, Start, Create group and Join (sky); Group home and its status pages (canopy); Group rules (trunks); Personal (soil).
- **Plain:** reading a Document, writing or weighing a Proposal (the composers, the Proposal page and its ballot), a personal Document, the pilot notice, linking a device, and Settings. These need care or deep focus, and a colored edge would pull at it.
- The edge pieces are small (`client/public/edges/`, four images) and are kept on the device, so the app looks the same offline.
- Nothing moves. Night dims the same pieces; nothing is repainted.

`src/styles/scenes.test.ts` holds this list: a new screen with a page shell fails the test until it's put on one side or the other.

## Consequences

- Spec §8.1 gains the landing page as step 0 of first run.
- `DESIGN.md` gains "Painted edges" and "The landing page". Its rule against gradients stands; the painting is an image, and it never sits behind text.
- The static `landing/` folder is gone. The painter lives in `painting/`.
- The end-to-end helper that passes first run presses Start a Group first.
- The landing page needs the app's script to show. A visitor with scripts turned off sees nothing, as with the rest of the app.

## Open questions

- **The pilot wording.** The page says "a small pilot" and "It's free". Check both against the pilot plan ([ADR-0056](0056-pilot-plan.md)) before more people see it.
- **"An operating system for anarcho-syndicalism."** The founder's line is on the page as a note. `DESIGN.md` asks for language a family won't feel shut out by; whether this line stays is the founder's call.
