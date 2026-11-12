# Landing page

One static page that says what Reconcile is, for phones and desktops alike, set over a
hand-painted background in the manner of an old animated film or a pre-rendered game screen. It is
a single scene read from top to bottom: sky, canopy, intertwining branches, trunks, soil, roots,
and the mycelial network that joins them. Each layer carries the part of the product it stands
for, and the words sit on paper cards over the painting.

| Layer | What it says |
|-------|--------------|
| Sky and canopy | Every group is its own tree, with its own living Documents |
| Branches | Propose → Discuss → Vote → Update |
| Trunks | The consent floor ([ADR-0002](../docs/adr/0002-consent-floor-vote-rule.md)) and the three levels ([ADR-0021](../docs/adr/0021-level-names-and-self-selection.md)) |
| Soil and roots | Local-first, and no list of everyone ([ADR-0001](../docs/adr/0001-local-first-trust-model.md)) |
| Mycelium | Coalitions, formed by private invitation ([ADR-0074](../docs/adr/0074-mvp-scope-revised.md)) |

## Files

- `index.html`: the copy and structure. Edit the words here.
- `landing.css`: layout, type and which piece of the painting goes behind which section. The
  tokens at the top mirror [`DESIGN.md`](../DESIGN.md).
- `paint.py`: paints the background. See below.
- `img/wide/`, `img/tall/`: the painting, cut into one WebP per section. `wide` is for windows
  1100px and up, `tall` for phones and narrow windows.
- `fonts/`: self-hosted Newsreader and Public Sans (see `fonts/README.md`).

### How the painting is made

`paint.py` simulates a brush. Nothing in it is a photograph or a model's output.

1. **Compose.** It blocks in one tall picture in flat color: the underdrawing.
2. **Paint.** It covers a toned ground with strokes that follow the underdrawing, big brushes
   first, then finer ones only where the picture still differs from it. Each stroke is a bundle of
   bristles of slightly different color, so it streaks like gouache. Fine lines (twigs, grass,
   root hairs, fungal threads) go on last, and the sunbeams and the network's glow are glazed over
   the top.
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
- **Nothing here promises a public directory**, or names a real group.

## Open questions

These need a decision before the page goes live. None is settled by an ADR yet.

1. **Where it is served.** `deploy/Caddyfile` serves the app at `/` and sends every unknown path to
   the app's `index.html`. The landing page needs its own path or its own host.
2. **Where "Start a group" goes.** Both buttons link to `/` as a placeholder for the app.
3. **When it goes public.** [ADR-0024](../docs/adr/0024-source-available-license.md) keeps the repo
   unpublished for now, and the pilot notice ([ADR-0056](../docs/adr/0056-pilot-plan.md)) comes before anyone makes
   keys. The page says "a small pilot"; check that wording against the pilot's terms.
