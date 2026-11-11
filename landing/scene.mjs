// Draws the landing page's illustration.
//
// Usage: node landing/scene.mjs
//
// It rewrites the SVG between each `<!-- scene:NAME -->` and
// `<!-- /scene:NAME -->` pair in index.html, and touches nothing else. The
// random numbers come from a fixed seed, so a run with no changes here leaves
// index.html as it was. Every SVG is 1000 units wide and stretches to the page
// width, which is why the trees' x positions read as tenths of a percent.
// Colors and stroke widths live in landing.css, keyed on the class names.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let seed = 20261110;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const r = (a, b) => a + rnd() * (b - a);
const f = (n) => Math.round(n * 10) / 10;

// The four trees: x (of 1000) and trunk width. Every scene places them here, so they line up.
const TREES = [
  { x: 100, w: 30 },
  { x: 270, w: 40 },
  { x: 730, w: 36 },
  { x: 900, w: 28 },
];

const svg = (h, cls, body) =>
  `<svg class="band ${cls}" viewBox="0 0 1000 ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${body}</svg>`;
const dot = (x, y, cls) => `<path class="${cls}" d="M${f(x)},${f(y)}h0"/>`;

/** A scalloped foliage edge. dir -1: bumps rise above `base` and the fill runs to `to`. */
function scallops(base, amp, n, to, dir = -1) {
  const w = 1000 / n;
  let d = `M0,${to}L0,${f(base)}`;
  for (let i = 0; i < n; i += 1) {
    const x0 = i * w;
    const peak = base + dir * amp * r(0.9, 2);
    const y1 = base + dir * r(0, amp * 0.25);
    d += `Q${f(x0 + w * r(0.35, 0.65))},${f(peak)} ${f(x0 + w)},${f(y1)}`;
  }
  return `${d}L1000,${to}Z`;
}

// ---------- A: the overstory against the sky ----------
function canopyTop() {
  let b = '';
  b += `<path class="leaf-1" d="${scallops(150, 34, 17, 300)}"/>`;
  b += `<path class="leaf-2" d="${scallops(185, 30, 13, 300)}"/>`;
  for (const t of TREES) {
    b += `<ellipse class="leaf-3" cx="${t.x}" cy="${f(r(205, 225))}" rx="${f(r(120, 150))}" ry="${f(r(95, 120))}"/>`;
  }
  b += `<ellipse class="leaf-3" cx="500" cy="262" rx="150" ry="70"/>`;
  b += `<path class="leaf-4" d="${scallops(262, 22, 15, 300)}"/>`;
  // a few birds
  for (const [x, y] of [
    [610, 52],
    [655, 76],
    [585, 92],
  ]) {
    b += `<path class="bird" d="M${x - 14},${y}q7,-9 14,0q7,-9 14,0"/>`;
  }
  return svg(300, 'band-canopy', b);
}

// ---------- B: branches reaching across and weaving ----------
function branches() {
  const H = 360;
  const left = [
    { y: 95, a: 34, l: 330, p: 0.4, end: 800 },
    { y: 180, a: 40, l: 380, p: 2.2, end: 860 },
    { y: 265, a: 30, l: 300, p: 4.1, end: 760 },
  ];
  const right = [
    { y: 120, a: 36, l: 350, p: 1.3, end: 180 },
    { y: 205, a: 32, l: 320, p: 3.4, end: 130 },
    { y: 290, a: 38, l: 400, p: 5.2, end: 230 },
  ];
  const yAt = (br, x) => br.y + br.a * Math.sin((2 * Math.PI * x) / br.l + br.p);
  const seg = (br, x0, x1) => {
    const step = x1 > x0 ? 20 : -20;
    let d = `M${f(x0)},${f(yAt(br, x0))}`;
    for (let x = x0 + step; step > 0 ? x < x1 : x > x1; x += step) d += `L${f(x)},${f(yAt(br, x))}`;
    return `${d}L${f(x1)},${f(yAt(br, x1))}`;
  };
  const twigs = (br, x0, x1) => {
    let out = '';
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    for (let x = lo + 30; x < hi; x += r(34, 60)) {
      const y = yAt(br, x);
      const up = rnd() < 0.5 ? -1 : 1;
      const dx = r(-16, 16);
      const dy = up * r(16, 30);
      out += `<path class="twig" d="M${f(x)},${f(y)}l${f(dx)},${f(dy)}"/>`;
      const cls = ['leaf-a', 'leaf-b', 'leaf-c'][Math.floor(rnd() * 3)];
      out += `<path class="${cls}" d="M${f(x + dx)},${f(y + dy)}l${f(r(-9, 9))},${f(up * r(6, 12))}"/>`;
      if (rnd() < 0.6) {
        out += `<path class="${cls}" d="M${f(x + dx * 0.5)},${f(y + dy * 0.6)}l${f(r(6, 12) * (rnd() < 0.5 ? -1 : 1))},${f(up * r(2, 8))}"/>`;
      }
    }
    return out;
  };
  let b = '';
  // soft foliage depth behind the branches
  for (let i = 0; i < 9; i += 1) {
    b += `<ellipse class="leaf-deep" cx="${f(r(0, 1000))}" cy="${f(r(40, H - 40))}" rx="${f(r(90, 170))}" ry="${f(r(40, 80))}"/>`;
  }
  for (const br of left) b += twigs(br, 0, br.end);
  for (const br of right) b += twigs(br, 1000, br.end);
  const draw = (br, x0, x1, thin) =>
    `<path class="knock" d="${seg(br, x0, x1)}"/><path class="${thin ? 'branch thin' : 'branch'}" d="${seg(br, x0, x1)}"/>`;
  for (const br of left) b += draw(br, 0, 520, false) + draw(br, 520, br.end, true);
  for (const br of right) b += draw(br, 1000, 480, false) + draw(br, 480, br.end, true);
  // weave: bring alternating stretches of the left branches back over the right ones
  left.forEach((br, i) => {
    for (let x = 240 + i * 60; x < br.end - 60; x += 180) {
      b += draw(br, x, Math.min(x + 90, br.end), x >= 520);
    }
  });
  return svg(H, 'band-branches', b);
}

// ---------- C: the canopy's underside, trunks coming down ----------
function underside() {
  const H = 240;
  let b = '';
  for (const t of TREES) {
    b += `<rect class="bark" x="${t.x - t.w / 2}" y="0" width="${t.w}" height="${H}"/>`;
    // a low bough on each trunk
    const s = t.x < 500 ? 1 : -1;
    b += `<path class="bough" d="M${t.x},${f(r(170, 200))}q${s * 40},-20 ${s * r(70, 110)},-${f(r(70, 100))}"/>`;
  }
  b += `<path class="leaf-2" d="${scallops(92, 26, 12, 0, 1)}"/>`;
  b += `<path class="leaf-3" d="${scallops(66, 24, 15, 0, 1)}"/>`;
  b += `<path class="leaf-4" d="${scallops(40, 22, 18, 0, 1)}"/>`;
  return svg(H, 'band-underside', b);
}

// ---------- D: the forest floor and the first roots ----------
function ground() {
  const H = 300;
  const G = 96; // ground line
  let b = '';
  // trunks, flaring at the base
  for (const t of TREES) {
    const h = t.w / 2;
    b += `<path class="bark" d="M${t.x - h},0L${t.x - h},${G - 40}Q${t.x - h},${G} ${t.x - h * 2.6},${G + 14}L${t.x + h * 2.6},${G + 14}Q${t.x + h},${G} ${t.x + h},${G - 40}L${t.x + h},0Z"/>`;
  }
  // soil
  b += `<path class="soil-1" d="M0,${H}L0,${G}Q130,${G - 10} 260,${G}T520,${G}T780,${G - 2}T1000,${G}L1000,${H}Z"/>`;
  b += `<path class="soil-2" d="M0,${H}L0,222Q170,204 330,224T660,220T1000,226L1000,${H}Z"/>`;
  // stones
  for (let i = 0; i < 10; i += 1) {
    b += `<ellipse class="stone" cx="${f(r(20, 980))}" cy="${f(r(G + 40, H - 20))}" rx="${f(r(8, 20))}" ry="${f(r(3, 7))}"/>`;
  }
  // roots
  for (const t of TREES) {
    b += `<path class="root tap" d="M${t.x},${G}L${t.x},${H}"/>`;
    for (const s of [-1, 1]) {
      const reach = r(60, 105);
      b += `<path class="root" d="M${t.x + s * 6},${G + 4}q${f(s * reach * 0.5)},${f(r(8, 20))} ${f(s * reach)},${f(r(60, 120))}"/>`;
      const reach2 = r(25, 50);
      b += `<path class="root fine" d="M${t.x + s * 3},${G + 30}q${f(s * reach2 * 0.4)},${f(r(20, 40))} ${f(s * reach2)},${f(r(90, 150))}"/>`;
      b += `<path class="root fine" d="M${t.x},${f(r(170, 210))}q${f(s * 14)},${f(r(10, 20))} ${f(s * r(24, 44))},${f(r(40, 70))}"/>`;
    }
  }
  // ferns and grass along the ground line
  for (let x = 8; x < 1000; x += r(9, 22)) {
    if (TREES.some((t) => Math.abs(t.x - x) < t.w * 1.2)) continue;
    const cls = rnd() < 0.3 ? 'grass alt' : 'grass';
    b += `<path class="${cls}" d="M${f(x)},${G + 3}q${f(r(-3, 3))},-${f(r(8, 14))} ${f(r(-8, 8))},-${f(r(14, 30))}"/>`;
  }
  return svg(H, 'band-ground', b);
}

// ---------- E: root tips and the mycelial network ----------
function mycelium() {
  const H = 560;
  let b = '';
  b += `<path class="soil-3" d="M0,${H}L0,150Q200,128 400,152T760,146T1000,156L1000,${H}Z"/>`;
  b += `<path class="soil-4" d="M0,${H}L0,452Q240,430 480,456T1000,448L1000,${H}Z"/>`;
  for (let i = 0; i < 14; i += 1) {
    b += `<ellipse class="stone" cx="${f(r(20, 980))}" cy="${f(r(170, H - 30))}" rx="${f(r(8, 22))}" ry="${f(r(3, 8))}"/>`;
  }

  // roots: each tree's taproot forks into tips
  const nodes = [];
  const edges = [];
  const tipsOf = [];
  let roots = '';
  TREES.forEach((t) => {
    roots += `<path class="root tap" d="M${t.x},0L${t.x},70"/>`;
    const tips = [];
    for (const dx of [-70, -24, 28, 76]) {
      const tx = t.x + dx + r(-10, 10);
      const ty = r(150, 215);
      roots += `<path class="root fine" d="M${t.x},${f(r(40, 70))}Q${f(t.x + dx * 0.5)},${f(r(80, 110))} ${f(tx)},${f(ty)}"/>`;
      nodes.push({ x: tx, y: ty, tip: true });
      tips.push(nodes.length - 1);
    }
    tipsOf.push(tips);
  });

  // scatter the network's nodes, keeping them apart
  let guard = 0;
  while (nodes.length < 74 && guard < 6000) {
    guard += 1;
    const p = { x: r(14, 986), y: r(205, 520) };
    if (nodes.every((n) => Math.hypot((n.x - p.x) * 0.9, (n.y - p.y) * 1.5) > 58)) nodes.push(p);
  }
  // join each node to its nearest neighbours
  const key = (a, c) => (a < c ? `${a}-${c}` : `${c}-${a}`);
  const seen = new Map();
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j) => ({ j, d: Math.hypot(m.x - n.x, (m.y - n.y) * 1.3) }))
      .filter((o) => o.j !== i && !(n.tip && nodes[o.j].tip))
      .sort((p, q) => p.d - q.d)
      .slice(0, n.tip ? 2 : 3);
    for (const { j } of near) {
      const k = key(i, j);
      if (seen.has(k)) continue;
      const m = nodes[j];
      const bend = r(-0.22, 0.22);
      const e = {
        a: i,
        b: j,
        cx: (n.x + m.x) / 2 - (m.y - n.y) * bend,
        cy: (n.y + m.y) / 2 + (m.x - n.x) * bend,
      };
      seen.set(k, e);
      edges.push(e);
    }
  });
  const adj = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push({ to: e.b, e });
    adj[e.b].push({ to: e.a, e });
  }
  let web = '';
  for (const e of edges) {
    const n = nodes[e.a];
    const m = nodes[e.b];
    web += `<path class="hypha" d="M${f(n.x)},${f(n.y)}Q${f(e.cx)},${f(e.cy)} ${f(m.x)},${f(m.y)}"/>`;
  }
  // stray threads that wander off
  for (let i = 0; i < 26; i += 1) {
    const n = nodes[Math.floor(r(16, nodes.length))];
    web += `<path class="hypha faint" d="M${f(n.x)},${f(n.y)}q${f(r(-30, 30))},${f(r(10, 30))} ${f(r(-50, 50))},${f(r(24, 60))}"/>`;
  }

  // routes between one tree's root tip and another's, for the travelling pulses
  const route = (from, to) => {
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      for (const { to: nx, e } of adj[cur]) {
        if (!prev.has(nx)) {
          prev.set(nx, { from: cur, e });
          queue.push(nx);
        }
      }
    }
    if (!prev.has(to)) return null;
    const steps = [];
    for (let cur = to; prev.get(cur); cur = prev.get(cur).from) steps.unshift({ at: cur, e: prev.get(cur).e });
    let d = `M${f(nodes[from].x)},${f(nodes[from].y)}`;
    for (const s of steps) d += `Q${f(s.e.cx)},${f(s.e.cy)} ${f(nodes[s.at].x)},${f(nodes[s.at].y)}`;
    return d;
  };
  const pairs = [
    [tipsOf[0][3], tipsOf[1][0]],
    [tipsOf[1][3], tipsOf[2][0]],
    [tipsOf[2][3], tipsOf[3][0]],
    [tipsOf[3][1], tipsOf[1][2]],
    [tipsOf[2][1], tipsOf[0][2]],
    [tipsOf[0][0], tipsOf[3][3]],
  ];
  let pulses = '';
  pairs.forEach(([p, q], i) => {
    const d = route(p, q);
    if (d) pulses += `<path class="pulse p${i + 1}" pathLength="100" d="${d}"/>`;
  });

  let dots = '';
  nodes.forEach((n) => {
    dots += dot(n.x, n.y, n.tip ? 'node tip' : rnd() < 0.25 ? 'node big' : 'node');
  });
  b += web + roots + pulses + dots;
  return svg(H, 'band-mycelium', b);
}

// The same trunks and taproots, stretched behind the text between two bands.
const trunks = () =>
  svg(10, 'trunks', TREES.map((t) => `<rect class="bark" x="${t.x - t.w / 2}" y="0" width="${t.w}" height="10"/>`).join(''));
const taproots = () =>
  svg(10, 'taproots', TREES.map((t) => `<path class="root tap" d="M${t.x},0V10"/>`).join(''));

const SCENES = { canopy: canopyTop, branches, underside, trunks, ground, taproots, mycelium };

const page = fileURLToPath(new URL('index.html', import.meta.url));
let html = readFileSync(page, 'utf8');
for (const [name, draw] of Object.entries(SCENES)) {
  const slot = new RegExp(`(<!-- scene:${name} -->)[\\s\\S]*?(<!-- /scene:${name} -->)`);
  if (!slot.test(html)) throw new Error(`index.html has no scene:${name} markers`);
  html = html.replace(slot, (_, open, close) => `${open}\n${draw()}\n${close}`);
}
writeFileSync(page, html);
