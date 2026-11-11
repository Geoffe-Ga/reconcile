// Draws the landing page's pixel art.
//
// Usage: node landing/scene.mjs
//
// Writes indexed-color PNGs to landing/img/day and landing/img/night. Every
// picture is drawn once, as palette indexes, and saved twice: night is a
// palette swap of day, the way a 16-bit game does it. The art is 320 pixels
// wide and tiles sideways; landing.css scales it up by whole numbers and never
// smooths it. The random numbers come from a fixed seed, so a run with no
// changes here rewrites the same files. No dependencies: the PNG encoder below
// is all it needs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

// ---------- Palette ----------

// Order is the palette index. `none` is transparent. `star` and `sunmark` only
// show at night: by day they take the color of what's behind them.
const PALETTE = {
  //            day        night
  none: ['#000000', '#000000'],
  sky1: ['#b3d4e3', '#16232d'],
  sky2: ['#c6dfe8', '#1d2e36'],
  sky3: ['#dcebeb', '#263b44'],
  cloud: ['#f6f9f6', '#3a525c'],
  cloudsh: ['#d3e3e8', '#2c434c'],
  far1: ['#b4cfc6', '#22363a'],
  far2: ['#8fb09a', '#27433a'],
  g1: ['#86a886', '#4f7457'],
  g2: ['#4f7746', '#2f4d38'],
  g3: ['#2f6b45', '#223d2c'],
  g4: ['#1f4a33', '#172c20'],
  g5: ['#163626', '#0f2016'],
  b1: ['#8a5a44', '#5a4034'],
  b2: ['#5b3d30', '#3b2a22'],
  b3: ['#3d281f', '#261a15'],
  branch: ['#b58f6e', '#8d6f58'],
  branchd: ['#7d5f48', '#5c4638'],
  mist: ['#f6f1e7', '#15140f'],
  mist2: ['#e9e3d2', '#1e1d17'],
  mist3: ['#dcd5c1', '#26241d'],
  soil1: ['#6a4a37', '#33241b'],
  soil2: ['#493327', '#281c15'],
  soil3: ['#35251c', '#1e1510'],
  soil4: ['#221812', '#140e0a'],
  stone: ['#7d6250', '#3a2a20'],
  stoned: ['#5d4636', '#2a1e17'],
  root: ['#c79a7c', '#a57f66'],
  rootd: ['#9a7058', '#7a5c49'],
  hypha: ['#ead9ae', '#d9c99e'],
  hyphad: ['#a8946c', '#8f7d5c'],
  spore: ['#d9a54a', '#d9a54a'],
  glow: ['#fff0c0', '#fff0c0'],
  sun: ['#f4e6c1', '#ece3cb'],
  sunhi: ['#fff6dc', '#fffdf0'],
  sunmark: ['#f4e6c1', '#d2c8ac'],
  star: ['#000000', '#e8e4d0'],
  cap: ['#b3362a', '#a04a3e'],
  capspot: ['#f6f1e7', '#d6d0c2'],
  flower: ['#d9a54a', '#b58a3e'],
};
const KEYS = Object.keys(PALETTE);
const INDEX = Object.fromEntries(KEYS.map((k, i) => [k, i]));
const TRANSPARENT = { day: ['none', 'star'], night: ['none'] };

// ---------- Tools ----------

let seed = 16;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const r = (a, b) => a + rnd() * (b - a);
const ri = (a, b) => Math.floor(r(a, b + 1));
const mod = (n, m) => ((n % m) + m) % m;
/** A fixed pseudo-random value in [0, 1) for a pixel: texture that tiles and never changes. */
const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Ordered dithering: true for a share `p` of pixels, in the classic 4×4 pattern. */
const dither = (x, y, p) => (BAYER[mod(y, 4) * 4 + mod(x, 4)] + 0.5) / 16 < p;

const W = 320;
// The four trees: x and trunk width, in art pixels. Every strip puts them here.
const TREES = [
  { x: 40, w: 12 },
  { x: 104, w: 16 },
  { x: 216, w: 14 },
  { x: 280, w: 10 },
];
// Faint trunks further back in the wood.
const FAR_TRUNKS = [
  [14, 5],
  [66, 4],
  [148, 6],
  [182, 4],
  [250, 5],
  [304, 4],
];

/** A picture as palette indexes. x always wraps, so everything tiles sideways. */
class Art {
  constructor(w, h, fill = 'none', wrapY = false) {
    this.w = w;
    this.h = h;
    this.wrapY = wrapY;
    this.px = new Uint8Array(w * h).fill(INDEX[fill]);
  }
  set(x, y, key) {
    x = mod(Math.round(x), this.w);
    y = Math.round(y);
    if (this.wrapY) y = mod(y, this.h);
    if (y < 0 || y >= this.h) return;
    this.px[y * this.w + x] = INDEX[key];
  }
  get(x, y) {
    return KEYS[this.px[mod(y, this.h) * this.w + mod(x, this.w)]];
  }
  rect(x, y, w, h, key) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.set(x + i, y + j, key);
  }
  disc(cx, cy, rad, key) {
    const lim = rad * rad + rad * 0.8;
    for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy += 1) {
      for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx += 1) {
        if (dx * dx + dy * dy <= lim) this.set(cx + dx, cy + dy, key);
      }
    }
  }
  line(x0, y0, x1, y1, key, thick = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i += 1) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      for (let t = 0; t < thick; t += 1) this.set(x + t, y, key);
    }
  }
  /** Points along a curve from a to b, bent toward c. */
  static curve(a, c, b, steps = 24) {
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
    return pts;
  }
  path(pts, key, thick = 1) {
    for (let i = 1; i < pts.length; i += 1) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], key, thick);
  }
  copy() {
    const a = new Art(this.w, this.h);
    a.px.set(this.px);
    return a;
  }
}

/** One rounded mass of leaves, lit from the upper right. */
function clump(art, cx, cy, rad, shades = ['g4', 'g3', 'g2', 'g1']) {
  art.disc(cx, cy + 1, rad, shades[0]);
  art.disc(cx, cy, rad - 1, shades[1]);
  art.disc(cx + rad * 0.22, cy - rad * 0.28, rad * 0.58, shades[2]);
  if (rad >= 5) art.disc(cx + rad * 0.38, cy - rad * 0.45, rad * 0.26, shades[3]);
}

/** Trunks with bark, from row y0 to y1. */
function trunks(art, y0, y1) {
  for (const t of TREES) {
    const left = t.x - Math.floor(t.w / 2);
    for (let y = y0; y < y1; y += 1) {
      for (let i = 0; i < t.w; i += 1) {
        let key = i < 2 ? 'b3' : i >= t.w - 2 ? 'b1' : 'b2';
        if (key === 'b2') {
          const h = hash(left + i, Math.floor(y / 3));
          if (h < 0.07) key = 'b3';
          else if (h > 0.95) key = 'b1';
        }
        art.set(left + i, y, key);
      }
    }
  }
}

function farTrunks(art, y0, y1) {
  for (const [x, w] of FAR_TRUNKS) art.rect(x, y0, w, y1 - y0, 'mist2');
}

/** Soil of one color with the odd fleck and pebble. */
function soilAt(x, y, base) {
  const h = hash(mod(x, W), mod(y, 64));
  if (base === 'soil4') return h < 0.012 ? 'soil3' : h > 0.997 ? 'stoned' : base;
  if (h < 0.012) return 'stoned';
  if (h > 0.992) return 'stone';
  return base;
}

function taproots(art, y0, y1) {
  for (const t of TREES) {
    for (let y = y0; y < y1; y += 1) {
      art.set(t.x - 1, y, 'rootd');
      art.set(t.x, y, 'root');
    }
  }
}

// ---------- The pictures ----------

/** 64×64, tiles both ways: the inside of the canopy. */
function leaves() {
  const a = new Art(64, 64, 'g4', true);
  for (let i = 0; i < 54; i += 1) {
    const cx = ri(0, 63);
    const cy = ri(0, 63);
    const rad = ri(3, 6);
    a.disc(cx, cy + 2, rad, 'g5');
    a.disc(cx, cy, rad - 1, 'g4');
    a.disc(cx + 1, cy - 1, rad * 0.62, 'g3');
    if (rnd() < 0.55) a.disc(cx + rad * 0.4, cy - rad * 0.45, 1, 'g2');
  }
  return a;
}

/** Sky, clouds, far hills and the treetops, ending in solid canopy. */
function horizon(leaf) {
  const H = 160;
  const a = new Art(W, H, 'sky1');
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (y < 34) a.set(x, y, dither(x, y, (y - 6) / 28) ? 'sky2' : 'sky1');
      else a.set(x, y, dither(x, y, (y - 40) / 30) ? 'sky3' : 'sky2');
    }
  }
  // clouds: flat-bottomed, lumpy on top
  for (const [cx, cy, len] of [
    [58, 30, 34],
    [176, 18, 26],
    [252, 44, 40],
    [120, 54, 22],
  ]) {
    for (let i = 0; i < len; i += 5) {
      const bump = 3 + 3 * Math.sin((i / len) * Math.PI) + r(0, 2);
      a.disc(cx + i, cy, bump, 'cloud');
    }
    a.rect(cx - 6, cy + 1, len + 10, 8, 'sky2');
    for (let x = cx - 4; x < cx + len + 3; x += 1) {
      a.set(x, cy, 'cloudsh');
      if (dither(x, cy, 0.5)) a.set(x, cy - 1, 'cloudsh');
    }
  }
  // restore the dithered sky under the clouds' flat bottoms
  for (let y = 0; y < 70; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (a.get(x, y) !== 'sky2' || y < 6) continue;
      if (y < 34) a.set(x, y, dither(x, y, (y - 6) / 28) ? 'sky2' : 'sky1');
      else a.set(x, y, dither(x, y, (y - 40) / 30) ? 'sky3' : 'sky2');
    }
  }
  // two far treelines
  for (let x = 0; x < W; x += 1) {
    const t = (x / W) * Math.PI * 2;
    const y1 = 70 + 4 * Math.sin(t * 2 + 1) + 2 * Math.sin(t * 7) + (hash(x, 1) < 0.3 ? -1 : 0);
    for (let y = Math.round(y1); y < H; y += 1) a.set(x, y, 'far1');
    const y2 = 82 + 5 * Math.sin(t * 3 + 2.4) + 2 * Math.sin(t * 9 + 1) + (hash(x, 2) < 0.4 ? -1 : 0);
    for (let y = Math.round(y2); y < H; y += 1) a.set(x, y, 'far2');
  }
  for (let x = 2; x < W; x += ri(5, 9)) a.disc(x, 84 + 5 * Math.sin((x / W) * Math.PI * 6 + 2.4), ri(2, 4), 'far2');
  // solid canopy below, in step with the leaf tile that follows this strip
  for (let y = 118; y < H; y += 1) for (let x = 0; x < W; x += 1) a.set(x, y, leaf.get(x, y - H));
  // a back row of crowns, darker
  const back = [];
  for (let x = 0; x < W; x += ri(12, 18)) back.push([x, ri(104, 114), ri(9, 14)]);
  for (const [x, y, rad] of back) clump(a, x, y, rad, ['g5', 'g4', 'g3', 'g3']);
  // the four trees' crowns
  const lumps = [];
  for (const t of TREES) {
    const top = ri(82, 92);
    const wide = ri(26, 32);
    for (let i = 0; i < 16; i += 1) {
      const ang = r(0, Math.PI * 2);
      const d = Math.sqrt(rnd());
      lumps.push([t.x + Math.cos(ang) * d * wide, top + 18 + Math.sin(ang) * d * 16, ri(7, 12)]);
    }
    lumps.push([t.x, top + 6, 11], [t.x - 8, top + 12, 10], [t.x + 9, top + 11, 10]);
  }
  for (let x = 6; x < W; x += ri(10, 15)) lumps.push([x, ri(116, 124), ri(7, 10)]);
  lumps.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rad] of lumps) if (y + rad < 127) clump(a, x, y, rad);
  // birds
  for (const [x, y] of [
    [206, 34],
    [220, 42],
    [196, 46],
  ]) {
    for (const [dx, dy] of [
      [-2, 0],
      [-1, -1],
      [0, 0],
      [1, -1],
      [2, 0],
    ]) {
      a.set(x + dx, y + dy, 'b3');
    }
  }
  return a;
}

/** Boughs from neighbouring trees, weaving over and under each other. See-through. */
function branches() {
  const H = 128;
  const a = new Art(W, H);
  const boughs = [
    { y: 30, amp: 12, n: 2, ph: 0.4, thick: 4 },
    { y: 44, amp: 14, n: 3, ph: 2.6, thick: 3 },
    { y: 66, amp: 13, n: 2, ph: 3.5, thick: 4 },
    { y: 78, amp: 12, n: 3, ph: 5.3, thick: 3 },
    { y: 98, amp: 11, n: 2, ph: 1.9, thick: 3 },
    { y: 60, amp: 30, n: 1, ph: 4.4, thick: 2 },
  ];
  const yAt = (b, x) => b.y + b.amp * Math.sin((x / W) * Math.PI * 2 * b.n + b.ph);
  const draw = (b, x0, x1) => {
    for (let x = x0; x < x1; x += 1) {
      const y = Math.round(yAt(b, x));
      a.set(x, y - 1, 'g5');
      a.set(x, y + b.thick, 'g5');
      for (let t = 0; t < b.thick; t += 1) a.set(x, y + t, t === 0 ? 'branch' : 'branchd');
      if (hash(x, b.y) < 0.12) a.set(x, y + 1, 'b3');
    }
  };
  // twigs and leaves first, so the boughs pass in front
  for (const b of boughs) {
    for (let x = ri(0, 10); x < W; x += ri(9, 17)) {
      const up = rnd() < 0.5 ? -1 : 1;
      const y = yAt(b, x) + (up > 0 ? b.thick : 0);
      const len = ri(5, 10);
      const lean = ri(-4, 4);
      a.line(x, y, x + lean, y + up * len, 'branchd');
      const tip = [x + lean, y + up * len];
      const shade = rnd() < 0.18 ? ['flower', 'glow'] : rnd() < 0.5 ? ['g2', 'g1'] : ['g3', 'g2'];
      for (const [dx, dy] of [
        [0, 0],
        [ri(-4, -2), ri(-2, 2)],
        [ri(2, 4), ri(-2, 2)],
      ]) {
        const lx = tip[0] + dx;
        const ly = tip[1] + dy;
        a.rect(lx - 1, ly, 3, 1, shade[0]);
        a.rect(lx, ly - 1, 1, 3, shade[0]);
        a.set(lx + 1, ly - 1, shade[1]);
      }
    }
  }
  for (const b of boughs) draw(b, 0, W);
  // weave: bring every other stretch of the earlier boughs back to the front
  boughs.slice(0, 4).forEach((b, i) => {
    for (let x = i * 22; x < W; x += 88) draw(b, x, Math.min(x + 44, W));
  });
  return a;
}

/** The canopy's ragged underside, with the trunks coming down out of it. See-through on top. */
function underside() {
  const H = 96;
  const a = new Art(W, H);
  a.rect(0, 10, W, H - 10, 'mist');
  farTrunks(a, 10, H);
  trunks(a, 10, H);
  // a low bough on each tree
  for (const t of TREES) {
    const s = t.x < 160 ? 1 : -1;
    const from = [t.x + (s * t.w) / 2, ri(64, 76)];
    const pts = Art.curve(from, [from[0] + s * 12, from[1] - 4], [from[0] + s * ri(20, 28), from[1] - ri(22, 30)]);
    a.path(pts, 'b3', 3);
    a.path(pts, 'b2', 2);
    const end = pts[pts.length - 1];
    clump(a, end[0], end[1] - 2, 5);
    clump(a, end[0] + s * 5, end[1] + 2, 4);
  }
  a.rect(0, 10, W, 8, 'g4');
  const lumps = [];
  for (let x = 0; x < W; x += ri(7, 11)) lumps.push([x, ri(12, 26), ri(8, 12)]);
  for (let x = 4; x < W; x += ri(16, 26)) lumps.push([x, ri(28, 36), ri(5, 8)]);
  lumps.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rad] of lumps) clump(a, x, y, rad);
  // fade the very top into the leaf tile behind
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < W; x += 1) if (a.get(x, y) !== 'none' && y < 4) a.set(x, y, 'none');
  return a;
}

/** 320×64, tiles downward: trunks standing in the open air under the canopy. */
function trunkTile() {
  const a = new Art(W, 64, 'mist', true);
  farTrunks(a, 0, 64);
  trunks(a, 0, 64);
  return a;
}

/** The forest floor, the ground line, topsoil and the first roots. */
function ground() {
  const H = 128;
  const G = 64;
  const a = new Art(W, H, 'mist');
  farTrunks(a, 0, 54);
  // far undergrowth
  for (let x = 0; x < W; x += 1) {
    const y = 50 + 3 * Math.sin((x / W) * Math.PI * 8) + (hash(x, 5) < 0.4 ? -1 : 0);
    for (let j = Math.round(y); j < G; j += 1) a.set(x, j, 'mist3');
  }
  for (let x = 3; x < W; x += ri(9, 16)) clump(a, x, ri(56, 60), ri(4, 7), ['g3', 'g2', 'g1', 'g1']);
  trunks(a, 0, G);
  // root flare
  for (const t of TREES) {
    const half = Math.floor(t.w / 2);
    for (let j = 0; j < 7; j += 1) {
      const y = G - 7 + j;
      const out = Math.round((j * j) / 9);
      a.rect(t.x - half - out, y, out, 1, 'b3');
      a.rect(t.x - half + t.w, y, out, 1, 'b1');
    }
  }
  // soil, dithered from topsoil into subsoil
  for (let y = G; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const edge = 96 + 4 * Math.sin((x / W) * Math.PI * 4 + 1);
      const base = dither(x, y, (y - edge) / 14) ? 'soil2' : 'soil1';
      a.set(x, y, soilAt(x, y, base));
    }
  }
  for (const [x, y, w] of [
    [22, 84, 6],
    [78, 104, 5],
    [140, 80, 7],
    [176, 112, 5],
    [246, 92, 6],
    [300, 108, 5],
  ]) {
    a.rect(x, y, w, 3, 'stoned');
    a.rect(x + 1, y, w - 2, 1, 'stone');
  }
  // roots
  taproots(a, G, H);
  for (const t of TREES) {
    for (const s of [-1, 1]) {
      const from = [t.x + s * 3, G + 1];
      const reach = ri(24, 34);
      let pts = Art.curve(from, [t.x + s * reach * 0.7, G + 5], [t.x + s * reach, G + ri(26, 40)]);
      a.path(pts.map(([x, y]) => [x, y + 1]), 'rootd', 2);
      a.path(pts, 'root', 2);
      pts = Art.curve([t.x + s * 2, G + 10], [t.x + s * 10, G + 22], [t.x + s * ri(12, 18), G + ri(40, 54)]);
      a.path(pts, 'root');
      pts = Art.curve([t.x, G + ri(28, 36)], [t.x + s * 6, G + 40], [t.x + s * ri(8, 14), G + ri(52, 62)]);
      a.path(pts, 'rootd');
    }
  }
  // turf, grass, ferns
  a.rect(0, G, W, 2, 'g3');
  for (let x = 0; x < W; x += 1) if (hash(x, 9) < 0.5) a.set(x, G + 2, 'g4');
  const clear = (x) => TREES.every((t) => Math.abs(t.x - x) > t.w / 2 + 3);
  for (let x = 0; x < W; x += ri(1, 3)) {
    if (!clear(x)) continue;
    const tall = ri(2, 6);
    const key = rnd() < 0.4 ? 'g2' : 'g3';
    for (let j = 0; j < tall; j += 1) a.set(x + (j > 3 ? 1 : 0), G - 1 - j, key);
    if (tall > 4 && rnd() < 0.3) a.set(x + 1, G - 1 - tall, 'g1');
  }
  for (const x of [58, 128, 164, 240, 312]) {
    for (const s of [-1, 1]) {
      const pts = Art.curve([x, G - 1], [x + s * 3, G - 10], [x + s * 8, G - 7], 10);
      a.path(pts, 'g2');
      for (const [fx, fy] of pts.slice(2)) a.set(fx, fy + 1, 'g3');
    }
  }
  // mushrooms and a few flowers
  for (const x of [74, 150, 190, 262]) {
    a.rect(x, G - 3, 2, 3, 'capspot');
    a.rect(x - 2, G - 5, 6, 2, 'cap');
    a.rect(x - 1, G - 6, 4, 1, 'cap');
    a.set(x - 1, G - 5, 'capspot');
    a.set(x + 2, G - 6, 'capspot');
  }
  for (const x of [20, 92, 136, 204, 296]) {
    a.set(x, G - 5, 'flower');
    a.set(x, G - 4, 'g2');
    a.set(x, G - 3, 'g2');
  }
  return a;
}

/** 320×64, tiles downward: subsoil with each tree's taproot passing through. */
function soilTile() {
  const a = new Art(W, 64, 'soil2', true);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < W; x += 1) a.set(x, y, soilAt(x, y, 'soil2'));
  taproots(a, 0, 64);
  for (const t of TREES) {
    for (const [y, s] of [
      [14, 1],
      [40, -1],
    ]) {
      a.line(t.x, y, t.x + s * 5, y + 4, 'rootd');
    }
  }
  return a;
}

/** 64×64, tiles both ways: the deepest earth. */
function deepTile() {
  const a = new Art(64, 64, 'soil4', true);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) a.set(x, y, soilAt(x, y, 'soil4'));
  return a;
}

/** Root tips and the threads between them. Returns the frames of the travelling lights. */
function mycelium(frames) {
  const H = 200;
  const a = new Art(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const t = (x / W) * Math.PI * 2;
      const e1 = 58 + 5 * Math.sin(t * 2);
      const e2 = 166 + 4 * Math.sin(t * 3 + 1);
      let base = dither(x, y, (y - e1) / 14) ? 'soil3' : 'soil2';
      if (dither(x, y, (y - e2) / 16)) base = 'soil4';
      a.set(x, y, soilAt(x, y, base));
    }
  }
  for (const [x, y, w] of [
    [30, 100, 6],
    [88, 142, 5],
    [150, 96, 7],
    [196, 150, 5],
    [262, 118, 6],
    [306, 84, 5],
  ]) {
    a.rect(x, y, w, 3, 'stoned');
    a.rect(x + 1, y, w - 2, 1, 'stone');
  }

  const nodes = [];
  const tipsOf = [];
  taproots(a, 0, 30);
  for (const t of TREES) {
    const tips = [];
    for (const dx of [-27, -9, 10, 28]) {
      const tip = [t.x + dx + ri(-3, 3), ri(52, 74)];
      const pts = Art.curve([t.x, ri(20, 30)], [t.x + dx * 0.5, 40], tip);
      a.path(pts.map(([x, y]) => [x - 1, y]), 'rootd');
      a.path(pts, 'root');
      nodes.push({ x: tip[0], y: tip[1], tip: true });
      tips.push(nodes.length - 1);
    }
    tipsOf.push(tips);
  }
  // sideways distance, the short way round the tile
  const dxWrap = (from, to) => {
    let d = to - from;
    if (d > W / 2) d -= W;
    if (d < -W / 2) d += W;
    return d;
  };
  const far = (p, q) => Math.hypot(dxWrap(p.x, q.x), (q.y - p.y) * 1.25);
  for (let guard = 0; nodes.length < 62 && guard < 8000; guard += 1) {
    const p = { x: ri(0, W - 1), y: ri(80, 170) };
    if (nodes.every((n) => far(n, p) > 17)) nodes.push(p);
  }
  const edges = [];
  const seen = new Set();
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j) => ({ j, d: far(n, m) }))
      .filter((o) => o.j !== i && !(n.tip && nodes[o.j].tip))
      .sort((p, q) => p.d - q.d)
      .slice(0, n.tip ? 2 : 3);
    for (const { j } of near) {
      const k = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = nodes[j];
      const to = [n.x + dxWrap(n.x, m.x), m.y];
      const bend = r(-0.2, 0.2);
      const mid = [(n.x + to[0]) / 2 - (to[1] - n.y) * bend, (n.y + to[1]) / 2 + (to[0] - n.x) * bend];
      edges.push({ a: i, b: j, pts: Art.curve([n.x, n.y], mid, to, 14) });
    }
  });
  for (const e of edges) a.path(e.pts, hash(e.a, e.b) < 0.3 ? 'hyphad' : 'hypha');
  for (let i = 0; i < 18; i += 1) {
    const n = nodes[ri(16, nodes.length - 1)];
    a.path(Art.curve([n.x, n.y], [n.x + ri(-8, 8), n.y + 8], [n.x + ri(-14, 14), n.y + ri(10, 20)], 8), 'hyphad');
  }

  // routes from one tree's root tip to the next tree's, for the lights to travel
  const adj = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push({ to: e.b, pts: e.pts });
    adj[e.b].push({ to: e.a, pts: [...e.pts].reverse() });
  }
  const route = (from, to) => {
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      for (const step of adj[cur]) {
        if (!prev.has(step.to)) {
          prev.set(step.to, { from: cur, pts: step.pts });
          queue.push(step.to);
        }
      }
    }
    if (!prev.has(to)) return [];
    const legs = [];
    for (let cur = to; prev.get(cur); cur = prev.get(cur).from) legs.unshift(prev.get(cur).pts);
    return legs.flat();
  };
  const routes = [
    route(tipsOf[0][3], tipsOf[1][0]),
    route(tipsOf[1][3], tipsOf[2][0]),
    route(tipsOf[2][3], tipsOf[3][0]),
    route(tipsOf[3][3], tipsOf[0][0]),
    route(tipsOf[2][1], tipsOf[1][2]).reverse(),
    route(tipsOf[1][1], tipsOf[0][2]).reverse(),
  ].filter((pts) => pts.length > 0);

  const sheet = new Art(W, H * frames);
  for (let f = 0; f < frames; f += 1) {
    const frame = a.copy();
    nodes.forEach((n, i) => {
      const lit = i % 4 === 0 && mod(f + i, 6) < 2;
      if (n.tip) {
        frame.rect(n.x - 1, n.y - 1, 2, 2, 'root');
      } else if (i % 3 === 0) {
        frame.rect(n.x - 1, n.y - 1, 2, 2, lit ? 'glow' : 'spore');
      } else {
        frame.set(n.x, n.y, lit ? 'glow' : 'spore');
      }
    });
    routes.forEach((pts, i) => {
      const at = Math.floor(mod(f / frames + i * 0.37, 1) * pts.length);
      for (const [back, key] of [
        [4, 'spore'],
        [2, 'spore'],
        [0, 'glow'],
      ]) {
        const p = pts[Math.max(at - back, 0)];
        if (back === 0) frame.rect(p[0] - 1, p[1] - 1, 2, 2, key);
        else frame.set(p[0], p[1], key);
      }
    });
    sheet.px.set(frame.px, f * W * H);
  }
  return sheet;
}

/** The sun by day; the same disc, with marks, is the moon by night. */
function sun() {
  const a = new Art(28, 28);
  a.disc(13.5, 13.5, 12, 'sun');
  a.disc(15, 12, 9, 'sunhi');
  a.disc(13.5, 13.5, 8, 'sun');
  a.disc(16, 11, 5, 'sunhi');
  a.disc(9, 16, 2, 'sunmark');
  a.disc(17, 18, 1, 'sunmark');
  a.set(12, 9, 'sunmark');
  return a;
}

/** 128×128: a thin scatter of stars, which only the night palette shows. */
function stars() {
  const a = new Art(128, 128, 'none', true);
  for (let i = 0; i < 11; i += 1) a.set(ri(0, 127), ri(0, 127), 'star');
  for (const [x, y] of [
    [97, 31],
    [22, 88],
  ]) {
    a.rect(x - 1, y, 3, 1, 'star');
    a.rect(x, y - 1, 1, 3, 'star');
  }
  return a;
}

// ---------- PNG ----------

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, sum]);
}

function png(art, theme) {
  const col = theme === 'day' ? 0 : 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(art.w, 0);
  ihdr.writeUInt32BE(art.h, 4);
  ihdr.set([8, 3, 0, 0, 0], 8); // 8-bit, palette
  const plte = Buffer.from(KEYS.flatMap((k) => PALETTE[k][col].match(/\w\w/g).map((h) => parseInt(h, 16))));
  const trns = Buffer.from(KEYS.map((k) => (TRANSPARENT[theme].includes(k) ? 0 : 255)));
  const rows = Buffer.alloc((art.w + 1) * art.h);
  for (let y = 0; y < art.h; y += 1) rows.set(art.px.subarray(y * art.w, (y + 1) * art.w), y * (art.w + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const leaf = leaves();
const pictures = {
  leaves: leaf,
  horizon: horizon(leaf),
  branches: branches(),
  underside: underside(),
  trunks: trunkTile(),
  ground: ground(),
  soil: soilTile(),
  mycelium: mycelium(12), // landing.css steps through the same 12 frames
  deep: deepTile(),
  sun: sun(),
  stars: stars(),
};
for (const theme of ['day', 'night']) {
  const dir = fileURLToPath(new URL(`img/${theme}/`, import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const [name, art] of Object.entries(pictures)) writeFileSync(`${dir}${name}.png`, png(art, theme));
}
