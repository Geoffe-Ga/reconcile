# Landing page

One static page that says what Reconcile is, for phones and desktops alike. It is a single scene
read from top to bottom: sky, canopy, intertwining branches, trunks, soil, roots, and the mycelial
network that joins them. Each layer carries the part of the product it stands for.

| Layer | What it says |
|-------|--------------|
| Sky and canopy | Every group is its own tree, with its own living Documents |
| Branches | Propose → Discuss → Vote → Update |
| Trunks | The consent floor ([ADR-0002](../docs/adr/0002-consent-floor-vote-rule.md)) and the three levels ([ADR-0021](../docs/adr/0021-level-names-and-self-selection.md)) |
| Soil and roots | Local-first, and no list of everyone ([ADR-0001](../docs/adr/0001-local-first-trust-model.md)) |
| Mycelium | Coalitions, formed by private invitation ([ADR-0074](../docs/adr/0074-mvp-scope-revised.md)) |

## Files

- `index.html`: the copy and structure. Edit the words here.
- `landing.css`: every color, size and animation. The tokens at the top mirror
  [`DESIGN.md`](../DESIGN.md); the scene colors under them (sky, leaves, bark, soil, threads) are
  for the illustration only.
- `scene.mjs`: draws the illustration. `node landing/scene.mjs` rewrites the SVG between the
  `<!-- scene:NAME -->` markers in `index.html` and nothing else. Change the trees or the network
  there, never by hand in the SVG.
- `fonts/`: self-hosted Newsreader and Public Sans (see `fonts/README.md`).

## See it

```bash
python3 -m http.server --directory landing 8080   # then open http://localhost:8080
```

Check it at a phone width (about 390px) and a desktop width, in light and dark.

## Rules it keeps

- **No scripts, no cookies, no third-party requests.** The page says so in its footer, so keep it
  true. The moving lights in the network are a CSS animation, and they stop under
  `prefers-reduced-motion`.
- **It passes the deploy CSP as it stands** (`deploy/Caddyfile`): one stylesheet from its own
  origin, no `<style>` elements, no `style` attributes, no `data:` URLs.
- **Flat color, no gradients**, as `DESIGN.md` asks. The illustration is cut-paper shapes.
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
