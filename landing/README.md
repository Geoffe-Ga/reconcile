# Landing page

One static page that says what Reconcile is, for phones and desktops alike, drawn like a 16-bit
video game. It is a single scene read from top to bottom: sky, canopy, intertwining branches,
trunks, soil, roots, and the mycelial network that joins them. Each layer carries the part of the
product it stands for, and the words sit in dialog-box windows on top.

| Layer | What it says |
|-------|--------------|
| Sky and canopy | Every group is its own tree, with its own living Documents |
| Branches | Propose → Discuss → Vote → Update |
| Trunks | The consent floor ([ADR-0002](../docs/adr/0002-consent-floor-vote-rule.md)) and the three levels ([ADR-0021](../docs/adr/0021-level-names-and-self-selection.md)) |
| Soil and roots | Local-first, and no list of everyone ([ADR-0001](../docs/adr/0001-local-first-trust-model.md)) |
| Mycelium | Coalitions, formed by private invitation ([ADR-0074](../docs/adr/0074-mvp-scope-revised.md)) |

## Files

- `index.html`: the copy and structure. Edit the words here.
- `landing.css`: layout, type and which picture goes where. The tokens at the top mirror
  [`DESIGN.md`](../DESIGN.md); the scene colors under them match the palette in `scene.mjs`.
- `scene.mjs`: draws the pixel art. `node landing/scene.mjs` rewrites every PNG in `img/`. It has
  no dependencies and a fixed random seed, so an unchanged script writes the same files. Change
  the art there, never by editing a PNG.
- `img/day/`, `img/night/`: the pictures. Night is a palette swap of day: same drawing, different
  colors, and the stars only show at night.
- `fonts/`: self-hosted Press Start 2P and Public Sans (see `fonts/README.md`).

### How the pictures fit together

- Every strip is 320 art pixels wide and tiles sideways from the middle of the page. The four
  trees are at the same x in every strip (`TREES` in `scene.mjs`), so trunks and roots line up.
- `--px` in `landing.css` is how many screen pixels one art pixel takes: 2 on phones, 3 on most
  screens, 4 on very wide ones. Keep it a whole number, or the pixels blur.
- The lights in the mycelium are 12 frames stacked in one PNG. The CSS steps down it. If you
  change the frame count in `scene.mjs`, change `steps(12)` and the `-2400` in `landing.css` too.

## See it

```bash
python3 -m http.server --directory landing 8080   # then open http://localhost:8080
```

Check it at a phone width (about 390px) and a desktop width, in light and dark.

## Rules it keeps

- **No scripts, no cookies, no third-party requests.** The page says so in its footer, so keep it
  true. The moving lights in the network and the blinking menu arrow are CSS animations, and they stop under
  `prefers-reduced-motion`.
- **It passes the deploy CSP as it stands** (`deploy/Caddyfile`): one stylesheet from its own
  origin, images and fonts from its own origin, no `<style>` elements, no `style` attributes, no
  `data:` URLs.
- **A small fixed palette, taken from `DESIGN.md`.** Shading is done with dithering, never a
  smooth gradient, and the pictures are never smoothed when scaled.
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
