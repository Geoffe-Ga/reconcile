# The painting

One hand-painted forest, read from top to bottom: sky, canopy, intertwining branches, trunks, soil,
roots, and the mycelial network that joins them. The app uses it in two places
([ADR-0078](../docs/adr/0078-landing-page-and-painted-edges.md), [`DESIGN.md`](../DESIGN.md)):

- **Behind the landing page** (`client/src/screens/Landing.tsx`), whole, cut into a piece per
  section: `client/public/painting/wide/` for windows 1200px and up, `client/public/painting/tall/`
  for phones and narrow windows.
- **At the edges of some screens**, a few pixels wide: `client/public/edges/`, five small pieces
  cut from the tall painting.

`paint.py` makes all of it. Nothing in it is a photograph or a model's output.

## How it is made

1. **Compose.** It blocks in one tall picture in flat color: the underdrawing.
2. **Paint.** It covers a toned ground with strokes that follow the underdrawing, big brushes
   first, then finer ones only where the picture still differs from it. Each stroke is a bundle of
   bristles of slightly different color, so it streaks like gouache. Branches, twigs and roots are
   part of the underdrawing, so the brush paints them like everything else; none of them is a
   ruled line, and neither are the fungal threads. Only grass and ferns go on last with a fine
   brush. The sunbeams and the threads' glow are laid over the top as light.
3. **Cut.** It slices the tall picture into a piece per page section, and cuts the edge pieces.

```bash
python3 -m venv /tmp/paint && /tmp/paint/bin/pip install numpy opencv-python-headless
/tmp/paint/bin/python painting/paint.py     # both layouts, into client/public/: about ten minutes
/tmp/paint/bin/python painting/paint.py --scale 0.4 --out /tmp/look --edges /tmp/look/edges
```

numpy and OpenCV are needed only to repaint; they aren't in the repo's requirements, and the app
needs nothing. The random seed is fixed, so the same script paints the same picture.

## How the pieces fit the landing page

- Each section's `aspect-ratio` in `client/src/styles/landing.css` matches its piece's height in
  `paint.py` (`WIDE.heights`, `TALL.heights`), so the pieces meet edge to edge. Change one, change
  the other.
- The four near trees are at the same x in every piece (`trees` in each layout), so trunks run
  straight down into their roots.
- If a section's text needs more room than its piece gives, the section grows and the painting
  crops at the sides. A small seam can show there. Give the layout more height in `paint.py`
  rather than fighting it in CSS.
- Night doesn't repaint anything: `--tint` multiplies the same painting down to a cool, dim
  version.

## The edge pieces

`EDGES` in `paint.py` says which section each comes from and how far down it starts. Adding a
scene means adding it there, giving it a rule in `client/src/styles/app.css`, and listing the
screens that use it in `client/src/styles/scenes.test.ts`.
