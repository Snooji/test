// Generates docs/concept-art.html from the real game data (map, items, characters).
// Run: node scripts/build-concept-art.mjs
import fs from 'node:fs';
import { WALLS, ROOMS, ITEM_SPAWNS, PLAYER_SPAWNS, CAT_WAYPOINTS, TRUCK, PROPS } from '../shared/world.js';
import { ITEM_TYPES } from '../shared/logic.js';
import { PORTRAITS, CHARACTERS } from '../client/src/portraits.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const shot = (f) => 'data:image/jpeg;base64,' + fs.readFileSync(new URL(`../docs/shots/${f}`, import.meta.url)).toString('base64');

// ---------- top-down level map ----------
const S = 16, X0 = -24, Z0 = -15, W = 48 * S, H = 30 * S;
const mx = (x) => ((x - X0) * S).toFixed(1), mz = (z) => ((z - Z0) * S).toFixed(1);
function levelMap() {
  const o = [];
  o.push(`<rect width="${W}" height="${H}" fill="#2b2546"/>`);
  for (let i = 0; i < 40; i++) { const x = (i * 97) % W, y = (i * 61) % H; o.push(`<circle cx="${x}" cy="${y}" r="${2 + (i % 4) * 3}" fill="none" stroke="#231d3b" stroke-width="3"/>`); }
  o.push(`<rect x="${mx(0)}" y="${mz(-3.6)}" width="${10 * S}" height="${5.2 * S}" fill="#3d355e" rx="4"/>`);
  for (const r of ROOMS) {
    o.push(`<rect x="${mx(r.x0)}" y="${mz(r.z0)}" width="${(r.x1 - r.x0) * S}" height="${(r.z1 - r.z0) * S}" fill="${hex(r.floor)}"/>`);
    o.push(`<text x="${mx((r.x0 + r.x1) / 2)}" y="${+mz(r.z0) + 26}" class="room">${r.name.toUpperCase()}</text>`);
  }
  for (const p of PROPS) {
    if (p.kind === 'rug') o.push(`<rect x="${mx(p.x - p.w / 2)}" y="${mz(p.z - p.d / 2)}" width="${p.w * S}" height="${p.d * S}" fill="${hex(p.color)}" opacity=".45" rx="6"/>`);
    if (p.kind === 'bed') o.push(`<rect x="${mx(p.x - p.w / 2)}" y="${mz(p.z - p.d / 2)}" width="${p.w * S}" height="${p.d * S}" fill="${hex(p.color)}" opacity=".6" rx="6"/>`);
    if (p.kind === 'counter') o.push(`<rect x="${mx(p.x - p.w / 2)}" y="${mz(p.z - p.d / 2)}" width="${p.w * S}" height="${p.d * S}" fill="#cfcbe6" opacity=".5"/>`);
    if (p.kind === 'plant') o.push(`<circle cx="${mx(p.x)}" cy="${mz(p.z)}" r="7" fill="#52d17c"/>`);
  }
  // truck
  o.push(`<rect x="${mx(TRUCK.ramp.x0)}" y="${mz(TRUCK.ramp.z0)}" width="${(TRUCK.ramp.x1 - TRUCK.ramp.x0) * S}" height="${(TRUCK.ramp.z1 - TRUCK.ramp.z0) * S}" fill="#55ffcc" opacity=".22" stroke="#55ffcc" stroke-dasharray="6 5"/>`);
  o.push(`<text x="${mx(11.2)}" y="${mz(3.6)}" class="lbl mint">LOAD ZONE</text>`);
  o.push(`<rect x="${mx(TRUCK.bayX0)}" y="${mz(-2.8)}" width="${(TRUCK.bayX1 - TRUCK.bayX0) * S}" height="${5.6 * S}" fill="#1b1730" stroke="#f4f1ff" stroke-width="4"/>`);
  for (let i = 1; i < 4; i++) {
    o.push(`<line x1="${mx(TRUCK.bayX0 + i * 1.2)}" y1="${mz(-2.4)}" x2="${mx(TRUCK.bayX0 + i * 1.2)}" y2="${mz(2.4)}" stroke="#55ffcc" opacity=".5"/>`);
    o.push(`<line x1="${mx(TRUCK.bayX0)}" y1="${mz(-2.4 + i * 1.2)}" x2="${mx(TRUCK.bayX1)}" y2="${mz(-2.4 + i * 1.2)}" stroke="#55ffcc" opacity=".5"/>`);
  }
  o.push(`<rect x="${mx(TRUCK.bayX1)}" y="${mz(-2.8)}" width="${(TRUCK.cabX1 - TRUCK.bayX1) * S}" height="${5.6 * S}" fill="#6b4dff" rx="10"/>`);
  o.push(`<text x="${mx((TRUCK.bayX1 + TRUCK.cabX1) / 2)}" y="${mz(0.3)}" class="lbl" transform="rotate(90 ${mx((TRUCK.bayX1 + TRUCK.cabX1) / 2)} ${mz(0)})">STARSIDE</text>`);
  // walls
  for (const w of WALLS) if (!w.invisible && w.x0 < 13) o.push(`<rect x="${mx(w.x0)}" y="${mz(w.z0)}" width="${(w.x1 - w.x0) * S}" height="${(w.z1 - w.z0) * S}" fill="#e9e4ff"/>`);
  o.push(`<text x="${mx(1.6)}" y="${mz(-4)}" class="lbl" transform="rotate(90 ${mx(1.6)} ${mz(-4)})">FRONT DOOR</text>`);
  // cat path
  o.push(`<polyline points="${[...CAT_WAYPOINTS, CAT_WAYPOINTS[0]].map(([x, z]) => mx(x) + ',' + mz(z)).join(' ')}" fill="none" stroke="#c9c3e6" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" opacity=".7"/>`);
  o.push(`<text x="${mx(-8)}" y="${mz(-0.9)}" class="lbl small">moon-cat route ⋯</text>`);
  // items
  for (const [type, x, z] of ITEM_SPAWNS) {
    const t = ITEM_TYPES[type], c = hex(t.color);
    if (t.w > 1) o.push(`<rect x="${+mx(x) - S}" y="${+mz(z) - 8}" width="${2 * S}" height="16" rx="4" fill="${c}" stroke="#0e0a24" stroke-width="2"/>`);
    else if (type === 'lamp') o.push(`<circle cx="${mx(x)}" cy="${mz(z)}" r="8" fill="${c}" stroke="#0e0a24" stroke-width="2"/>`);
    else o.push(`<rect x="${+mx(x) - 7}" y="${+mz(z) - 7}" width="14" height="14" rx="2" fill="${c}" stroke="#0e0a24" stroke-width="2"/>`);
  }
  // spawns
  const cols = ['#ff8a3d', '#2ec4b6', '#7bd84a', '#a66cff'];
  PLAYER_SPAWNS.forEach((p, i) => o.push(`<circle cx="${mx(p.x)}" cy="${mz(p.z)}" r="6" fill="${cols[i]}" stroke="#fff" stroke-width="2"/>`));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Top-down map of the house, yard and truck">${o.join('')}</svg>`;
}

// ---------- isometric cargo grid ----------
const isoS = 34;
const P = (x, y, z) => [(x - z) * isoS * 0.866, (x + z) * isoS * 0.5 - y * isoS];
const shade = (c, f) => '#' + [16, 8, 0].map(s => Math.min(255, Math.round(((c >> s) & 255) * f)).toString(16).padStart(2, '0')).join('');
function cube(x, y, z, w, d, color, extra = '') {
  const pts = (a) => a.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ');
  const top = [P(x, y + 1, z), P(x + w, y + 1, z), P(x + w, y + 1, z + d), P(x, y + 1, z + d)];
  const left = [P(x, y, z + d), P(x + w, y, z + d), P(x + w, y + 1, z + d), P(x, y + 1, z + d)];
  const right = [P(x + w, y, z), P(x + w, y, z + d), P(x + w, y + 1, z + d), P(x + w, y + 1, z)];
  return `<g ${extra}><polygon points="${pts(top)}" fill="${shade(color, 1.15)}"/><polygon points="${pts(left)}" fill="${shade(color, 0.85)}"/><polygon points="${pts(right)}" fill="${shade(color, 0.65)}"/><polygon points="${pts(top)}" fill="none" stroke="#0e0a24" stroke-width="1.2"/><polygon points="${pts(left)}" fill="none" stroke="#0e0a24" stroke-width="1.2"/><polygon points="${pts(right)}" fill="none" stroke="#0e0a24" stroke-width="1.2"/></g>`;
}
function isoGrid(stack, caption) {
  const o = [];
  for (let i = 0; i <= 4; i++) {
    const a = P(i, 0, 0), b = P(i, 0, 4), c = P(0, 0, i), d = P(4, 0, i);
    o.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="gl"/><line x1="${c[0]}" y1="${c[1]}" x2="${d[0]}" y2="${d[1]}" class="gl"/>`);
  }
  for (const h of [0, 4]) { const [x1, y1] = P(0, h, 0), [x2, y2] = P(0, 4, 0); o.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="gl"/>`); }
  const [hx, hy] = P(4, 0, 0), [hx2, hy2] = P(4, 4, 0);
  o.push(`<line x1="${hx}" y1="${hy}" x2="${hx2}" y2="${hy2}" class="gl"/>`);
  const sorted = [...stack].sort((a, b) => (a.x + a.z) - (b.x + b.z) || a.y - b.y);
  for (const c of sorted) o.push(cube(c.x, c.y, c.z, c.w || 1, c.d || 1, ITEM_TYPES[c.t].color, c.broken ? 'class="crack"' : ''));
  return `<figure class="iso"><svg viewBox="-150 -150 300 300" role="img" aria-label="${caption}">${o.join('')}</svg><figcaption>${caption}</figcaption></figure>`;
}
const good = [
  { t: 'heavy', x: 0, y: 0, z: 0 }, { t: 'heavy', x: 1, y: 0, z: 0 }, { t: 'heavy', x: 0, y: 0, z: 1 },
  { t: 'couch', x: 2, y: 0, z: 0, w: 2 }, { t: 'standard', x: 1, y: 0, z: 1 }, { t: 'standard', x: 0, y: 1, z: 0 },
  { t: 'standard', x: 1, y: 1, z: 0 }, { t: 'desk', x: 2, y: 1, z: 0, w: 2 }, { t: 'fragile', x: 0, y: 2, z: 0 },
  { t: 'fragile', x: 1, y: 2, z: 0 }, { t: 'standard', x: 2, y: 0, z: 1 }, { t: 'fragile', x: 2, y: 1, z: 1 },
];
const bad = [
  { t: 'standard', x: 0, y: 0, z: 0 }, { t: 'fragile', x: 1, y: 0, z: 0, broken: true }, { t: 'heavy', x: 1, y: 1, z: 0 },
  { t: 'standard', x: 0, y: 1, z: 0 }, { t: 'fragile', x: 2, y: 0, z: 1, broken: true }, { t: 'table', x: 2, y: 1, z: 1, w: 2 },
];

// ---------- page ----------
const crew = Object.entries(CHARACTERS).map(([k, c]) => `
  <article class="mover" style="--c:${c.color}">
    <div class="art">${PORTRAITS[k]}</div>
    <div class="meta"><h3>${c.name}</h3><p class="kind">${c.kind} · Starside crew</p><p>${c.blurb}</p>
    <dl><dt>Ability</dt><dd>Jetpack dash. Double speed for 0.6 s, 5 s cooldown.</dd><dt>Suit colour</dt><dd><span class="sw"></span><code>${c.color}</code></dd></dl></div>
  </article>`).join('');

const items = Object.entries(ITEM_TYPES).map(([k, t]) => `
  <tr><td><span class="chip" style="background:${hex(t.color)}"></span>${t.label}</td><td class="num">${t.w}×${t.d}</td><td class="num">${t.pts}</td>
  <td>${[t.heavy && !t.furniture ? 'Heavy: 60% walk speed, crushes fragile' : '', t.fragile ? 'Breaks under heavy items or furniture' : '', t.needsWrap ? 'Pad-wrap it (hold ACTION)' : '', t.needsDisassemble ? 'Disassemble first (hold ACTION)' : '', t.teamCarry ? 'Two-mover lift' : ''].filter(Boolean).join(' · ') || 'The honest workhorse'}</td></tr>`).join('');

const future = [
  ['Zero-G Penthouse', 'Gravity flickers off for 5 s at a time. Boxes drift, and anything unbuckled floats off the stack.', '#8ecae6'],
  ['Moon Mansion', 'Two floors and a staircase. Heavy boxes slide back down if you stop on the stairs.', '#ffd166'],
  ['Asteroid Storage Unit', 'Tight aisles and a second, smaller truck. Split the crew or race for the good columns.', '#ff8a3d'],
  ['Comet Rush Hour', 'The truck has to leave when the comet passes. The clock speeds up as it gets closer.', '#ff4466'],
].map(([n, d, c]) => `<article class="lvl" style="--c:${c}"><h3>${n}</h3><p>${d}</p><span class="tag">concept · not built yet</span></article>`).join('');

const html = `<title>Starside Movers Concept Art</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bungee&family=Rubik:wght@400;500;700&family=JetBrains+Mono:wght@500&display=swap">
<style>
/* Layout: truck-decal signage headings over a dark lunar ground, one long scroll of art boards */
:root {
  --space: #0e0a24; --panel: #1a1440; --line: #3a3170; --ink: #f2eeff; --mute: #b0a6dc;
  --orange: #ff8a3d; --mint: #55ffcc; --gold: #ffd166; --crunch: #ff4466;
  --display: 'Bungee', 'Arial Black', Impact, sans-serif;
  --body: 'Rubik', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  color-scheme: dark;
}
body { background: var(--space); color: var(--ink); font: 400 16px/1.6 var(--body); }
.wrap { max-width: 1080px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 64px; }
.hero { margin-top: calc(-1 * env(safe-area-inset-top, 0px)); padding-top: calc(env(safe-area-inset-top, 0px) + 56px); padding-bottom: 40px;
  background: radial-gradient(1200px 400px at 70% 0, #2a1f6b 0%, transparent 70%), var(--space); }
.hero .wrap { padding-block: 0; display: grid; gap: 12px; }
.eyebrow { font: 500 12px/1 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--mint); }
h1 { font: 400 clamp(40px, 8vw, 88px)/.95 var(--display); margin: 0; letter-spacing: .01em; text-wrap: balance; }
h1 span { color: var(--orange); display: block; }
.lede { max-width: 62ch; color: var(--mute); font-size: 18px; margin: 4px 0 0; }
h2 { font: 400 clamp(26px, 4vw, 38px)/1.05 var(--display); margin: 72px 0 6px; text-wrap: balance; }
h2 + p { color: var(--mute); margin: 0 0 24px; max-width: 65ch; }
h3 { margin: 0; font-weight: 700; font-size: 20px; }
.crew { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.mover { background: var(--panel); border-radius: 20px; overflow: hidden; display: grid; grid-template-rows: auto 1fr; }
.mover .art { background: radial-gradient(circle at 50% 60%, color-mix(in srgb, var(--c) 35%, transparent), transparent 70%), #120d33; padding: 20px 24px 8px; }
.mover .art svg { width: 100%; max-width: 200px; height: auto; display: block; margin: 0 auto; }
.mover .meta { padding: 16px 18px 18px; display: grid; gap: 6px; align-content: start; min-width: 0; }
.mover .kind { margin: 0; font: 500 12px/1 var(--mono); color: var(--c); text-transform: uppercase; letter-spacing: .12em; }
.mover p { margin: 0; color: var(--mute); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: 14px; }
dt { color: var(--mute); } dd { margin: 0; }
.sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; background: var(--c); vertical-align: -1px; margin-right: 6px; }
code { font: 500 13px var(--mono); }
.board { background: var(--panel); border-radius: 20px; padding: 16px; overflow-x: auto; }
.board svg { display: block; width: 100%; min-width: 620px; height: auto; border-radius: 12px; }
.room { font: 400 15px var(--display); fill: rgba(255,255,255,.4); text-anchor: middle; }
.lbl { font: 700 12px var(--body); fill: #f2eeff; text-anchor: middle; letter-spacing: .08em; }
.lbl.mint { fill: var(--mint); } .lbl.small { font-size: 11px; fill: #c9c3e6; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 14px; font-size: 14px; color: var(--mute); }
.chip { display: inline-block; width: 14px; height: 14px; border-radius: 3px; margin-right: 8px; vertical-align: -2px; border: 2px solid #0e0a24; }
.isos { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.iso { margin: 0; background: var(--panel); border-radius: 20px; padding: 16px; }
.iso svg { width: 100%; height: auto; display: block; }
.iso figcaption { font-weight: 700; margin-top: 6px; }
.gl { stroke: var(--mint); stroke-opacity: .45; stroke-width: 1; }
.crack polygon:first-child { fill: var(--crunch); }
.crack { opacity: .85; }
.rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
.rule { border: 2px solid var(--line); border-radius: 16px; padding: 14px 16px; }
.rule b { display: block; font: 400 15px var(--display); color: var(--gold); margin-bottom: 4px; }
.rule p { margin: 0; color: var(--mute); font-size: 15px; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
.tablewrap { overflow-x: auto; background: var(--panel); border-radius: 20px; padding: 8px 16px; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font: 500 12px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--mute); }
tr:last-child td { border-bottom: 0; }
.num { font-variant-numeric: tabular-nums; font-family: var(--mono); white-space: nowrap; }
.shots { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: start; }
.shots figure { margin: 0; display: grid; gap: 8px; }
.shots img { width: 100%; border-radius: 14px; border: 2px solid var(--line); display: block; }
.shots figcaption { color: var(--mute); font-size: 14px; }
.stack { display: grid; gap: 16px; }
.levels { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.lvl { border-radius: 18px; padding: 18px; background: linear-gradient(160deg, color-mix(in srgb, var(--c) 22%, var(--panel)), var(--panel) 60%); display: grid; gap: 8px; align-content: start; }
.lvl h3 { font: 400 18px var(--display); color: var(--c); }
.lvl p { margin: 0; color: var(--mute); font-size: 15px; }
.tag { justify-self: start; font: 500 11px var(--mono); text-transform: uppercase; letter-spacing: .12em; border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; color: var(--mute); }
footer { margin-top: 64px; color: var(--mute); font-size: 14px; }
@media (max-width: 640px) { .shots { grid-template-columns: 1fr; } }
</style>

<header class="hero"><div class="wrap">
  <span class="eyebrow">Concept art · v1 · built from the live game data</span>
  <h1>Starside <span>Movers</span></h1>
  <p class="lede">A 1–4 player moving-day party game. Astronauts and aliens load a truck like a 3D puzzle, stack it the way a pro crew would, and hold a crew meeting whenever something goes <b>crunch</b>.</p>
</div></header>

<main class="wrap">
  <h2>The crew</h2>
  <p>Four movers, two astronauts and two aliens. Each has a suit colour that matches their in-game model and the scoreboard. They share one ability so rounds stay fair.</p>
  <section class="crew">${crew}</section>

  <h2>Level 1: Lunar Cul-de-Sac</h2>
  <p>A four-room house on the moon. Movers start on the truck's ramp, run in through the front door and carry everything back to the load zone. This map is drawn from the same coordinates the server uses for collision, so it matches the game exactly.</p>
  <div class="board">${levelMap()}</div>
  <div class="legend">
    ${['standard', 'heavy', 'fragile', 'lamp', 'couch', 'desk'].map(k => `<span><span class="chip" style="background:${hex(ITEM_TYPES[k].color)}"></span>${ITEM_TYPES[k].label}</span>`).join('')}
    <span><span class="chip" style="background:#55ffcc;border-radius:50%"></span>Load zone / mover spawns</span>
  </div>

  <h2>The truck: a 4 × 4 × 4 cargo grid</h2>
  <p>On the ramp, movement aims a column and the item drops to the lowest resting height, Tetris-style. Two-cell furniture can be rotated. The grid has 64 cells and the house holds 29 items, so there's room for mistakes. It's the mistakes that cost you.</p>
  <div class="isos">
    ${isoGrid(good, 'A pro load: heavy on the floor, furniture mid-stack, fragile on top')}
    ${isoGrid(bad, 'A crunch: heavy box and a table dropped onto fragile boxes (red)')}
  </div>
  <div class="rules">
    <div class="rule"><b>Heavy on the bottom</b><p>Heavy boxes and furniture crush any fragile box they land on. The loader of the broken box loses its points.</p></div>
    <div class="rule"><b>Wrap it or scuff it</b><p>An unwrapped couch loads at half points. An unwrapped lamp shatters.</p></div>
    <div class="rule"><b>Call out</b><p>Breaks are anonymous. A correct call costs the culprit −15 and a strike. A wrong call costs the accuser.</p></div>
    <div class="rule"><b>Off the truck</b><p>Two strikes and you become a ghost. The winner is the top scorer still on the truck.</p></div>
  </div>

  <h2>Inventory &amp; points</h2>
  <p>Each item teaches one real moving rule. Two-mover furniture points are split between the carriers, and anyone who helps wrap or disassemble earns +5.</p>
  <div class="tablewrap"><table><thead><tr><th>Item</th><th>Cells</th><th>Points</th><th>Rule it teaches</th></tr></thead><tbody>${items}</tbody></table></div>

  <h2>In-game screens</h2>
  <p>Captured from the working build: the desktop lobby, carrying a box, aiming a drop in the truck, the phone HUD, and a crew meeting.</p>
  <div class="shots">
    <div class="stack">
      <figure><img src="${shot('02-lobby.jpg')}" alt="Lobby with character select and invite link"><figcaption>Lobby: pick a mover, pick a round length, share the invite link.</figcaption></figure>
      <figure><img src="${shot('06-loadmode.jpg')}" alt="Aiming a box into the truck grid"><figcaption>Load mode: the mint ghost shows where the box will land.</figcaption></figure>
      <figure><img src="${shot('11-meeting.jpg')}" alt="Crew meeting vote screen"><figcaption>Crew meeting: chat, vote, and the verdict is shown to everyone.</figcaption></figure>
    </div>
    <div class="stack">
      <figure><img src="${shot('08-phone-hud.jpg')}" alt="Phone HUD with joystick buttons"><figcaption>Phone: joystick on the left, ACTION and DASH on the right.</figcaption></figure>
      <figure><img src="${shot('05-carry.jpg')}" alt="Mover in the yard"><figcaption>The yard, with the house behind.</figcaption></figure>
    </div>
  </div>

  <h2>Future levels</h2>
  <p>Ideas for later houses that each add one twist to the same carry-stack-accuse loop.</p>
  <section class="levels">${future}</section>

  <footer>Starside Movers concept art · generated by scripts/build-concept-art.mjs from shared/world.js, shared/logic.js and the mover portraits.</footer>
</main>`;

fs.writeFileSync(new URL('../docs/concept-art.html', import.meta.url), html);
console.log('wrote docs/concept-art.html', (html.length / 1024).toFixed(0) + 'KB');
