# Landing page

One static page that says what Reconcile is, for phones and desktops alike, set over a
hand-painted background in the manner of an old animated film or a pre-rendered game screen. It is
a single scene read from top to bottom: sky, canopy, intertwining branches, trunks, soil, roots,
and the mycelial network that joins them. Each layer carries the part of the product it stands
for, and the words sit on paper cards over the painting.

| Layer | What it says |
|-------|--------------|
| Sky | The word itself: *Reconcile*, defined, with what a Group can do |
| Canopy | **Dispatch**, as a case study: news of one talk, voted up from a Group to a Coalition to a bigger one, and where it stops ([ADR-0037](../docs/adr/0037-holonic-promotion.md), [ADR-0071](../docs/adr/0071-self-hosting-and-reach.md)) |
| Canopy, where the boughs cross | **Reconcile**, as a case study: two Groups that disagree on one thing and share another form a Coalition ([ADR-0074](../docs/adr/0074-mvp-scope-revised.md)) |
| Trunks | **Documents**, as two short case studies, then how a vote works ([ADR-0002](../docs/adr/0002-consent-floor-vote-rule.md)) and the three levels ([ADR-0021](../docs/adr/0021-level-names-and-self-selection.md)) |
| Soil and roots | **Privacy**: the risk, then the answer ([ADR-0001](../docs/adr/0001-local-first-trust-model.md)) |
| Mycelium | Built to pass ideas along, not to hold attention ([ADR-0070](../docs/adr/0070-patronage-not-attention.md)) |

The page explains each feature through a case study, not a description. The case studies are the
founder's. Each is broken into small pieces a reader can take in at a glance: numbered steps with
how each vote came out, two things side by side, lines marked as shared or dividing, and tags.
Color never carries a meaning alone; the words or a mark say it too.

The copy aims at about a 7th-grade reading level: short sentences, common words, one idea each.
Keep it there when you edit.

## Files

- `index.html`: the copy and structure. Edit the words here.
- `landing.css`: layout, type and which piece of the painting goes behind which section. The
  tokens at the top mirror [`DESIGN.md`](../DESIGN.md).
- `paint.py`: paints the background. See below.
- `img/wide/`, `img/tall/`: the painting, cut into one WebP per section. `wide` is for windows
  1200px and up, `tall` for phones and narrow windows.
- `fonts/`: self-hosted Newsreader and Public Sans (see `fonts/README.md`).

### How the painting is made

`paint.py` simulates a brush. Nothing in it is a photograph or a model's output.

1. **Compose.** It blocks in one tall picture in flat color: the underdrawing.
2. **Paint.** It covers a toned ground with strokes that follow the underdrawing, big brushes
   first, then finer ones only where the picture still differs from it. Each stroke is a bundle of
   bristles of slightly different color, so it streaks like gouache. Branches, twigs and roots are
   part of the underdrawing, so the brush paints them like everything else; none of them is a
   ruled line, and neither are the fungal threads. Only grass and ferns go on last with a fine
   brush. The sunbeams and the threads' glow are laid over the top as light.
3. **Cut.** It slices the tall picture into a piece per page section.

```bash
python3 -m venv /tmp/paint && /tmp/paint/bin/pip install numpy opencv-python-headless
/tmp/paint/bin/python landing/paint.py                              # both layouts: about ten minutes
/tmp/paint/bin/python landing/paint.py --scale 0.4 --out /tmp/look  # a quick look: about a minute
```

numpy and OpenCV are needed only to repaint; they aren't in the repo's requirements, and the page
itself needs nothing. The random seed is fixed, so the same script paints the same picture.

### How the pieces fit the page

- Each section's `aspect-ratio` in `landing.css` matches its piece's height in `paint.py`
  (`WIDE.heights`, `TALL.heights`), so the pieces meet edge to edge. Change one, change the other.
- The four near trees are at the same x in every piece (`trees` in each layout), so trunks run
  straight down into their roots.
- If a section's text needs more room than its piece gives, the section grows and the painting
  crops at the sides. A small seam can show there. Give the layout more height in `paint.py`
  rather than fighting it in CSS.
- Night doesn't repaint anything: `--tint` multiplies the same painting down to a cool, dim
  version.

## See it

```bash
python3 -m http.server --directory landing 8080   # then open http://localhost:8080
```

Check it at a phone width (about 390px) and a desktop width, in light and dark.

## Rules it keeps

- **No scripts, no cookies, no third-party requests.** The page says so in its footer, so keep it
  true. Nothing on the page moves.
- **It passes the deploy CSP as it stands** (`deploy/Caddyfile`): one stylesheet from its own
  origin, images and fonts from its own origin, no `<style>` elements, no `style` attributes, no
  `data:` URLs.
- **The copy uses the domain vocabulary** in the root `CLAUDE.md`, and the ballot labels match
  `client/src/app/messages.ts`.
- **Nothing here promises a public directory.** The case studies use kinds of group (a sangha,
  a local chapter), never a real, named one.

## Open questions

These need a decision before the page goes live. None is settled by an ADR yet.

1. **Where it is served.** `deploy/Caddyfile` serves the app at `/` and sends every unknown path to
   the app's `index.html`. The landing page needs its own path or its own host.
2. **Where "Start a group" goes.** Both buttons link to `/` as a placeholder for the app.
3. **When it goes public.** [ADR-0024](../docs/adr/0024-source-available-license.md) keeps the repo
   unpublished for now, and the pilot notice ([ADR-0056](../docs/adr/0056-pilot-plan.md)) comes before anyone makes
   keys. The page says "a small pilot"; check that wording against the pilot's terms.
