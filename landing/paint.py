"""Paint the landing page's backgrounds with simulated brushstrokes.

Usage (needs numpy and opencv-python-headless, which the repo doesn't pin)::

    python landing/paint.py            # both layouts, full size, into landing/img/
    python landing/paint.py --scale 0.4 --out /tmp/preview   # a quick look

It works the way a background painter does, in two steps.

1. **Compose.** ``Scene`` blocks in one tall picture, top to bottom: sky,
   canopy, trunks and forest floor, soil and roots, then the deep earth and its
   mycelial network. This is flat, smooth color: the underdrawing.
2. **Paint.** ``Painter`` covers a toned ground with strokes that follow the
   underdrawing, big brushes first and finer ones only where the picture still
   differs from it (Hertzmann's "painterly rendering with curved brush
   strokes"). Each stroke is a bundle of bristles of slightly different color,
   so it streaks like gouache, and a height map of the bristles is lit from the
   upper right to give the paint some body.

The tall picture is then cut into one image per page section. The random
numbers come from a fixed seed, so the same script paints the same picture.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

Color = tuple[int, int, int]
Shades = tuple[Color, Color, Color, Color]

SECTIONS = ("sky", "canopy", "trunks", "soil", "deep")

# Leaf masses, as (shadow, body, light, highlight), from deep shade to full sun.
LEAF_DEEP: Shades = ((14, 40, 30), (24, 62, 44), (34, 84, 54), (52, 104, 62))
LEAF_MID: Shades = ((18, 50, 34), (36, 88, 54), (64, 122, 66), (110, 160, 84))
LEAF_LIT: Shades = ((30, 72, 42), (62, 124, 64), (118, 168, 84), (188, 206, 120))
LEAF_HAZE: Shades = ((70, 116, 96), (92, 140, 110), (120, 166, 124), (160, 192, 140))

BARK: Color = (72, 50, 40)
BARK_DARK: Color = (38, 26, 22)
BARK_LIT: Color = (146, 104, 74)
BARK_RIM: Color = (200, 158, 112)
ROOT: Color = (166, 124, 94)
ROOT_DARK: Color = (92, 62, 46)
ROOT_LIT: Color = (216, 178, 142)
THREAD: Color = (238, 222, 172)
THREAD_DIM: Color = (176, 152, 108)
GLOW: Color = (255, 190, 92)
RAY: Color = (255, 244, 196)
GROUND_TONE: Color = (150, 112, 82)  # the toned ground that shows between strokes


@dataclass(frozen=True)
class Layout:
    """One shape of the tall picture: how wide it is and where things go."""

    name: str
    width: int
    units: float  # how many scene units span the width; fewer means bigger trees
    heights: tuple[float, float, float, float, float]  # each section, times width
    trees: tuple[float, float, float, float]  # the four near trunks, as x fractions
    crowns: float  # how much of the sky section the treetops fill, times width
    floor: float  # depth of the forest floor and its cut edge, times width
    web: float  # how far down the deep section the network reaches (0 to 1)
    sun: tuple[float, float]  # x fraction, y times width
    clouds: tuple[tuple[float, float, float], ...]  # x fraction, y times width, size


WIDE = Layout(
    name="wide",
    width=1600,
    units=1600,
    heights=(0.8, 1.15, 0.92, 0.7, 1.15),
    trees=(0.09, 0.26, 0.74, 0.91),
    crowns=0.25,
    floor=0.2,
    web=0.42,
    sun=(0.82, 0.11),
    clouds=((0.66, 0.2, 150), (0.9, 0.27, 100), (0.6, 0.4, 60), (0.97, 0.42, 50)),
)
TALL = Layout(
    name="tall",
    width=720,
    units=900,
    heights=(2.3, 4.6, 2.9, 2.4, 3.4),
    trees=(0.07, 0.3, 0.7, 0.93),
    crowns=0.7,
    floor=0.5,
    web=0.3,
    sun=(0.78, 0.26),
    clouds=((0.7, 1.26, 120), (0.2, 1.4, 90), (0.9, 1.5, 70), (0.45, 1.16, 50)),
)


def bezier(p0: np.ndarray, ctrl: np.ndarray, p1: np.ndarray, n: int = 24) -> np.ndarray:
    """Return ``n`` points on the curve from ``p0`` to ``p1``, bent toward ``ctrl``."""
    t = np.linspace(0.0, 1.0, n)[:, None]
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * ctrl + t**2 * p1


def pt(p: np.ndarray | tuple[float, float]) -> tuple[int, int]:
    """Round a point to whole pixels, as OpenCV wants it."""
    return round(float(p[0])), round(float(p[1]))


@dataclass
class Detail:
    """A line the painter adds last with a fine brush: a twig, a root hair, a thread."""

    points: np.ndarray
    color: Color
    width: float


@dataclass
class Scene:
    """The underdrawing: flat color, plus what the painter needs to finish it."""

    lay: Layout
    scale: float
    rng: np.random.Generator
    ref: np.ndarray = field(init=False)
    details: list[Detail] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Size the picture and work out where each section starts."""
        self.w = round(self.lay.width * self.scale)
        self.u = self.w / self.lay.units
        tops = np.cumsum([0, *[round(h * self.w) for h in self.lay.heights]])
        self.tops = [int(t) for t in tops]
        self.h = self.tops[-1]
        self.ref = np.zeros((self.h, self.w, 3), np.uint8)
        self.rays = np.zeros((self.h, self.w), np.float32)
        self.glow = np.zeros((self.h, self.w), np.float32)
        self.angle = np.zeros((self.h, self.w), np.float32)
        self.tree_x = [f * self.w for f in self.lay.trees]

    # ----- small tools -----

    def r(self, lo: float, hi: float) -> float:
        """Return a random number between ``lo`` and ``hi``."""
        return float(self.rng.uniform(lo, hi))

    def noise(self, y0: int, y1: int, cell: float) -> np.ndarray:
        """Return smooth noise in [0, 1] for rows ``y0`` to ``y1``, ``cell`` px wide."""
        rows = max(2, round((y1 - y0) / cell) + 2)
        cols = max(2, round(self.w / cell) + 2)
        small = self.rng.random((rows, cols)).astype(np.float32)
        return cv2.resize(small, (self.w, y1 - y0), interpolation=cv2.INTER_CUBIC)

    def gradient(self, y0: int, y1: int, stops: list[tuple[float, Color]]) -> None:
        """Fill rows ``y0`` to ``y1`` with a top-to-bottom blend through ``stops``."""
        t = np.linspace(0.0, 1.0, max(y1 - y0, 1))
        at = [s[0] for s in stops]
        for ch in range(3):
            column = np.interp(t, at, [s[1][ch] for s in stops])
            self.ref[y0:y1, :, ch] = column[:, None].astype(np.uint8)

    def mottle(self, y0: int, y1: int, cell: float, amount: float) -> None:
        """Vary the lightness of rows ``y0`` to ``y1`` in soft patches."""
        shift = (self.noise(y0, y1, cell) - 0.5) * 2 * amount
        band = self.ref[y0:y1].astype(np.float32) + shift[:, :, None]
        self.ref[y0:y1] = np.clip(band, 0, 255).astype(np.uint8)

    def set_angle(self, y0: int, y1: int, base: float, wander: float) -> None:
        """Say which way strokes run in rows ``y0`` to ``y1`` on flat color."""
        cell = 160 * self.u
        self.angle[y0:y1] = base + (self.noise(y0, y1, cell) - 0.5) * 2 * wander

    def ellipse(self, c: tuple[float, float], rx: float, ry: float, col: Color) -> None:
        """Fill an ellipse centered on ``c``."""
        axes = (max(1, round(rx)), max(1, round(ry)))
        cv2.ellipse(self.ref, pt(c), axes, 0, 0, 360, col, -1, cv2.LINE_AA)

    def clump(self, x: float, y: float, rad: float, shades: Shades) -> None:
        """Paint one rounded mass of leaves, lit from the upper right."""
        squash = self.r(0.72, 0.95)
        self.ellipse((x, y + rad * 0.14), rad, rad * squash, shades[0])
        self.ellipse((x, y), rad * 0.9, rad * squash * 0.88, shades[1])
        self.ellipse((x + rad * 0.2, y - rad * 0.24), rad * 0.56, rad * 0.46, shades[2])
        self.ellipse((x + rad * 0.36, y - rad * 0.4), rad * 0.24, rad * 0.2, shades[3])

    def ridge(self, base: float, rise: float, col: Color, bottom: int) -> None:
        """Fill everything under a rolling, tree-lined horizon with ``col``."""
        xs = np.linspace(0, self.w, 160)
        phase = self.rng.uniform(0, 6.28, 3)
        wave = sum(
            math.pow(0.5, k) * np.sin(xs / self.w * 6.28 * (k + 1.3) + phase[k])
            for k in range(3)
        )
        bumps = self.rng.uniform(-0.18, 0.18, xs.size)
        ys = base - rise * (0.5 + 0.4 * wave + bumps)
        outline = [*zip(xs, ys, strict=True), (self.w, bottom), (0, bottom)]
        cv2.fillPoly(self.ref, [np.array(outline, np.int32)], col, cv2.LINE_AA)

    def limb(
        self,
        points: np.ndarray,
        w0: float,
        w1: float,
        body: Color,
        shade: Color,
        light: Color | None = None,
    ) -> None:
        """Draw a branch, trunk or root that tapers from ``w0`` wide to ``w1``."""
        n = len(points)
        widths = np.linspace(w0, w1, n)
        for off, col, part in (((-0.16, 0.2), shade, 1.0), ((0.0, 0.0), body, 0.82)):
            for i in range(n - 1):
                shift = np.array(off) * widths[i]
                thick = max(1, round(widths[i] * part))
                a, b = pt(points[i] + shift), pt(points[i + 1] + shift)
                cv2.line(self.ref, a, b, col, thick, cv2.LINE_AA)
        if light is not None:
            lift = np.stack([widths * 0.2, -widths * 0.26], axis=1)
            self.details.append(Detail(points + lift, light, max(1.2, w0 * 0.16)))

    def wander(
        self, start: np.ndarray, heading: float, length: float, turn: float
    ) -> np.ndarray:
        """Return a path that sets off along ``heading`` and drifts as it goes."""
        steps = max(4, round(length / (14 * self.u)))
        points = [np.asarray(start, float)]
        for _ in range(steps):
            heading += self.r(-turn, turn)
            step = np.array([math.cos(heading), math.sin(heading)]) * length / steps
            points.append(points[-1] + step)
        return np.array(points)

    # ----- the picture, top to bottom -----

    def build(self) -> Scene:
        """Compose every section and return the finished underdrawing."""
        self.sky()
        self.canopy()
        self.trunks()
        self.soil()
        self.deep()
        return self

    def sky(self) -> None:
        """Open sky, clouds, far hills, and the treetops rising into it."""
        y1 = self.tops[1]
        top = y1 - self.lay.crowns * self.w  # where the treetops begin
        self.gradient(
            0,
            y1,
            [(0.0, (120, 172, 210)), (0.6, (172, 208, 226)), (1.0, (240, 234, 206))],
        )
        self.set_angle(0, y1, -0.12, 0.3)
        sx, sy = self.lay.sun[0] * self.w, self.lay.sun[1] * self.w
        yy, xx = np.mgrid[0:y1, 0 : self.w].astype(np.float32)
        warmth = np.exp(
            -(((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * (190 * self.u) ** 2))
        )
        lit = self.ref[0:y1].astype(np.float32)
        lit += warmth[:, :, None] * (np.array([255, 244, 214]) - lit) * 0.75
        self.ref[0:y1] = np.clip(lit, 0, 255).astype(np.uint8)
        self.ellipse((sx, sy), 34 * self.u, 34 * self.u, (255, 250, 228))
        for fx, fy, size in self.lay.clouds:
            self.cloud(fx * self.w, fy * self.w, size * self.u)
        for i, col in enumerate(((158, 192, 198), (122, 166, 158), (88, 138, 116))):
            self.ridge(top - (150 - 62 * i) * self.u, 60 * self.u, col, y1)
        self.treetops(top, y1)

    def cloud(self, cx: float, cy: float, size: float) -> None:
        """Paint a cumulus: grey-blue underneath, cream body, bright in the sun."""
        puffs = []
        for i in range(7):
            t = i / 6
            arc = math.sin(math.pi * t)
            x = cx + (t - 0.5) * size * 2.4
            y = cy - arc * size * 0.42 + self.r(-0.06, 0.06) * size
            puffs.append((x, y, size * (0.26 + 0.36 * arc)))
        for x, y, rad in puffs:
            self.ellipse((x, y + rad * 0.3), rad * 1.06, rad * 0.78, (166, 188, 206))
        for x, y, rad in puffs:
            self.ellipse((x, y), rad, rad * 0.8, (238, 236, 226))
        for x, y, rad in puffs:
            lit = (x + rad * 0.14, y - rad * 0.2)
            self.ellipse(lit, rad * 0.7, rad * 0.52, (255, 251, 238))

    def treetops(self, top: float, bottom: int) -> None:
        """Crowns of separate trees against the sky, closing into solid canopy below."""
        u = self.u
        self.set_angle(int(top - 60 * u), bottom, 1.2, 1.5)
        for x in np.arange(0, self.w + 60 * u, 120 * u):
            spot = (x + self.r(-30, 30) * u, top + self.r(30, 70) * u)
            self.clump(spot[0], spot[1], self.r(44, 70) * u, LEAF_HAZE)
        solid = int(top + 150 * u)
        cv2.rectangle(self.ref, (0, solid), (self.w, bottom), LEAF_DEEP[1], -1)
        lumps = []
        between = np.arange(0.5 * self.w - 140 * u, self.w, 300 * u)
        for cx in [*self.tree_x, *between]:
            lumps += self.crown(cx + self.r(-30, 30) * u, top + self.r(-90, 70) * u)
        for _ in range(int((bottom - solid) * self.w / (u * u * 2200))):
            y = self.r(solid - 20 * u, bottom + 30 * u)
            shades = LEAF_MID if self.r(0, 1) < 0.22 else LEAF_DEEP
            lumps.append((y, self.r(0, self.w), self.r(26, 54) * u, shades))
        for y, x, rad, shades in sorted(lumps, key=lambda lump: lump[0]):
            self.clump(x, y, rad, shades)

    def crown(self, cx: float, top: float) -> list[tuple[float, float, float, Shades]]:
        """Return the leaf masses of one tree's crown: sunlit above, dark below."""
        u = self.u
        wide, tall = self.r(150, 200) * u, self.r(110, 150) * u
        lumps = []
        for _ in range(34):
            ang, dist = self.r(0, 6.28), math.sqrt(self.r(0, 1))
            dx, dy = math.cos(ang) * dist, math.sin(ang) * dist
            sun = dx * 0.5 - dy + self.r(-0.3, 0.3)
            shades = LEAF_LIT if sun > 0.45 else LEAF_MID if sun > -0.35 else LEAF_DEEP
            y = top + tall + dy * tall
            lumps.append((y, cx + dx * wide, self.r(30, 58) * u, shades))
        return lumps

    def canopy(self) -> None:
        """Inside the leaves: deep shade, sun flecks, and boughs crossing over."""
        y0, y1 = self.tops[1], self.tops[2]
        u = self.u
        self.set_angle(y0, y1, 1.2, 1.5)
        cv2.rectangle(self.ref, (0, y0), (self.w, y1), LEAF_DEEP[1], -1)
        light = self.noise(y0, y1, 240 * u)
        for _ in range(int((y1 - y0) * self.w / (u * u * 1500))):
            x, y = self.r(0, self.w), self.r(y0 - 20 * u, y1 + 20 * u)
            row = int(np.clip(y - y0, 0, y1 - y0 - 1))
            sun = light[row, int(np.clip(x, 0, self.w - 1))] + 0.25 * x / self.w
            sun += self.r(-0.15, 0.15)
            shades = LEAF_LIT if sun > 1.02 else LEAF_MID if sun > 0.74 else LEAF_DEEP
            self.clump(x, y, self.r(22, 52) * u, shades)
        self.boughs(y0, y1)
        for _ in range(int(14 * (y1 - y0) / self.w) + 6):  # gaps where the sky shows
            x = self.r(0.5, 1.0) * self.w
            y = self.r(y0 + 40 * u, y1 - 60 * u)
            for _ in range(4):
                spot = (x + self.r(-26, 26) * u, y + self.r(-20, 20) * u)
                self.ellipse(spot, self.r(4, 11) * u, self.r(3, 8) * u, (226, 238, 212))
        self.shafts(y0, y1, 0.16)

    def boughs(self, y0: int, y1: int) -> None:
        """Heavy limbs from the trees on either side, reaching over and interlacing."""
        u = self.u
        count = max(4, round(2.8 * (y1 - y0) / self.w))
        limbs = []
        for i in range(count):
            from_left = i % 2 == 0
            y = y0 + (i + 0.7) / (count + 0.6) * (y1 - y0) + self.r(-40, 40) * u
            start = np.array([-40 * u if from_left else self.w + 40 * u, y])
            sway = self.r(0.1, 0.45) if i == 0 else self.r(-0.45, 0.45)
            heading = sway if from_left else math.pi - sway
            path = self.wander(start, heading, self.r(0.72, 1.0) * self.w, 0.075)
            path[:, 1] += max(0.0, y0 + 50 * u - path[:, 1].min())  # stay under the sky
            limbs.append((path, self.r(44, 62) * u, 9 * u))
            limbs += self.forks(path, heading, y0 + 60 * u)
            for at in np.linspace(6, len(path) - 4, 5).astype(int):
                self.twig(path[at], self.up_or_down())
        for path, w0, w1 in sorted(limbs, key=lambda limb: limb[1]):
            self.limb(path, w0, w1, (98, 68, 50), (44, 30, 24), (190, 150, 108))

    def up_or_down(self) -> int:
        """Pick a side for a twig: more often up, toward the light."""
        return -1 if self.r(0, 1) < 0.6 else 1

    def forks(
        self, path: np.ndarray, heading: float, ceiling: float
    ) -> list[tuple[np.ndarray, float, float]]:
        """Return the lesser limbs that fork off a bough, each ending in twigs."""
        u = self.u
        limbs = []
        for at in self.rng.choice(len(path) - 8, size=3, replace=False) + 4:
            side = 1 if self.r(0, 1) < 0.5 else -1
            turn = heading + side * self.r(0.5, 0.95)
            fork = self.wander(path[at], turn, self.r(0.2, 0.34) * self.w, 0.1)
            if fork[:, 1].min() < ceiling:
                continue
            limbs.append((fork, self.r(18, 26) * u, 5 * u))
            self.twig(fork[-1], -1)
            self.twig(fork[len(fork) // 2], self.up_or_down())
        return limbs

    def twig(self, start: np.ndarray, up: int) -> None:
        """A side shoot off a bough, ending in a spray of sunlit leaves."""
        u = self.u
        end = start + np.array([self.r(-70, 70) * u, up * self.r(50, 120) * u])
        ctrl = (start + end) / 2 + np.array([self.r(-30, 30) * u, 0])
        path = bezier(start, ctrl, end, 10)
        self.limb(path, 7 * u, 2 * u, (88, 62, 46), (46, 32, 26))
        for _ in range(5):
            spot = end + np.array([self.r(-34, 34) * u, self.r(-26, 26) * u])
            self.clump(spot[0], spot[1], self.r(12, 24) * u, LEAF_LIT)

    def shafts(self, y0: int, y1: int, reach: float) -> None:
        """Mark slanting shafts of sunlight for the painter to glaze in at the end."""
        u = self.u
        layer = np.zeros((y1 - y0, self.w), np.float32)
        span = y1 - y0
        for _ in range(max(5, round(5 * self.w / (700 * u)))):
            x = self.r(0.25, 1.15) * self.w
            wide = self.r(20, 70) * u
            lean = span * 0.55
            quad = [
                (x, 0),
                (x + wide, 0),
                (x + wide * 1.8 - lean, span),
                (x - lean, span),
            ]
            cv2.fillPoly(layer, [np.array(quad, np.int32)], self.r(0.5, 1.0))
        layer = cv2.GaussianBlur(layer, (0, 0), 14 * u)
        t = np.linspace(0.0, 1.0, span)
        fade = np.clip(t / 0.22, 0, 1) * np.clip((1 - t) / 0.5, 0, 1)
        self.rays[y0:y1] = np.maximum(
            self.rays[y0:y1], layer * fade[:, None] * reach / 0.16
        )

    def trunks(self) -> None:
        """Under the canopy: trunks in bright mist, the forest floor, the cut ground."""
        y0, y1 = self.tops[2], self.tops[3]
        u = self.u
        floor_top = int(y1 - self.lay.floor * self.w)
        self.turf = int(y1 - self.lay.floor * self.w * 0.36)
        self.gradient(
            y0,
            floor_top,
            [
                (0.0, (30, 72, 50)),
                (0.14, (78, 128, 86)),
                (0.42, (204, 220, 174)),
                (0.66, (236, 236, 202)),
                (1.0, (188, 206, 158)),
            ],
        )
        self.set_angle(y0, floor_top, 1.57, 0.2)
        cv2.rectangle(
            self.ref, (0, floor_top), (self.w, self.turf), (188, 204, 148), -1
        )
        for col, lo, hi, n, drop in (
            ((196, 212, 180), 8, 14, 20, 0.0),
            ((160, 184, 152), 14, 24, 13, 0.25),
            ((112, 142, 112), 24, 38, 8, 0.55),
        ):
            for _ in range(round(n * self.w / (1600 * u))):
                x, wide = self.r(0, self.w), self.r(lo, hi) * u
                foot = floor_top + drop * (self.turf - floor_top)
                cv2.rectangle(self.ref, pt((x, y0)), pt((x + wide, foot)), col, -1)
            self.ground_band(floor_top, drop)
        self.shafts(y0, floor_top, 0.2)
        for x in self.tree_x:
            self.trunk(x, y0)
        self.underside(y0, y1)
        self.undergrowth()
        self.cut_ground(y1)

    def ground_band(self, floor_top: int, drop: float) -> None:
        """Lay one more step of forest floor toward the viewer, darker as it nears."""
        y = int(floor_top + drop * (self.turf - floor_top))
        near = np.array([92, 128, 62]) + (np.array([176, 196, 128]) - [92, 128, 62]) * (
            1 - drop
        )
        self.ridge(y + 14 * self.u, 22 * self.u, tuple(int(c) for c in near), self.turf)
        self.set_angle(y, self.turf, 0.0, 0.5)

    def trunk(self, x: float, y0: int) -> None:
        """One near tree: a trunk with bark, a lit side and a flared, mossy foot."""
        u = self.u
        wide = self.r(64, 84) * u
        left, right = x - wide / 2, x + wide / 2
        foot = self.turf + 6 * u
        flare = wide * 0.5
        shape = [
            (left, y0),
            (right, y0),
            (right, foot - 150 * u),
            (right + flare, foot),
            (left - flare, foot),
            (left, foot - 150 * u),
        ]
        cv2.fillPoly(self.ref, [np.array(shape, np.int32)], BARK, cv2.LINE_AA)
        cv2.rectangle(
            self.ref, pt((left, y0)), pt((left + wide * 0.2, foot)), BARK_DARK, -1
        )
        lit = pt((right - wide * 0.26, y0)), pt((right, foot - 40 * u))
        cv2.rectangle(self.ref, *lit, BARK_LIT, -1)
        rim = pt((right - wide * 0.06, y0)), pt((right, foot - 90 * u))
        cv2.rectangle(self.ref, *rim, BARK_RIM, -1)
        for _ in range(round((foot - y0) * wide / (u * u * 900))):
            bx, by = self.r(left, right), self.r(y0, foot - 30 * u)
            tone = self.rng.choice([BARK_DARK, BARK, BARK_LIT, (96, 70, 54)])
            a, b = pt((bx, by)), pt((bx + self.r(-4, 4) * u, by + self.r(40, 170) * u))
            cv2.line(self.ref, a, b, tuple(int(c) for c in tone), max(1, round(3 * u)))
        for _ in range(9):
            spot = (self.r(left - flare * 0.6, right), foot - self.r(6, 110) * u)
            self.ellipse(spot, self.r(10, 22) * u, self.r(12, 30) * u, (66, 96, 50))

    def underside(self, y0: int, y1: int) -> None:
        """The canopy's dark underside hanging into the top of the trunks."""
        u = self.u
        depth = min(0.14 * (y1 - y0), 240 * u)
        lumps = []
        for _ in range(int(self.w * depth / (u * u * 700))):
            y = y0 + abs(self.rng.normal(0, 0.42)) * depth
            shades = LEAF_DEEP if y < y0 + depth * 0.5 else LEAF_MID
            lumps.append((y, self.r(0, self.w), self.r(24, 52) * u, shades))
        for y, x, rad, shades in sorted(lumps, key=lambda lump: lump[0]):
            self.clump(x, y, rad, shades)
        for x in self.tree_x:
            side = 1 if x < self.w / 2 else -1
            start = np.array([x + side * 30 * u, y0 + depth + self.r(120, 260) * u])
            end = start + np.array([side * self.r(120, 200) * u, -self.r(110, 180) * u])
            path = bezier(start, start + np.array([side * 90 * u, -10 * u]), end, 12)
            self.limb(path, 16 * u, 4 * u, BARK, BARK_DARK, BARK_RIM)
            for _ in range(6):
                spot = end + np.array([self.r(-44, 44) * u, self.r(-30, 30) * u])
                self.clump(spot[0], spot[1], self.r(14, 28) * u, LEAF_LIT)

    def undergrowth(self) -> None:
        """Ferns, grass, mushrooms and a few flowers along the front of the floor."""
        u = self.u
        greens: list[Color] = [(52, 98, 48), (96, 144, 62), (150, 186, 90)]
        for x in np.arange(10 * u, self.w, 9 * u):
            base = np.array([x + self.r(-4, 4) * u, self.turf + self.r(-2, 6) * u])
            tip = base + np.array([self.r(-14, 14) * u, -self.r(14, 46) * u])
            blade = bezier(base, (base + tip) / 2 + [self.r(-6, 6) * u, 0], tip, 6)
            col = greens[int(self.rng.integers(0, 3))]
            self.details.append(Detail(blade, col, 2.6 * u))
        for x in np.arange(60 * u, self.w, 170 * u):
            base = np.array([x + self.r(-40, 40) * u, self.turf + 2 * u])
            for k in range(9):
                lean = (k - 4) / 4
                tip = base + np.array([lean * self.r(50, 80) * u, -self.r(30, 70) * u])
                ctrl = base + np.array([lean * 22 * u, -self.r(60, 90) * u])
                self.details.append(
                    Detail(bezier(base, ctrl, tip, 10), greens[k % 3], 4 * u)
                )
        for x in np.arange(120 * u, self.w, 260 * u):
            self.mushroom(x + self.r(-50, 50) * u, self.turf + 2 * u, self.r(0.8, 1.3))
        for _ in range(round(self.w / (90 * u))):
            spot = (self.r(0, self.w), self.turf - self.r(8, 34) * u)
            self.ellipse(spot, 4 * u, 4 * u, (226, 176, 70))

    def mushroom(self, x: float, y: float, size: float) -> None:
        """A red-capped mushroom with a pale stem and spots."""
        u = self.u * size
        self.ellipse((x, y - 9 * u), 4 * u, 11 * u, (236, 226, 204))
        self.ellipse((x, y - 21 * u), 15 * u, 9 * u, (150, 40, 32))
        self.ellipse((x + 2 * u, y - 23 * u), 12 * u, 6.5 * u, (196, 62, 44))
        for dx, dy in ((-6, -22), (4, -26), (8, -20)):
            self.ellipse((x + dx * u, y + dy * u), 2.2 * u, 1.8 * u, (246, 236, 214))

    def cut_ground(self, y1: int) -> None:
        """The ground in cross-section: turf, then topsoil, down to the next section."""
        u = self.u
        self.gradient(self.turf, y1, [(0.0, (120, 84, 58)), (1.0, (96, 66, 46))])
        self.mottle(self.turf, y1, 70 * u, 10)
        self.set_angle(self.turf, y1, 0.0, 0.5)
        lip = [(0, self.turf - 4 * u)]
        for x in np.arange(0, self.w + 40 * u, 40 * u):
            lip.append((x, self.turf + self.r(4, 16) * u))
        lip.append((self.w, self.turf - 4 * u))
        cv2.fillPoly(self.ref, [np.array(lip, np.int32)], (40, 66, 36), cv2.LINE_AA)

    def soil(self) -> None:
        """Earth, stones, and each tree's roots spreading and dividing."""
        y0, y1 = self.tops[3], self.tops[4]
        u = self.u
        self.gradient(
            y0, y1, [(0.0, (96, 66, 46)), (0.5, (72, 50, 36)), (1.0, (56, 39, 29))]
        )
        self.mottle(y0, y1, 150 * u, 9)
        self.mottle(y0, y1, 36 * u, 6)
        self.set_angle(y0, y1, 0.0, 0.7)
        for _ in range(round(14 * (y1 - y0) * self.w / (u * u * 900_000))):
            self.stone(self.r(0, self.w), self.r(y0, y1), self.r(12, 34) * u)
        tips = self.tops[4] + 0.06 * (self.tops[5] - self.tops[4])
        self.root_tips = []
        for x in self.tree_x:
            start = np.array([x, self.turf + 4 * u])
            self.root(start, 1.57, tips - start[1], 30 * u, 0)
            for side in (-1, 1):
                heading = 1.57 - side * self.r(0.75, 1.15)
                branch = start + np.array([side * 18 * u, 0])
                self.root(branch, heading, self.r(220, 340) * u, 20 * u, 1)

    def stone(self, x: float, y: float, rad: float) -> None:
        """A buried stone, lit on its upper right."""
        self.ellipse((x, y + rad * 0.14), rad, rad * 0.62, (48, 36, 28))
        self.ellipse((x, y), rad * 0.94, rad * 0.56, (98, 84, 72))
        self.ellipse(
            (x + rad * 0.2, y - rad * 0.14), rad * 0.5, rad * 0.24, (138, 122, 104)
        )

    def root(
        self, start: np.ndarray, heading: float, length: float, wide: float, depth: int
    ) -> None:
        """Grow a root from ``start``, sending out thinner roots as it goes."""
        u = self.u
        path = self.wander(start, heading, length, 0.045 if depth == 0 else 0.22)
        thin = max(wide * 0.3, 1.5 * u)
        if wide < 5 * u:
            self.details.append(Detail(path, ROOT if depth < 4 else ROOT_DARK, wide))
        else:
            self.limb(path, wide, thin, ROOT, ROOT_DARK, ROOT_LIT)
        if depth == 0:
            self.root_tips.append(path[-1])
        if depth >= 3 or wide < 2.4 * u:
            return
        for at in self.rng.choice(len(path) - 2, size=2 if depth else 5, replace=False):
            side = 1 if self.r(0, 1) < 0.5 else -1
            turn = heading + side * self.r(0.5, 1.0)
            turn = float(np.clip(turn, 0.25, 2.9))  # roots head down, never up
            reach = min(length * self.r(0.3, 0.5), 300 * u)
            self.root(path[at + 1], turn, reach, wide * 0.5, depth + 1)

    def deep(self) -> None:
        """The deepest earth, the last root tips, and the network that joins them."""
        y0, y1 = self.tops[4], self.tops[5]
        u = self.u
        self.gradient(
            y0, y1, [(0.0, (56, 39, 29)), (0.5, (36, 26, 20)), (1.0, (22, 16, 13))]
        )
        self.mottle(y0, y1, 170 * u, 6)
        self.set_angle(y0, y1, 0.0, 0.9)
        band = (y0 + 0.07 * (y1 - y0), y0 + self.lay.web * (y1 - y0))
        for _ in range(round(8 * self.w / (1600 * u))):
            self.stone(self.r(0, self.w), self.r(band[0], band[1]), self.r(12, 28) * u)
        nodes = self.web_nodes(band)
        for a, b in self.web_edges(nodes):
            mid = (nodes[a] + nodes[b]) / 2
            bend = (nodes[b] - nodes[a])[::-1] * [-1, 1] * self.r(-0.34, 0.34)
            path = bezier(nodes[a], mid + bend, nodes[b], 14)
            self.thread(path, THREAD, 1.4 * u, 0.5)
        for _ in range(len(nodes) * 2):
            start = nodes[int(self.rng.integers(0, len(nodes)))]
            path = self.wander(start, self.r(0, 6.28), self.r(30, 100) * u, 0.5)
            self.thread(path, THREAD_DIM, 1.1 * u, 0.16)
        for i, node in enumerate(nodes):
            rad = (5 if i % 4 == 0 else 2.6) * u
            cv2.circle(
                self.glow, pt(node), max(1, round(rad * 1.8)), 1.0, -1, cv2.LINE_AA
            )
            dot = np.array([node, node + np.array([0.6, 0.0])])
            self.details.append(Detail(dot, (255, 240, 190), rad))
        self.glow = cv2.GaussianBlur(self.glow, (0, 0), 9 * u)

    def thread(self, path: np.ndarray, col: Color, wide: float, shine: float) -> None:
        """Lay one fungal thread, and let it give off a little light."""
        self.details.append(Detail(path, col, wide))
        line = [np.round(path).astype(np.int32)]
        cv2.polylines(
            self.glow, line, False, shine, max(1, round(wide * 2)), cv2.LINE_AA
        )

    def web_nodes(self, band: tuple[float, float]) -> list[np.ndarray]:
        """Scatter the network's meeting points below the root tips, kept apart."""
        u = self.u
        nodes = []
        for tip in self.root_tips:
            for dx in (-110, -40, 36, 104):
                end = tip + np.array(
                    [dx * u + self.r(-14, 14) * u, self.r(70, 150) * u]
                )
                ctrl = tip + np.array([dx * 0.4 * u, 60 * u])
                self.details.append(Detail(bezier(tip, ctrl, end, 10), ROOT, 3.4 * u))
                nodes.append(end)
        top = band[0] + 0.18 * (band[1] - band[0])
        target = len(nodes) + round(70 * self.w * (band[1] - top) / (u * u * 640_000))
        for _ in range(6000):
            if len(nodes) >= target:
                break
            cand = np.array([self.r(0, self.w), self.r(top, band[1])])
            if all(np.hypot(*(cand - n)) > 54 * u for n in nodes):
                nodes.append(cand)
        return nodes

    def web_edges(self, nodes: list[np.ndarray]) -> set[tuple[int, int]]:
        """Join every meeting point to its three nearest neighbors."""
        edges = set()
        for i, node in enumerate(nodes):
            gaps = [float(np.hypot(*(node - other))) for other in nodes]
            for j in np.argsort(gaps)[1:4]:
                edges.add((min(i, int(j)), max(i, int(j))))
        return edges


@dataclass
class Painter:
    """Turns an underdrawing into a painting, one brushstroke at a time."""

    scene: Scene
    rng: np.random.Generator
    canvas: np.ndarray = field(init=False)
    height: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        """Lay the toned ground the strokes go on."""
        ref = self.scene.ref
        tone = np.array(GROUND_TONE, np.float32)
        grain = self.rng.normal(0, 5, ref.shape[:2]).astype(np.float32)
        self.canvas = np.clip(tone + grain[:, :, None], 0, 255).astype(np.uint8)
        self.height = np.zeros(ref.shape[:2], np.float32)

    def paint(self) -> np.ndarray:
        """Paint every layer, coarse to fine, then finish and return the picture."""
        u = self.scene.u
        layers = ((30, 10, 3, 0), (15, 8, 2, 30), (7.5, 6, 2, 26), (3.6, 5, 1, 24))
        for radius, longest, shortest, tolerance in layers:
            self.layer(max(radius * u, 1.5), longest, shortest, tolerance)
        for detail in self.scene.details:
            color = np.array(detail.color, np.float32)
            self.stroke(detail.points, color, max(detail.width / 2, 0.8), 3)
        return self.finish()

    def layer(self, radius: float, longest: int, shortest: int, tolerance: int) -> None:
        """Paint one layer with a brush ``radius`` px across its half-width."""
        ref = self.scene.ref
        soft = cv2.GaussianBlur(ref, (0, 0), radius * 0.55).astype(np.float32)
        flow = self.flow(soft, radius)
        gap = max(radius * 0.9, 2.0)
        ys = np.arange(gap / 2, ref.shape[0], gap)
        xs = np.arange(gap / 2, ref.shape[1], gap)
        grid = np.stack(np.meshgrid(xs, ys), axis=-1).reshape(-1, 2)
        grid += self.rng.uniform(-gap / 2, gap / 2, grid.shape)
        grid[:, 0] = np.clip(grid[:, 0], 0, ref.shape[1] - 1)
        grid[:, 1] = np.clip(grid[:, 1], 0, ref.shape[0] - 1)
        if tolerance:
            miss = np.abs(self.canvas.astype(np.float32) - soft).sum(axis=2)
            size = max(3, round(radius))
            miss = cv2.blur(miss, (size, size))
            keep = miss[grid[:, 1].astype(int), grid[:, 0].astype(int)] > tolerance
            grid = grid[keep]
        self.rng.shuffle(grid)
        before = self.canvas.astype(np.float32)
        for x, y in grid:
            path, color = self.trace(
                x, y, soft, before, flow, radius, longest, shortest
            )
            self.stroke(path, color + self.rng.normal(0, 4, 3), radius, 5)

    def flow(self, soft: np.ndarray, radius: float) -> np.ndarray:
        """Return the direction strokes should run at each pixel, as unit vectors.

        Strokes run along edges (across the color gradient), as a painter draws
        along a form. Where the picture is flat, they follow the scene's hint.
        """
        gray = cv2.cvtColor(soft, cv2.COLOR_RGB2GRAY)
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        strength = np.sqrt(gx**2 + gy**2)
        hint = np.stack([np.cos(self.scene.angle), np.sin(self.scene.angle)], axis=-1)
        along = np.stack([-gy, gx], axis=-1) / (strength[:, :, None] + 1e-3)
        agree = (along * hint).sum(axis=2) < 0
        along[agree] *= -1
        weight = np.clip(strength / 10.0, 0, 1)[:, :, None]
        flow = cv2.GaussianBlur(
            weight * along + (1 - weight) * hint, (0, 0), radius * 0.5
        )
        return flow / (np.linalg.norm(flow, axis=2, keepdims=True) + 1e-6)

    def trace(
        self,
        x: float,
        y: float,
        soft: np.ndarray,
        before: np.ndarray,
        flow: np.ndarray,
        radius: float,
        longest: int,
        shortest: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Follow the flow from (x, y) for as long as one color still fits."""
        rows, cols = soft.shape[:2]
        color = soft[int(y), int(x)].copy()
        path = [(x, y)]
        last = np.zeros(2, np.float32)
        flip = -1.0 if self.rng.random() < 0.5 else 1.0
        for step in range(longest):
            way = flow[int(y), int(x)] * flip
            if last @ way < 0:
                way = -way
            way = 0.7 * way + 0.3 * last
            way /= np.linalg.norm(way) + 1e-6
            x, y = x + way[0] * radius, y + way[1] * radius
            if not (0 <= x < cols and 0 <= y < rows):
                break
            here = soft[int(y), int(x)]
            fits = (
                np.abs(here - color).sum() < np.abs(here - before[int(y), int(x)]).sum()
            )
            if step >= shortest and not fits:
                break
            path.append((x, y))
            last, flip = way, 1.0
        return np.array(path, np.float32), color

    def stroke(
        self, path: np.ndarray, color: np.ndarray, radius: float, vary: float
    ) -> None:
        """Lay one stroke: a bundle of bristles, each a slightly different color."""
        if len(path) < 2:
            path = np.vstack([path, path + np.array([radius * 0.6, 0.0])])
        along = np.gradient(path, axis=0)
        along /= np.linalg.norm(along, axis=1, keepdims=True) + 1e-6
        across = np.stack([-along[:, 1], along[:, 0]], axis=1)
        bristles = int(np.clip(radius * 0.8, 2, 14))
        thick = max(1, round(2 * radius / bristles * 1.5))
        for offset in np.linspace(-0.9, 0.9, bristles) * radius:
            line = path + across * (offset + self.rng.normal(0, radius * 0.06))
            if len(line) > 3 and self.rng.random() < 0.5:  # a bristle that ran dry
                line = line[
                    self.rng.integers(0, 2) : len(line) - self.rng.integers(0, 2)
                ]
            shade = np.clip(color + self.rng.normal(0, vary), 0, 255)
            pts = [np.round(line * 8).astype(np.int32)]
            ink = tuple(float(c) for c in shade)
            cv2.polylines(self.canvas, pts, False, ink, thick, cv2.LINE_AA, 3)
            lift = float(self.rng.random())
            cv2.polylines(self.height, pts, False, lift, thick, cv2.LINE_AA, 3)

    def finish(self) -> np.ndarray:
        """Give the paint body, glaze in the light, and return the finished picture."""
        relief = cv2.GaussianBlur(self.height, (0, 0), 0.7)
        gx = cv2.Sobel(relief, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(relief, cv2.CV_32F, 0, 1, ksize=3)
        body = np.clip(1 + 0.06 * (gy - gx) * 0.7, 0.88, 1.12)  # lit from upper right
        tooth = 1 + self.rng.normal(0, 0.012, relief.shape).astype(np.float32)
        out = self.canvas.astype(np.float32) * (body * tooth)[:, :, None]
        for light, tint, amount in (
            (self.scene.rays, RAY, 0.5),
            (self.scene.glow, GLOW, 0.55),
        ):
            cover = np.clip(light * amount, 0, 1)[:, :, None]
            out += cover * (np.array(tint, np.float32) - out) * 0.9
        return np.clip(out, 0, 255).astype(np.uint8)


def render(lay: Layout, scale: float, out: Path, quality: int) -> None:
    """Paint one layout and save it, cut into an image per page section."""
    scene = Scene(lay, scale, np.random.default_rng(1937)).build()
    picture = Painter(scene, np.random.default_rng(1997)).paint()
    folder = out / lay.name
    folder.mkdir(parents=True, exist_ok=True)
    bgr = cv2.cvtColor(picture, cv2.COLOR_RGB2BGR)
    for name, top, bottom in zip(
        SECTIONS, scene.tops[:-1], scene.tops[1:], strict=True
    ):
        path = folder / f"{name}.webp"
        cv2.imwrite(str(path), bgr[top:bottom], [cv2.IMWRITE_WEBP_QUALITY, quality])


def main() -> None:
    """Paint the layouts asked for on the command line."""
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--scale", type=float, default=1.0, help="size, for a quick look"
    )
    parser.add_argument("--out", type=Path, default=here / "img", help="where to save")
    parser.add_argument(
        "--quality", type=int, default=74, help="WebP quality, 1 to 100"
    )
    parser.add_argument("--only", choices=("wide", "tall"), help="paint one layout")
    args = parser.parse_args()
    for lay in (WIDE, TALL):
        if args.only in (None, lay.name):
            render(lay, args.scale, args.out, args.quality)


if __name__ == "__main__":
    main()
