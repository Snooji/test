// The game's look: voxel models, the house, the truck and the world.
// Performance rules: every model is ONE merged mesh (greedy-meshed: neighbouring faces of the same colour
// become one quad), colours live in the vertices, and everything shares one material, so a whole house
// or truck is a single draw call. A faint grid texture draws the block lines without extra triangles.
import * as THREE from 'three';
import { ITEM_TYPES, GRID } from '../../shared/logic.js';
import { CELL, TRUCK } from '../../shared/world.js';
import { STOREY_H, FLOOR_DZ } from '../../shared/level.js';
import { sprite, labelTexture } from './models.js';
import { rosterEntry } from '../../shared/roster.js';
import { attachModel, instanceModels } from './assets.js';
import { mulberryFor } from '../../shared/logic.js';

export const VS = 0.1; // model voxel size in metres
/** ?lite=1: skip yard decorations (low-end phones; also handy for testing) */
const LITE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lite') === '1';

// ---------- shared materials ----------
export const voxMat = new THREE.MeshLambertMaterial({ vertexColors: true }); // flat colour per voxel face, no outlines
const plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true }); // lit-looking bits: lamp shade, antenna tips, screens

// ---------- geometry batch: quads with colour + block-unit UVs ----------
const colCache = new Map();
const rgb = (hex) => { let c = colCache.get(hex); if (!c) { const k = new THREE.Color().setHex(hex); c = [k.r, k.g, k.b]; colCache.set(hex, c); } return c; };

export class Batch {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = []; }
  /** one face on axis d (0=x,1=y,2=z), facing sign, from corner o spanning su along axis (d+1)%3 and sv along (d+2)%3 */
  face(d, sign, o, su, sv, hex, unit) {
    const u = (d + 1) % 3, v = (d + 2) % 3, n = this.pos.length / 3;
    const du = [0, 0, 0], dv = [0, 0, 0]; du[u] = su; dv[v] = sv;
    const P = (a, b) => [o[0] + du[0] * a + dv[0] * b, o[1] + du[1] * a + dv[1] * b, o[2] + du[2] * a + dv[2] * b];
    const U = su / unit, V = sv / unit;
    const corners = sign > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    const c = rgb(hex), nn = [0, 0, 0]; nn[d] = sign;
    for (const [a, b] of corners) { this.pos.push(...P(a, b)); this.nor.push(...nn); this.col.push(...c); this.uv.push(a * U, b * V); }
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  box(x0, y0, z0, x1, y1, z1, hex, unit = 0.5) {
    const lo = [x0, y0, z0], hi = [x1, y1, z1];
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      for (const s of [-1, 1]) { const o = lo.slice(); o[d] = s > 0 ? hi[d] : lo[d]; this.face(d, s, o, hi[u] - lo[u], hi[v] - lo[v], hex, unit); }
    }
  }
  /** centred box, like THREE.BoxGeometry at a position */
  cbox(cx, cy, cz, w, h, d, hex, unit) { this.box(cx - w / 2, cy - h / 2, cz - d / 2, cx + w / 2, cy + h / 2, cz + d / 2, hex, unit); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
  get empty() { return !this.idx.length; }
}

// ---------- voxel model builder ----------
/** Sparse voxel model in metres. Colours can be a hex or a function (x, y, z centre in metres) → hex. */
export class Vox {
  constructor(s = VS) { this.s = s; this.m = new Map(); }
  set(i, j, k, hex) { this.m.set(i + ',' + j + ',' + k, hex); }
  fill(i0, i1, j0, j1, k0, k1, c, test = null) {
    const s = this.s;
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) for (let k = k0; k < k1; k++) {
      const x = (i + 0.5) * s, y = (j + 0.5) * s, z = (k + 0.5) * s;
      if (test && !test(x, y, z)) continue;
      this.set(i, j, k, typeof c === 'function' ? c(x, y, z) : c);
    }
    return this;
  }
  rng(a, b) { const s = this.s; let i0 = Math.round(a / s), i1 = Math.round(b / s); if (i1 <= i0) i1 = i0 + 1; return [i0, i1]; }
  box(cx, cy, cz, w, h, d, c) { return this.fill(...this.rng(cx - w / 2, cx + w / 2), ...this.rng(cy - h / 2, cy + h / 2), ...this.rng(cz - d / 2, cz + d / 2), c); }
  ell(cx, cy, cz, rx, ry, rz, c) {
    return this.fill(...this.rng(cx - rx, cx + rx), ...this.rng(cy - ry, cy + ry), ...this.rng(cz - rz, cz + rz), c,
      (x, y, z) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1.02);
  }
  /** cylinder along an axis ('x' | 'y' | 'z'); r1 = radius at the far end (cones) */
  cyl(cx, cy, cz, r, len, c, axis = 'y', r1 = r) {
    const half = len / 2, R = Math.max(r, r1);
    const ext = { x: [half, R, R], y: [R, half, R], z: [R, R, half] }[axis];
    return this.fill(...this.rng(cx - ext[0], cx + ext[0]), ...this.rng(cy - ext[1], cy + ext[1]), ...this.rng(cz - ext[2], cz + ext[2]), c, (x, y, z) => {
      const [a, b, t] = axis === 'y' ? [x - cx, z - cz, (y - cy + half) / len] : axis === 'x' ? [y - cy, z - cz, (x - cx + half) / len] : [x - cx, y - cy, (z - cz + half) / len];
      const rr = r + (r1 - r) * t;
      return a * a + b * b <= rr * rr + 1e-6;
    });
  }
  /** flat ring in the xz plane */
  ring(cx, cy, cz, R, t, c) {
    return this.fill(...this.rng(cx - R - t, cx + R + t), ...this.rng(cy - t, cy + t), ...this.rng(cz - R - t, cz + R + t), c,
      (x, y, z) => Math.abs(Math.hypot(x - cx, z - cz) - R) <= t);
  }
  /** greedy mesh into a batch (offset in metres) */
  into(batch, ox = 0, oy = 0, oz = 0, unit = this.s) {
    if (!this.m.size) return batch;
    const s = this.s, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const keys = [];
    for (const [k, c] of this.m) { const p = k.split(',').map(Number); keys.push([p, c]); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); } }
    const dims = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
    const vol = new Int32Array(dims[0] * dims[1] * dims[2]);
    const at = (x, y, z) => x + dims[0] * (y + dims[1] * z);
    for (const [p, c] of keys) vol[at(p[0] - lo[0], p[1] - lo[1], p[2] - lo[2])] = c + 1; // 0 = empty
    const get = (x) => vol[at(x[0], x[1], x[2])];
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3, x = [0, 0, 0], q = [0, 0, 0]; q[d] = 1;
      const mask = new Int32Array(dims[u] * dims[v]);
      for (x[d] = -1; x[d] < dims[d];) {
        let n = 0;
        for (x[v] = 0; x[v] < dims[v]; x[v]++) for (x[u] = 0; x[u] < dims[u]; x[u]++) {
          const a = x[d] >= 0 ? get(x) : 0;
          const b = x[d] < dims[d] - 1 ? get([x[0] + q[0], x[1] + q[1], x[2] + q[2]]) : 0;
          mask[n++] = (!!a === !!b) ? 0 : a ? a : -b;
        }
        x[d]++;
        n = 0;
        for (let j = 0; j < dims[v]; j++) for (let i = 0; i < dims[u];) {
          const c = mask[n];
          if (!c) { i++; n++; continue; }
          let w = 1; while (i + w < dims[u] && mask[n + w] === c) w++;
          let h = 1, ok = true;
          for (; j + h < dims[v]; h++) { for (let k = 0; k < w; k++) if (mask[n + k + h * dims[u]] !== c) { ok = false; break; } if (!ok) break; }
          const o = [0, 0, 0]; o[d] = x[d]; o[u] = i; o[v] = j;
          const wo = [(o[0] + lo[0]) * s + ox, (o[1] + lo[1]) * s + oy, (o[2] + lo[2]) * s + oz];
          batch.face(d, c > 0 ? 1 : -1, wo, w * s, h * s, Math.abs(c) - 1, unit);
          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * dims[u]] = 0;
          i += w; n += w;
        }
      }
    }
    return batch;
  }
  mesh(material = voxMat) {
    const m = new THREE.Mesh(this.into(new Batch()).geometry(), material);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
}

// ---------- movers ----------
const shade = (hex, k) => { const c = new THREE.Color(hex); c.multiplyScalar(k); return c.getHex(); };
function armMesh(len, hex, hand, material) {
  const v = new Vox().box(0, -len / 2, 0, 0.2, len, 0.2, hex).box(0, -len - 0.05, 0, 0.2, 0.1, 0.2, hand);
  return v.mesh(material);
}
function withArms(body, arms, material) {
  const g = new THREE.Group();
  g.add(body);
  for (const [s, x, y, len, hex, hand] of arms) { const a = armMesh(len, hex, hand, material); a.position.set(s * x, y, 0.02); a.userData.arm = s; g.add(a); }
  return g;
}
/** Chibi astronaut on the crew's own voxel grid (1/16 m, ~26 voxels tall): big rounded helmet, glossy visor, small white
 *  suit with coloured trim (the suit unlock recolours the trim), chest panel, backpack, swinging arms. */
function astronaut(trim, visor, material) {
  const U = 1 / 16, WHITE = 0xf4f5fa, SHADE = 0xdfe3ec, GREY = 0xb9c0cf, SOLE = 0x4a4f5e;
  const hi = shade(visor, 2.2) & 0xffffff, rim = 0x9aa3b5;
  const v = new Vox(U);
  const F = (i0, i1, j0, j1, k0, k1, c) => v.fill(i0, i1, j0, j1, k0, k1, c);
  // boots + legs
  for (const [a, b] of [[-4, -1], [1, 4]]) { F(a, b, 0, 1, -2, 3, SOLE); F(a, b, 1, 2, -2, 3, GREY); F(a, b, 2, 5, -1, 2, WHITE); F(a, b, 4, 5, -1, 2, SHADE); }
  // torso, belt, chest panel with buttons
  F(-4, 4, 5, 11, -2, 2, WHITE); F(-4, 4, 5, 6, -2, 2, trim);
  F(-2, 2, 7, 10, 2, 3, SHADE); v.set(-2, 8, 2, 0xe63946); v.set(-1, 8, 2, 0x3a86ff); v.set(0, 8, 2, 0xffd166); v.set(1, 9, 2, 0x2ec4b6);
  // backpack with a trim stripe
  F(-3, 3, 5, 11, -4, -2, SHADE); F(-3, 3, 9, 10, -4, -2, trim);
  // helmet: a 12×11×10 block with bevelled edges
  for (let i = -6; i < 6; i++) for (let j = 11; j < 22; j++) for (let k = -5; k < 5; k++) {
    const ei = i === -6 || i === 5, ek = k === -5 || k === 4, top = j === 21, bot = j === 11;
    if ((ei && ek) || (top && (ei || ek)) || (bot && (ei || ek))) continue;
    v.set(i, j, k, j === 11 ? trim : WHITE);
  }
  F(-5, 5, 12, 20, 5, 6, rim);                                   // visor rim
  F(-4, 4, 13, 19, 5, 6, visor);                                 // visor
  v.set(-3, 17, 5, hi); v.set(-2, 17, 5, hi); v.set(-3, 16, 5, hi); v.set(2, 14, 5, shade(visor, 1.5)); // glossy highlights
  F(-7, -6, 14, 18, -2, 2, trim); F(6, 7, 14, 18, -2, 2, trim);  // ear pieces
  F(3, 4, 22, 25, 0, 1, GREY);                                   // antenna
  const tip = new Vox(U).fill(3, 4, 25, 26, 0, 1, trim);
  const g = new THREE.Group();
  g.add(v.mesh(material));
  for (const sgn of [-1, 1]) { // arms hang from the shoulder so they can swing and lift
    const a = new Vox(U).fill(-1, 1, -5, 0, -1, 2, WHITE).fill(-1, 1, -6, -5, -1, 2, trim).mesh(material);
    a.position.set(sgn * 5 * U, 11 * U, 0); a.userData.arm = sgn; g.add(a);
  }
  g.add(tip.mesh(glowMat));
  return g;
}
function glorp(tint, material) {
  const green = tint ?? 0x7bd84a;
  const v = new Vox()
    .ell(0, 0.62, 0, 0.5, 0.6, 0.47, green)
    .ell(0, 0.86, 0.36, 0.22, 0.22, 0.14, 0xffffff)
    .box(0, 0.86, 0.5, 0.14, 0.14, 0.08, 0x1b1b3a)
    .ring(0, 0.3, 0, 0.48, 0.07, 0xff8a3d)                                                           // tool belt
    .box(-0.2, 1.3, 0, 0.1, 0.3, 0.1, 0x5aa832).box(0.2, 1.3, 0, 0.1, 0.3, 0.1, 0x5aa832);           // antennae
  const tips = new Vox().box(-0.24, 1.5, 0, 0.16, 0.16, 0.16, 0xc6ff8f).box(0.24, 1.5, 0, 0.16, 0.16, 0.16, 0xc6ff8f);
  const g = withArms(v.mesh(material), [[-1, 0.55, 0.78, 0.36, green, shade(green, 0.8)], [1, 0.55, 0.78, 0.36, green, shade(green, 0.8)]], material);
  g.add(tips.mesh(glowMat));
  return g;
}
function zibble(tint, material) {
  const purple = tint ?? 0xa66cff;
  const v = new Vox()
    .box(0, 0.48, 0, 0.56, 0.7, 0.5, 0x7d45d9)
    .box(0, 0.56, 0.27, 0.34, 0.18, 0.06, 0xffd166)
    .ell(0, 1.16, 0, 0.48, 0.38, 0.42, purple);
  for (const [x, y] of [[-0.2, 1.2], [0, 1.32], [0.2, 1.2]]) v.box(x, y, 0.36, 0.14, 0.14, 0.1, 0xffffff).box(x, y, 0.42, 0.08, 0.08, 0.06, 0x1b1b3a);
  v.box(-0.18, 1.62, 0, 0.1, 0.3, 0.1, 0x7d45d9).box(0.18, 1.62, 0, 0.1, 0.3, 0.1, 0x7d45d9);
  const tips = new Vox().box(-0.24, 1.84, 0, 0.16, 0.16, 0.16, 0xffd166).box(0.24, 1.84, 0, 0.16, 0.16, 0.16, 0xffd166);
  const g = withArms(v.mesh(material), [[-1, 0.4, 0.78, 0.36, purple, 0x7d45d9], [1, 0.4, 0.78, 0.36, purple, 0x7d45d9]], material);
  g.add(tips.mesh(glowMat));
  return g;
}

/** soft round contact shadow under every mover (one shared texture) */
const blobTex = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  r.addColorStop(0, 'rgba(20,14,8,.55)'); r.addColorStop(0.6, 'rgba(20,14,8,.25)'); r.addColorStop(1, 'rgba(20,14,8,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
function blobShadow() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), blobMat);
  m.rotation.x = -Math.PI / 2; m.position.y = 0.02; m.renderOrder = 1; m.userData.blob = true;
  return m;
}

function rosterMover(char) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  attachModel(body, `/models/chars/${char}.glb`);
  root.add(body);
  root.userData.body = body;
  root.add(blobShadow());
  return root;
}

export function makeMover(char, suit = null) {
  if (rosterEntry(char)) return rosterMover(char);
  const material = voxMat.clone(); // own copy: knocked-out movers fade without fading everyone
  const g = { nova: () => astronaut(suit ?? 0xff8a3d, 0x1d2b6b, material), cosmo: () => astronaut(suit ?? 0x2ec4b6, 0xe0a526, material), glorp: () => glorp(suit, material), zibble: () => zibble(suit, material) }[char]?.()
    || astronaut(suit ?? 0xff8a3d, 0x1d2b6b, material);
  const root = new THREE.Group();
  const glow = glowMat.clone();
  g.traverse(o => { if (o.material === glowMat) o.material = glow; });
  root.add(g);
  root.userData.body = g;
  root.add(blobShadow());
  return root;
}

// ---------- items ----------
const QUILT = (x, y, z) => ((Math.round(x / VS) + Math.round(z / VS) + Math.round(y / VS)) & 3) === 0 ? 0x6f95ff : 0x2f5fd0;
function boxColour(type, w, h, d) {
  const t = ITEM_TYPES[type], base = t.color;
  if (type === 'standard') return (x, y, z) => (Math.abs(x) < 0.1 && (y > h - VS || Math.abs(z) > d / 2 - VS)) ? 0xe8d6a8 : (Math.abs(z) > d / 2 - VS && Math.abs(x - 0.25) < 0.1 && Math.abs(y - h * 0.55) < 0.1) ? 0xffd166 : base;
  if (type === 'heavy') return (x, y, z) => (y < 0.25 && y > 0.1) ? ((Math.round((x + y) / VS) & 1) ? 0xffdd57 : 0x1b1b24) // hazard band on the sides
    : (y > h - VS && Math.abs(x) < 0.25 && Math.abs(z) < 0.25) ? ((Math.round((x + z) / VS) & 1) ? 0xffdd57 : 0x1b1b24) : base; // and a hazard square on top (seen from above)
  if (type === 'fragile') return (x, y, z) => (Math.abs(z) > d / 2 - VS && Math.abs(x) < 0.12 && y > h * 0.35 && y < h * 0.75) ? 0xe63946 : (y > h * 0.8 && y < h * 0.9) ? 0xe63946 : base;
  return (x, y, z) => ((Math.round(x / VS) & 3) === 0 ? shade(base, 0.85) : base);
}

// ---------- moving boxes: plain cardboard, tape across the top; fragile = a broken wine glass, heavy = an anvil, standard = nothing ----------
const BROKEN_GLASS = [ // printed in red, 11×12 pixels
  'XXXXXXXXXXX',
  'X....X....X',
  'X...X.....X',
  '.X...X...X.',
  '.X..X....X.',
  '..X..X..X..',
  '...XXXXX...',
  '.....X.....',
  '.....X.....',
  '.....X.....',
  '...XXXXX...',
  '..XXXXXXX..',
];
const ANVIL = [ // printed in charcoal, 12×7 pixels
  'XXXXXXXXXXXX',
  '.XXXXXXXXXXX',
  '...XXXXXXXX.',
  '.....XXXX...',
  '.....XXXX...',
  '...XXXXXXXX.',
  '..XXXXXXXXXX',
];
const CARD = [0xc8955a, 0xc28f55, 0xcd9a60], TAPE = 0xe6c690, SEAM = 0xa87842;
/** A closed moving box w×h×d (metres), base centred on the origin. Returns a Group with a single mesh. */
function cardboardBox(type, w, h, d) {
  const b = new Batch(), v = new Vox();
  v.box(0, h / 2, 0, w, h, d, (x, y, z) => {
    if (y > h - VS && Math.abs(z) < 0.09) return TAPE;                                   // tape along the top
    if (y > h - VS && Math.abs(x) < 0.03) return SEAM;                                    // where the flaps meet
    if (Math.abs(z) > d / 2 - VS && y > h - 0.16 && Math.abs(x) < 0.09) return TAPE;     // tape running down the front and back
    return CARD[(Math.round(x / VS) + Math.round(y / VS) * 3 + Math.round(z / VS) * 5 & 7) === 0 ? 1 : 0];
  });
  v.into(b);
  const art = type === 'fragile' ? [BROKEN_GLASS, 0xc0392b] : type === 'heavy' ? [ANVIL, 0x2b241e] : null;
  if (art) {
    const [mask, col] = art, P = 0.035, rows = mask.length, cols = mask[0].length, dv = new Vox(P);
    const top = Math.round(h / P), front = Math.round((d / 2) / P);
    mask.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== 'X') return;
      const i = c - Math.floor(cols / 2);
      dv.set(i, top, Math.round(0.24 / P) + r - Math.floor(rows / 2), col);                // on the lid, beside the tape (seen from above)
      dv.set(i, Math.round((h * 0.5) / P) + Math.floor(rows / 2) - r, front, col);       // and on the front
    }));
    dv.into(b, 0, 0, 0, P);
  }
  const g = new THREE.Group(), m = new THREE.Mesh(b.geometry(), voxMat); m.castShadow = m.receiveShadow = true; g.add(m);
  return g;
}

/** a piece in the truck: one block per cell, darker cell edges so the shape reads at a glance */
function loadedPiece(type, wrapped, dims) {
  if (['standard', 'heavy', 'fragile'].includes(type)) return cardboardBox(type, CELL * 0.96, CELL * 0.96, CELL * 0.96); // boxes stay boxes in the truck
  const t = ITEM_TYPES[type];
  const hex = wrapped && t.furniture ? 0x2f5fd0 : t.color;
  const edge = shade(hex, 0.62), s = CELL / 4;
  const v = new Vox(s);
  const cells = dims.cells || (() => { const c = []; for (let x = 0; x < dims.w; x++) for (let y = 0; y < (dims.h || 1); y++) for (let z = 0; z < dims.d; z++) c.push([x, y, z]); return c; })();
  for (const [cx, cy, cz] of cells) {
    const X = -(cz + 0.5 - dims.d / 2) * CELL, Y = cy * CELL + CELL / 2, Z = (cx + 0.5 - dims.w / 2) * CELL;
    v.box(X, Y, Z, CELL, CELL, CELL, (x, y, z) => {
      const e = [(x - X) / CELL, (y - Y) / CELL, (z - Z) / CELL].filter(q => Math.abs(q) > 0.3).length;
      return e >= 2 ? edge : hex;
    });
  }
  const g = new THREE.Group();
  const m = v.mesh(plainMat); g.add(m);
  const l = sprite(t.label.toUpperCase(), { fg: '#fff', stroke: '#000', font: 'bold 40px system-ui' }, [1.6, 0.4]);
  l.position.y = (dims.h || 1) * CELL + 0.1; l.material.depthTest = true; g.add(l);
  return g;
}

/** Two-wheel hand truck. Local +z is the nose (where the boxes sit, away from the mover); the red frame, the wheels and
 *  the black grips are at -z, the end the mover holds. */
function dolly() {
  const steel = 0x9aa3b8, red = 0xe63946, black = 0x1a1a24;
  const v = new Vox().box(0, 0.05, -0.12, 0.8, 0.08, 0.62, steel); // nose plate, running back under the frame
  for (const s of [-1, 1]) {
    v.box(s * 0.32, 0.5, -0.45, 0.08, 0.9, 0.08, red)          // uprights behind the stack
      .cyl(s * 0.44, 0.17, -0.42, 0.17, 0.1, black, 'x')        // wheels at the foot of the frame
      .box(s * 0.32, 0.9, -0.62, 0.11, 0.11, 0.34, black);     // grips at hand height, reaching back to the mover
  }
  v.box(0, 0.45, -0.45, 0.72, 0.08, 0.08, red).box(0, 0.91, -0.45, 0.72, 0.08, 0.08, red);
  const g = new THREE.Group(); g.add(v.mesh()); return g;
}

export function makeItem(type, { wrapped = false, assembled = false, loaded = false, dims = null } = {}) {
  const t = ITEM_TYPES[type];
  if (type === 'dolly') return dolly();
  if (type === 'flatdolly') { // chunky and bright so it's easy to spot: orange deck, teal carpet, big casters
    // 1.3 m long: short enough to swing round a hallway corner (a couch still sticks out past both ends, as it would)
    const v = new Vox().box(0, 0.26, 0, 1.3, 0.16, 1.1, (x) => (Math.round(x / VS) & 3) === 0 ? 0xe06f24 : 0xff8a3d);
    for (const s of [-1, 1]) v.box(0, 0.37, s * 0.44, 1.3, 0.08, 0.18, 0x2ec4b6);
    v.box(-0.6, 0.55, 0, 0.12, 0.5, 1.1, 0xffd166); // push bar
    for (const sx of [-0.5, 0.5]) for (const sz of [-0.42, 0.42]) v.cyl(sx, 0.1, sz, 0.12, 0.12, 0x1a1a24, 'z');
    const g = new THREE.Group(); g.add(v.mesh()); return g;
  }
  if (loaded && dims) return loadedPiece(type, wrapped, dims);
  const g = new THREE.Group();
  // downloaded models (see /credits.html) for the pieces you carry around the house
  // [file, tint, quarter turns, fit [x, z, y]]
  const ASSET = {
    couch: ['couch', null, 2, [3.0, 0.95, 1.0]], bed: ['bed', null, -1, [2.0, 3.0, 1.0]], lamp: ['lamp', 0xff9ad5, 0, [1.4, 0.55, 1.95]],
    desk: ['desk', null, 0, [2.0, 0.95, 1.25]], table: ['table', null, 0, [2.0, 1.1, 0.85]],
  }[type];
  const flatNow = t.needsDisassemble && !assembled;
  if (ASSET && !flatNow) {
    const tint = wrapped && t.furniture ? 0x5b86ff : ASSET[1] ?? null; // pad-wrapped = under a blue moving blanket
    attachModel(g, `/models/items/${ASSET[0]}.glb`, { tint, rot: ASSET[2], fit: ASSET[3] });
    return g;
  }
  if (['standard', 'heavy', 'fragile'].includes(type)) return cardboardBox(type, 0.9, 0.8, 0.9);
  if (!t.furniture || (!assembled && t.needsDisassemble)) {
    const flat = t.needsDisassemble && !assembled;
    const w = t.w * 0.9, h = flat ? 0.3 : 0.8, d = Math.max(0.8, t.d * 0.9);
    g.add(new Vox().box(0, h / 2, 0, w, h, d, wrapped && t.furniture ? QUILT : boxColour(type, w, h, d)).mesh());
    if (type === 'fragile' || type === 'heavy') {
      const l = sprite(type === 'fragile' ? '🍷 FRAGILE' : '⚠ HEAVY', { fg: type === 'fragile' ? '#ff4d5e' : '#ffd166', stroke: '#1b1340', font: 'bold 34px system-ui' }, [0.95, 0.24]);
      l.position.y = 1.0; l.material.depthTest = true; g.add(l);
    }
    if (flat) { const l = sprite('FLAT-PACK ' + t.label.toUpperCase(), { fg: '#fff', stroke: '#000', font: 'bold 30px system-ui', w: 320 }, [1.8, 0.36]); l.position.y = 0.6; g.add(l); }
    return g;
  }
  const W = (hex) => wrapped ? QUILT : hex;
  const v = new Vox();
  let glow = null;
  if (type === 'couch') {
    v.box(0, 0.32, 0, 3.0, 0.4, 0.9, W(t.color)).box(0, 0.78, -0.33, 3.0, 0.56, 0.26, W(t.color));
    for (const s of [-1, 1]) v.box(s * 1.4, 0.5, 0, 0.2, 0.6, 0.9, W(shade(t.color, 0.85)));
    if (!wrapped) { for (const s of [-0.75, 0.75]) v.box(s, 0.6, 0.06, 1.3, 0.14, 0.7, 0x7d97ff); for (const sx of [-1.35, 1.35]) for (const sz of [-0.35, 0.35]) v.box(sx, 0.06, sz, 0.1, 0.12, 0.1, 0x2a2640); }
  } else if (type === 'bed') {
    v.box(0, 0.2, 0, 2.0, 0.3, 3.0, W(0x6b4f8a)).box(0, 0.48, 0, 1.9, 0.26, 2.9, W(0xf4f1ff)).box(0, 0.62, -1.5, 2.0, 0.9, 0.12, W(0x6b4f8a));
    if (!wrapped) v.box(0, 0.64, 0.5, 1.7, 0.08, 1.8, 0xa78bfa).box(0, 0.68, -1.1, 1.5, 0.14, 0.5, 0xffffff);
  } else if (type === 'lamp') {
    v.cyl(-0.45, 0.06, 0, 0.3, 0.12, W(0x444466)).box(-0.45, 0.9, 0, 0.1, 1.7, 0.1, W(0xcccccc)).box(0.05, 1.72, 0, 1.0, 0.1, 0.1, W(0xcccccc));
    if (wrapped) v.cyl(0.55, 1.45, 0, 0.36, 0.42, QUILT, 'y', 0.18);
    else glow = new Vox().cyl(0.55, 1.45, 0, 0.36, 0.42, 0xff9ad5, 'y', 0.18);
  } else if (type === 'dresser') { // three drawers with brass knobs; wrapped = under the blue blanket
    const wood = 0x8b5e3c, dark = 0x6a4429;
    v.box(0, 0.75, 0, 0.9, 1.5, 0.6, W(wood));
    if (!wrapped) {
      v.box(0, 1.52, 0, 0.96, 0.06, 0.66, dark); v.box(0, 0.03, 0, 0.92, 0.06, 0.62, dark);
      for (const y of [0.32, 0.75, 1.18]) { v.box(0, y, 0.31, 0.8, 0.34, 0.04, 0x9c6b45); v.box(-0.18, y, 0.35, 0.08, 0.06, 0.04, 0xe0b23c); v.box(0.18, y, 0.35, 0.08, 0.06, 0.04, 0xe0b23c); }
    }
  } else if (type === 'coffeetable') { // low wooden table with a book and a mug on top
    const wood = 0xa9744a;
    v.box(0, 0.42, 0, 1.8, 0.1, 0.8, wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) v.box(sx * 0.8, 0.2, sz * 0.32, 0.1, 0.4, 0.1, shade(wood, 0.75));
    v.box(0, 0.12, 0, 1.6, 0.04, 0.6, shade(wood, 0.85)); // lower shelf
    v.box(-0.4, 0.5, 0.05, 0.4, 0.06, 0.3, 0x3a7ca5).box(-0.4, 0.55, 0.05, 0.36, 0.04, 0.26, 0xe63946); // books
    v.box(0.45, 0.53, -0.1, 0.12, 0.14, 0.12, 0xf3efe6); // mug
  } else if (type === 'armchair') { // a squashy single seat with fat arms
    const c = t.color;
    v.box(0, 0.3, 0.05, 0.9, 0.34, 0.8, W(c)).box(0, 0.72, -0.32, 0.9, 0.6, 0.22, W(c));
    for (const sx of [-1, 1]) v.box(sx * 0.4, 0.52, 0.02, 0.14, 0.38, 0.78, W(shade(c, 0.85)));
    if (!wrapped) { v.box(0, 0.5, 0.08, 0.62, 0.1, 0.6, 0xe9a46b); for (const sx of [-1, 1]) for (const sz of [-1, 1]) v.box(sx * 0.38, 0.06, sz * 0.32, 0.08, 0.12, 0.08, 0x3a2a1f); }
  } else if (type === 'tv') { // a big flat screen: wide, tall, a few centimetres thin, on a slim two-foot stand
    v.box(-0.6, 0.03, 0, 0.36, 0.06, 0.34, W(0x2b2b33)).box(0.6, 0.03, 0, 0.36, 0.06, 0.34, W(0x2b2b33)); // feet
    v.box(0, 0.62, 0, 1.86, 1.06, 0.1, W(0x1d1b19));                                                        // panel + bezel
    if (!wrapped) glow = new Vox().box(0, 0.63, 0.05, 1.74, 0.94, 0.02, 0x3f7fa8);                           // the screen
  } else if (type === 'bookshelf') { // two-cell tall shelving with rows of coloured books
    const wood = t.color;
    v.box(0, 0.8, -0.2, 0.9, 1.6, 0.06, W(wood));
    for (const sx of [-1, 1]) v.box(sx * 0.42, 0.8, 0, 0.06, 1.6, 0.46, W(wood));
    for (const y of [0.04, 0.55, 1.07, 1.57]) v.box(0, y, 0, 0.9, 0.06, 0.46, W(shade(wood, 0.85)));
    if (!wrapped) { const books = [0xe63946, 0x3a7ca5, 0xe9c46a, 0x6b9e8a, 0xb5654a, 0xf4ead8]; [0.3, 0.82, 1.33].forEach((y, r) => { for (let i = 0; i < 6; i++) v.box(-0.32 + i * 0.13, y, 0.02, 0.1, 0.4 - ((i + r) % 3) * 0.06, 0.32, books[(i + r * 2) % books.length]); }); }
  } else { // desk / table, assembled
    const top = type === 'desk' ? [2.0, 0.12, 0.9] : [2.0, 0.1, 1.1];
    v.box(0, 0.82, 0, ...top, t.color);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) v.box(sx * 0.9, 0.4, sz * (top[2] / 2 - 0.08), 0.1, 0.8, 0.1, shade(t.color, 0.8));
    if (type === 'desk') { v.box(-0.4, 0.95, -0.15, 0.1, 0.12, 0.1, 0x222244); glow = new Vox().box(-0.4, 1.12, -0.15, 0.5, 0.36, 0.1, 0x3355ff); }
  }
  g.add(v.mesh());
  if (glow) g.add(glow.mesh(glowMat));
  return g;
}

/**
 * Built-in fixtures (they stay with the house). Modelled facing out from the wall they back onto: u runs along the wall
 * (centre 0), v out from the wall (0 = against it, d = front), y up. `side` says which wall, so the model turns to face
 * into the room.
 */
function drawFixture(b, p) {
  const { side, w, d } = p, U = 0.25;
  const put = (u, y0, v0, wu, h, dv, hex) => { // a box: centred at u along the wall, from v0 out to v0 + dv, y0 up to y0 + h
    const uc = u, vc = v0 + dv / 2 - d / 2; // v measured from the fixture centre
    let cx, cz, sx, sz;
    if (side === 'z0') { cx = p.x + uc; cz = p.z + vc; sx = wu; sz = dv; }
    else if (side === 'z1') { cx = p.x - uc; cz = p.z - vc; sx = wu; sz = dv; }
    else if (side === 'x0') { cx = p.x + vc; cz = p.z - uc; sx = dv; sz = wu; }
    else { cx = p.x - vc; cz = p.z + uc; sx = dv; sz = wu; }
    b.cbox(cx, y0 + h / 2, cz, sx, h, sz, hex, U);
  };
  const W = 0xf2efe8, STEEL = 0xc9ccd1, DARK = 0x2b2b33, WOOD = 0x8a5a3a, LIGHT = 0xb07d4f;
  switch (p.type) {
    case 'fridge': put(0, 0, 0, w, 1.95, d, W); put(0, 1.25, d, w * 0.92, 0.02, 0.02, 0xdedad2); put(w * 0.36, 1.35, d, 0.05, 0.4, 0.04, STEEL); put(w * 0.36, 0.6, d, 0.05, 0.4, 0.04, STEEL); break;
    case 'stove': put(0, 0, 0, w, 0.9, d, W); put(0, 0.9, 0, w, 0.04, d, DARK); for (const su of [-0.2, 0.2]) for (const sv of [0.2, 0.5]) put(su, 0.94, sv, 0.24, 0.02, 0.2, 0x4a4a52); put(0, 0.25, d, w * 0.8, 0.4, 0.02, 0x3a3a42); put(0, 0.9, 0, w, 0.35, 0.06, W); break;
    case 'tub': put(0, 0, 0, w, 0.55, d, W); put(0, 0.45, 0.08, w - 0.16, 0.1, d - 0.16, 0x9fd3dc); put(-w / 2 + 0.15, 0.55, 0.05, 0.08, 0.25, 0.08, STEEL); break;
    case 'toilet': put(0, 0, 0, w * 0.8, 0.75, 0.2, W); put(0, 0, 0.2, w * 0.7, 0.4, d - 0.2, W); put(0, 0.4, 0.18, w * 0.75, 0.05, d - 0.16, 0xe4e0d8); break;
    case 'sink': put(0, 0, 0.1, 0.2, 0.75, 0.2, W); put(0, 0.75, 0, w, 0.12, d, W); put(0, 0.86, 0.08, w - 0.2, 0.02, d - 0.18, 0x9fd3dc); put(0, 0.87, 0, 0.06, 0.18, 0.08, STEEL); put(0, 1.05, 0, w * 0.8, 0.75, 0.03, 0xbfd7d6); break;
    case 'washer': case 'dryer': put(0, 0, 0, w, 0.9, d, W); put(0, 0.42, d, 0.44, 0.44, 0.02, p.type === 'washer' ? 0x7fb6c8 : 0x9a9aa4); put(0, 0.8, d - 0.02, w * 0.8, 0.06, 0.03, 0xdcd8cf); break;
    case 'workbench': put(0, 0.85, 0, w, 0.08, d, LIGHT); for (const su of [-w / 2 + 0.08, w / 2 - 0.08]) put(su, 0, 0.1, 0.08, 0.85, d - 0.2, WOOD); put(0, 0.3, 0.1, w - 0.2, 0.05, d - 0.2, WOOD); put(0, 0.93, 0.1, w * 0.9, 0.9, 0.04, 0xa89070); put(-0.4, 0.93, 0.25, 0.35, 0.14, 0.2, 0xe63946); put(0.45, 0.93, 0.3, 0.08, 0.05, 0.3, STEEL); break;
    case 'bookcase': case 'shelving': {
      const h = p.type === 'bookcase' ? 1.85 : 1.7, frame = p.type === 'bookcase' ? WOOD : 0x8f949c;
      put(0, 0, 0, w, h, 0.05, frame); for (const su of [-w / 2 + 0.03, w / 2 - 0.03]) put(su, 0, 0, 0.06, h, d, frame);
      for (let i = 0; i < 4; i++) put(0, 0.02 + i * (h - 0.05) / 3, 0, w, 0.04, d, frame);
      const fill = p.type === 'bookcase' ? [0xe63946, 0x3a7ca5, 0xe9c46a, 0x6b9e8a, 0xb5654a] : [0xc19a6b, 0xa9844f, 0xd2b48c];
      for (let r = 0; r < 3; r++) for (let i = 0; i < 5; i++) put(-w / 2 + 0.15 + i * (w - 0.3) / 4.4, 0.06 + r * (h - 0.05) / 3, 0.05, 0.16, p.type === 'bookcase' ? 0.38 - (i % 3) * 0.05 : 0.3, d - 0.1, fill[(i + r) % fill.length]);
      break;
    }
    case 'fireplace': put(0, 0, 0, w, 1.15, d, 0xb5654a); put(0, 1.15, 0, w + 0.15, 0.08, d + 0.08, 0x6b4a33); put(0, 0, d - 0.05, w * 0.5, 0.6, 0.06, 0x1d1b19); put(0, 0.05, d - 0.02, w * 0.36, 0.2, 0.05, 0xff8a3d); put(0, 0, d, w + 0.2, 0.06, 0.3, 0x7a6a5a); break;
    case 'sideboard': put(0, 0.08, 0, w, 0.75, d, WOOD); for (const su of [-w / 3, 0, w / 3]) put(su, 0.3, d, w / 3 - 0.06, 0.4, 0.02, LIGHT); put(-w / 2 + 0.08, 0, 0.05, 0.06, 0.08, 0.06, 0x3a2a1f); put(w / 2 - 0.08, 0, 0.05, 0.06, 0.08, 0.06, 0x3a2a1f); put(0.3, 0.83, 0.15, 0.2, 0.3, 0.2, 0xe9c46a); break;
    case 'nightstand': put(0, 0, 0, w, 0.55, d, WOOD); put(0, 0.28, d, w * 0.8, 0.14, 0.02, LIGHT); put(0, 0.55, 0.15, 0.16, 0.06, 0.16, 0xd9b26a); put(0, 0.61, 0.17, 0.04, 0.2, 0.04, 0x3a2a1f); put(0, 0.8, 0.12, 0.26, 0.16, 0.26, 0xf4ead8); break;
    case 'toychest': put(0, 0, 0, w, 0.5, d, 0x3f6f8a); put(0, 0.5, 0, w + 0.04, 0.06, d + 0.04, 0xe9c46a); put(0, 0.2, d, 0.24, 0.16, 0.02, 0xe63946); put(-0.25, 0.56, 0.2, 0.16, 0.16, 0.16, 0xe63946); break;
    default: put(0, 0, 0, w, 0.8, d, LIGHT);
  }
}

export function makeCat() {
  const fur = 0xc9c3e6;
  const v = new Vox().ell(0, 0.22, 0, 0.2, 0.18, 0.3, fur).box(0, 0.36, 0.28, 0.3, 0.26, 0.26, fur)
    .box(-0.1, 0.52, 0.28, 0.1, 0.1, 0.1, fur).box(0.1, 0.52, 0.28, 0.1, 0.1, 0.1, fur)
    .box(-0.07, 0.38, 0.42, 0.06, 0.06, 0.04, 0x1b1b3a).box(0.07, 0.38, 0.42, 0.06, 0.06, 0.04, 0x1b1b3a)
    .box(0, 0.36, -0.36, 0.08, 0.08, 0.3, fur);
  const g = new THREE.Group(); g.add(v.mesh());
  g.add(new Vox().ring(0, 0.66, 0.28, 0.16, 0.04, 0xffd166).mesh(glowMat)); // space-cat halo
  return g;
}

// ---------- world ----------
export function buildWorld(scene) {
  const s = scene.scene, b = new Batch();
  b.box(-95, -0.05, -45, 75, 0, 45, 0x4a4038, 2);                                   // moon ground (warm regolith), 2 m blocks
  for (let i = 0; i < 26; i++) { // craters: sunken dark squares
    const r = 0.6 + Math.random() * 1.8; let x, z;
    do { x = -70 + Math.random() * 110; z = -40 + Math.random() * 80; } while (x > -46 && x < 26 && z > -17 && z < 17);
    b.box(x - r, 0, z - r, x + r, 0.03, z + r, 0x3a322b, 0.5);
  }
  const ground = new THREE.Mesh(b.geometry(), voxMat); ground.receiveShadow = true; s.add(ground);
  // warm night sky: a dome from deep charcoal overhead to an amber glow at the horizon, and a pale moon
  const dome = new THREE.SphereGeometry(160, 24, 12), col = [], top = new THREE.Color(0x0e0a08), mid = new THREE.Color(0x2a1d15), hor = new THREE.Color(0x6a4128);
  for (let i = 0; i < dome.attributes.position.count; i++) {
    const t = Math.max(0, dome.attributes.position.getY(i) / 160), c = t < 0.18 ? hor.clone().lerp(mid, t / 0.18) : mid.clone().lerp(top, Math.min(1, (t - 0.18) / 0.5));
    col.push(c.r, c.g, c.b);
  }
  dome.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  s.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  const moon = new THREE.Mesh(new THREE.SphereGeometry(7, 20, 14), new THREE.MeshBasicMaterial({ color: 0xf2e6c8, fog: false }));
  moon.position.set(-60, 70, -120); s.add(moon);
  const starGeo = new THREE.BufferGeometry(), pts = [];
  for (let i = 0; i < 900; i++) pts.push((Math.random() - 0.5) * 200, 30 + Math.random() * 60, (Math.random() - 0.5) * 200);
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  s.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, sizeAttenuation: true })));
  const planet = new Vox(0.8).ell(0, 0, 0, 8, 8, 8, (x, y) => (Math.floor(y / 1.6) & 1) ? 0xff8a3d : 0xe2702a).mesh(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x552200 }));
  planet.castShadow = planet.receiveShadow = false;
  planet.position.set(-30, 25, -60); s.add(planet);
  scene.buildTruck();
}

export const WALL_H = 2.4; // tall enough to hide what's in the next room
const SLAB = 0.3;          // upstairs floors are this thick
/** rectangles of [x0,z0,x1,z1] with the holes cut out (stairwell openings) */
export function cutHoles(rect, holes) {
  let parts = [rect];
  for (const [hx0, hz0, hx1, hz1] of holes) {
    const next = [];
    for (const [x0, z0, x1, z1] of parts) {
      if (hx1 <= x0 || hx0 >= x1 || hz1 <= z0 || hz0 >= z1) { next.push([x0, z0, x1, z1]); continue; }
      if (hz0 > z0) next.push([x0, z0, x1, hz0]);
      if (hz1 < z1) next.push([x0, hz1, x1, z1]);
      const a = Math.max(z0, hz0), c = Math.min(z1, hz1);
      if (hx0 > x0) next.push([x0, a, hx0, c]);
      if (hx1 < x1) next.push([hx1, a, x1, c]);
    }
    parts = next;
  }
  return parts.filter(([x0, z0, x1, z1]) => x1 - x0 > 0.01 && z1 - z0 > 0.01);
}

/** Windows on the outside walls (lit warm at night), frames + lintels on every doorway, a porch lamp by the front door,
 *  hedges along the front, and something on the far wall of each room (the wall the camera looks at). All of it goes into
 *  the floor's existing batches, so the house stays a couple of draw calls per floor. */
function houseDetail(b, gb, level, k, rng) {
  const DZ = FLOOR_DZ * k, h = level.house, X0 = h.x0, X1 = h.x1, Z0 = h.z0 + DZ, Z1 = h.z1 + DZ, HT = 0.2;
  const TRIM = 0xf4ead8, WOOD = 0xb88a5a, GLASS = 0xffd9a0, onK = (z) => level.floorOf(z) === k;
  const fd = level.frontDoor;
  // doorways: two jambs and a lintel (the wall above the opening), in warm wood
  const doors = (level.doors || []).filter(d => onK(d.vertical ? d.c : d.at));
  for (const d of doors) {
    const a0 = d.c - d.w / 2, a1 = d.c + d.w / 2, j = 0.07;
    if (d.vertical) {
      b.box(d.at - HT - 0.01, 2.1, a0, d.at + HT + 0.01, WALL_H, a1, TRIM, 0.42);
      b.box(d.at - HT - 0.03, 2.02, a0, d.at + HT + 0.03, 2.1, a1, WOOD, 0.42);
      for (const z of [a0, a1 - j]) b.box(d.at - HT - 0.03, 0, z, d.at + HT + 0.03, 2.1, z + j, WOOD, 0.42);
    } else {
      b.box(a0, 2.1, d.at - HT - 0.01, a1, WALL_H, d.at + HT + 0.01, TRIM, 0.42);
      b.box(a0, 2.02, d.at - HT - 0.03, a1, 2.1, d.at + HT + 0.03, WOOD, 0.42);
      for (const x of [a0, a1 - j]) b.box(x, 0, d.at - HT - 0.03, x + j, 2.1, d.at + HT + 0.03, WOOD, 0.42);
    }
  }
  // windows: one per room on each outside wall it touches (none where the front door is), glass glowing through the wall
  const win = (alongX, line, mid, w) => {
    const y0 = 0.95, y1 = 2.0, e = 0.03, t0 = line - HT - e, t1 = line + HT + e;
    const B = (a, c, y, yy, p, q, col, batch = b) => alongX ? batch.box(a, y, p, c, yy, q, col, 0.42) : batch.box(p, y, a, q, yy, c, col, 0.42);
    B(mid - w / 2, mid + w / 2, y0, y1, line - HT - 0.005, line + HT + 0.005, GLASS, gb);              // lit glass (both faces)
    for (const [p, q] of [[t0, line - HT], [line + HT, t1]]) {                                          // frame on each face
      B(mid - w / 2 - 0.08, mid + w / 2 + 0.08, y1, y1 + 0.08, p, q, TRIM);
      B(mid - w / 2 - 0.12, mid + w / 2 + 0.12, y0 - 0.1, y0, p - (p < line ? 0.06 : 0), q + (p < line ? 0 : 0.06), TRIM); // sill
      B(mid - w / 2 - 0.08, mid - w / 2, y0, y1, p, q, TRIM); B(mid + w / 2, mid + w / 2 + 0.08, y0, y1, p, q, TRIM);
      B(mid - 0.03, mid + 0.03, y0, y1, p, q, TRIM); B(mid - w / 2, mid + w / 2, (y0 + y1) / 2 - 0.03, (y0 + y1) / 2 + 0.03, p, q, TRIM); // mullions
    }
  };
  // windows on every outside wall: a room edge with no room beyond it (houses come in L / T / notched shapes, so that's
  // not just the edges of the bounding box). Checked across the window's whole width.
  const onFloor = level.rooms.filter(r => (r.storey || 0) === k);
  const outside = (x, z) => !onFloor.some(q => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1);
  const outsideAlong = (vertical, line, mid, w, dir) => [-w / 2, 0, w / 2].every(o => vertical ? outside(line + dir * 0.4, mid + o) : outside(mid + o, line + dir * 0.4));
  for (const r of onFloor) {
    const lenZ = r.z1 - r.z0, lenX = r.x1 - r.x0, wz = Math.min(2.2, lenZ * 0.32), wx = Math.min(2.2, lenX * 0.32), mz = (r.z0 + r.z1) / 2, mx = (r.x0 + r.x1) / 2;
    if (lenZ >= 3.2 && r.role !== 'stairs' && outsideAlong(true, r.x0, mz, wz, -1)) win(false, r.x0, mz, wz);
    if (lenZ >= 3.2 && outsideAlong(true, r.x1, mz, wz, 1)) {
      if (!(k === 0 && Math.abs(r.x1 - fd.x) < 0.01 && Math.abs(mz - fd.z) < wz / 2 + 2.4)) win(false, r.x1, mz, wz);
      else if (k === 0) { const alt = fd.z + (fd.z - r.z0 > r.z1 - fd.z ? -1 : 1) * (wz / 2 + 2.6); if (alt - wz / 2 > r.z0 + 0.5 && alt + wz / 2 < r.z1 - 0.5) win(false, r.x1, alt, wz); }
    }
    if (lenX >= 3.2 && r.role !== 'hall' && outsideAlong(false, r.z0, mx, wx, -1)) win(true, r.z0, mx, wx);
    if (lenX >= 3.2 && r.role !== 'hall' && outsideAlong(false, r.z1, mx, wx, 1)) win(true, r.z1, mx, wx);
  }
  if (k === 0) { // porch: lamps either side of the front door, hedges along the front of the house (not across the path)
    for (const s of [-1, 1]) { b.box(X1 + HT, 1.7, fd.z + s * 1.95 - 0.12, X1 + HT + 0.14, 2.15, fd.z + s * 1.95 + 0.12, 0x3a2f26, 0.42); gb.box(X1 + HT + 0.02, 1.78, fd.z + s * 1.95 - 0.08, X1 + HT + 0.12, 2.05, fd.z + s * 1.95 + 0.08, 0xffd08a, 0.42); }
    const hv = new Vox(0.25), HG = [0x3f7a3a, 0x4a8a42, 0x377034, 0x52934a];
    for (let z = h.z0 + 0.3; z < h.z1 - 0.3; z += 0.25) {
      if (Math.abs(z - fd.z) < 2.3) continue;
      for (let x = X1 + 0.45; x < X1 + 1.15; x += 0.25) for (let y = 0; y < 0.85; y += 0.25) hv.set(Math.round(x / 0.25), Math.round(y / 0.25), Math.round(z / 0.25), HG[Math.floor(rng() * HG.length)]);
    }
    hv.into(b, 0, 0, 0);
  }
  // decor on the far (north) wall of each room, where the camera looks: chosen by room type, clear of doorways and windows
  const DECOR = { living: ['tv', 'picture'], bedroom: ['picture', 'picture'], kids: ['picture', 'shelf'], office: ['shelf', 'picture'], den: ['tv', 'shelf'], play: ['picture', 'shelf'],
    dining: ['picture', 'picture'], kitchen: ['clock', 'picture'], bathroom: ['mirror'], laundry: ['shelf'], storage: ['shelf'], garage: ['tools'] };
  const ART = [[0xc8734f, 0xe9c46a], [0x6b9e8a, 0xf4ead8], [0x8a5a44, 0xd9b26a], [0x3f6f8a, 0xe0c9a0], [0xb5654a, 0x8a9a6b]];
  for (const r of level.rooms.filter(r => (r.storey || 0) === k)) {
    const list = DECOR[r.kind] || DECOR[r.role]; if (!list) continue;
    const fz = r.z0 + HT, blocked = (x, half) => doors.some(d => !d.vertical && Math.abs(d.at - r.z0) < 0.05 && x + half > d.c - d.w / 2 - 0.3 && x - half < d.c + d.w / 2 + 0.3)
      || (outside((r.x0 + r.x1) / 2, r.z0 - 0.4) && Math.abs(x - (r.x0 + r.x1) / 2) < Math.min(2.2, (r.x1 - r.x0) * 0.32) / 2 + half + 0.3); // keep clear of that wall's window
    const spots = [0.27, 0.73].map(f => r.x0 + (r.x1 - r.x0) * f);
    list.forEach((kind, i) => {
      const x = spots[i % 2]; if (!x || blocked(x, 0.9)) return;
      if ((level.fixtures || []).some(f => Math.abs(f.z0 - fz) < 1.2 && x + 0.9 > f.x0 && x - 0.9 < f.x1)) return; // a fridge / bookcase is against that bit of wall
      if (kind === 'picture') { const [c1, c2] = ART[Math.floor(rng() * ART.length)]; b.box(x - 0.55, 1.25, fz, x + 0.55, 2.05, fz + 0.05, 0x5c3a22, 0.42); b.box(x - 0.47, 1.33, fz + 0.05, x + 0.47, 1.97, fz + 0.07, c1, 0.42); b.box(x - 0.47, 1.33, fz + 0.05, x + 0.05, 1.7, fz + 0.075, c2, 0.42); }
      else if (kind === 'tv') { b.box(x - 0.85, 1.15, fz, x + 0.85, 2.1, fz + 0.06, 0x1d1b19, 0.42); gb.box(x - 0.78, 1.22, fz + 0.06, x + 0.78, 2.03, fz + 0.07, 0x2f4a5a, 0.42); }
      else if (kind === 'mirror') { b.box(x - 0.45, 1.15, fz, x + 0.45, 2.15, fz + 0.05, 0xd9b26a, 0.42); gb.box(x - 0.38, 1.22, fz + 0.05, x + 0.38, 2.08, fz + 0.06, 0xbfd7d6, 0.42); }
      else if (kind === 'clock') { b.box(x - 0.3, 1.6, fz, x + 0.3, 2.2, fz + 0.05, 0x3a2f26, 0.42); b.box(x - 0.24, 1.66, fz + 0.05, x + 0.24, 2.14, fz + 0.06, 0xf4ead8, 0.42); b.box(x - 0.02, 1.9, fz + 0.06, x + 0.02, 2.08, fz + 0.07, 0x1d1b19, 0.42); b.box(x - 0.02, 1.88, fz + 0.06, x + 0.14, 1.92, fz + 0.07, 0x1d1b19, 0.42); }
      else if (kind === 'shelf' || kind === 'tools') {
        for (const y of kind === 'shelf' ? [1.35, 1.85] : [1.3]) {
          b.box(x - 0.75, y - 0.05, fz, x + 0.75, y, fz + 0.28, 0x8a5a3a, 0.42);
          let bx = x - 0.7; while (bx < x + 0.65) { const bw = 0.08 + rng() * 0.08, bh = 0.22 + rng() * 0.18; b.box(bx, y, fz + 0.04, bx + bw, y + bh, fz + 0.24, [0xc8734f, 0x6b9e8a, 0xe9c46a, 0x8a5a44, 0x3f6f8a][Math.floor(rng() * 5)], 0.42); bx += bw + 0.02; }
        }
        if (kind === 'tools') b.box(x - 0.8, 1.45, fz, x + 0.8, 2.1, fz + 0.03, 0xa89070, 0.42);
      }
    });
  }
}

export function buildHouse(scene, level) {
  const g = new THREE.Group();
  scene.house = g; scene.level = level; scene.storeys = [];
  const n = level.floors || 1, H = STOREY_H, DZ = FLOOR_DZ;
  const rng = mulberryFor((level.seed ?? 7) * 31 + 5);
  const roomAt = (x, z) => level.rooms.find(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  const OUT = { wall: 0xe3cfae, skirt: 0x7a5a3a };
  const fd = level.frontDoor;
  const pots = [], foods = [];
  for (let k = 0; k < n; k++) {
    // each floor is built in the server's own coordinates (its strip of the map), then lifted into place over the ground floor
    const sg = new THREE.Group(); sg.position.set(0, k * H, -DZ * k); g.add(sg); scene.storeys.push(sg);
    const onK = (z) => level.floorOf(z) === k;
    const b = new Batch(), fb = new Batch(), gb = new Batch(); // gb: things that glow (lit windows, lamps, screens)
    if (k === 0) {
      const walkLen = Math.max(0.1, 9.4 - fd.x);
      b.box(fd.x, 0, fd.z - 1.5, fd.x + walkLen, 0.03, fd.z + 1.5, 0x8a7f70, 0.75);                    // walkway
      const dz = Math.abs(fd.z) + 2.6;
      b.box(5.4, 0, -dz, 9.4, 0.025, dz, 0x6e665b, 0.75);                                              // driveway
    }
    const holes = level.stairs.filter(st => st.b === k - 1).map(st => [st.x0, Math.min(st.zl, st.zh) + DZ * k, st.x1, Math.max(st.zl, st.zh) + DZ * k]);
    for (const r of level.rooms.filter(r => (r.storey || 0) === k)) {
      for (const [x0, z0, x1, z1] of cutHoles([r.x0, r.z0, r.x1, r.z1], holes)) {
        b.box(x0, k ? -SLAB : 0, z0, x1, 0.035, z1, k ? 0x6b5a48 : 0x3a2f26, 1);                      // upstairs: a real slab under the floor
        floorPattern(fb, { ...r, x0, z0, x1, z1 }, rng);
      }
    }
    // a smaller upper floor: a flat roof over each room of the floor below that has nothing on top of it (seen when you're up here)
    if (k) for (const r of level.rooms.filter(q => (q.storey || 0) === k - 1)) {
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2 + DZ;
      if (level.rooms.some(q => q.storey === k && cx > q.x0 && cx < q.x1 && cz > q.z0 && cz < q.z1)) continue;
      b.box(r.x0 - 0.2, -0.44, r.z0 + DZ - 0.2, r.x1 + 0.2, -0.36, r.z1 + DZ + 0.2, 0x6e4a3a, 0.5);   // roof deck, resting on the walls
      b.box(r.x0 - 0.15, -0.36, r.z0 + DZ - 0.15, r.x1 + 0.15, -0.3, r.z1 + DZ + 0.15, 0x8a5a44, 0.5); // membrane
    }
    // walls: split down their thickness so each side shows the colour + skirting of the room it faces (warm siding outside)
    for (const w of level.houseWalls.filter(w => onK((w.z0 + w.z1) / 2))) {
      if (w.rail) continue; // banisters are drawn with the stairs
      const alongX = (w.x1 - w.x0) >= (w.z1 - w.z0), len = alongX ? w.x1 - w.x0 : w.z1 - w.z0;
      const nn = Math.max(1, Math.round(len)), step = len / nn;
      for (let i = 0; i < nn; i++) {
        const a0 = (alongX ? w.x0 : w.z0) + i * step, a1 = a0 + step, mid = (a0 + a1) / 2;
        for (const side of [-1, 1]) {
          const tx = alongX ? mid : (side < 0 ? w.x0 - 0.3 : w.x1 + 0.3), tz = alongX ? (side < 0 ? w.z0 - 0.3 : w.z1 + 0.3) : mid;
          const tiles = roomAt(tx, tz)?.tiles || OUT;
          const [hx0, hz0, hx1, hz1] = alongX ? [a0, side < 0 ? w.z0 : (w.z0 + w.z1) / 2, a1, side < 0 ? (w.z0 + w.z1) / 2 : w.z1] : [side < 0 ? w.x0 : (w.x0 + w.x1) / 2, a0, side < 0 ? (w.x0 + w.x1) / 2 : w.x1, a1];
          b.box(hx0, k ? -SLAB : 0, hz0, hx1, WALL_H, hz1, tiles.wall, 0.42);
          const pad = 0.02; // skirting sticks out a touch on its own side only
          b.box(alongX ? hx0 : (side < 0 ? hx0 - pad : hx0), 0, alongX ? (side < 0 ? hz0 - pad : hz0) : hz0, alongX ? hx1 : (side < 0 ? hx1 : hx1 + pad), 0.16, alongX ? (side < 0 ? hz1 : hz1 + pad) : hz1, tiles.skirt, 0.42);
        }
      }
      b.box(w.x0 - 0.01, WALL_H, w.z0 - 0.01, w.x1 + 0.01, WALL_H + 0.08, w.z1 + 0.01, 0xcfae84, 0.42);     // wooden cap
    }
    houseDetail(b, gb, level, k, rng);
    // stairs: solid wooden steps up from this floor, a banister on each open side; around the opening upstairs, a railing
    const TREAD = 0xb07a4a, NOSE = 0x7a4f2c, BAN = 0x5c3a22, POST = 0xe8dcc4;
    for (const st of level.stairs) {
      const z0 = st.zl + DZ * k, z1 = st.zh + DZ * k, steps = 12, run = (z1 - z0) / steps;
      if (st.b === k) {
        for (let i = 0; i < steps; i++) {
          const top = H * (i + 1) / steps, za = st.dir > 0 ? z0 + i * run : z1 - (i + 1) * run, zb = za + run;
          b.box(st.x0, 0, za, st.x1, top - 0.05, zb, 0x8a6446, 0.42);                                  // riser block
          b.box(st.x0, top - 0.05, za, st.x1, top, zb, TREAD, 0.42);                                   // tread
          b.box(st.x0, top - 0.06, st.dir > 0 ? za : zb - 0.06, st.x1, top, st.dir > 0 ? za + 0.06 : zb, NOSE, 0.42);
          for (const x of [st.x0 - 0.08, st.x1 + 0.0]) b.box(x, top, za, x + 0.08, top + 0.9, zb, i % 3 ? POST : BAN, 0.42); // stepped banister
        }
      } else if (st.b === k - 1) { // the stairwell opening on the floor above: railings on the open sides
        const zc = st.dir > 0 ? z0 : z1;
        b.box(st.x0, 0, zc - 0.05, st.x1, 0.95, zc + 0.05, BAN, 0.42);
        for (const [open, x] of [[st.openX1 ?? true, st.x1], [!!st.openX0, st.x0 - 0.1]]) { // railing along each open side of the hole
          if (!open) continue;
          b.box(x, 0, Math.min(z0, z1), x + 0.1, 0.95, Math.max(z0, z1), BAN, 0.42);
          for (let z = Math.min(z0, z1); z < Math.max(z0, z1); z += 0.5) b.box(x, 0, z, x + 0.1, 0.9, z + 0.06, POST, 0.42);
        }
      }
    }
    for (const p of level.props.filter(p => onK(p.z))) {
      if (p.kind === 'fixture') { drawFixture(b, p); continue; }
      if (p.kind === 'rug') b.box(p.x - p.w / 2, 0.04, p.z - p.d / 2, p.x + p.w / 2, 0.06, p.z + p.d / 2, p.color, 0.3);
      else if (p.kind === 'counter') { b.cbox(p.x, 0.45, p.z, p.w, 0.9, p.d, p.color, 0.3); const along = p.w >= p.d; for (let q = -1; q <= 1; q += 2) foods.push({ x: p.x + (along ? q * p.w * 0.25 : 0), y: 0.9 + k * H, z: p.z - DZ * k + (along ? 0 : q * p.d * 0.25), rot: rng() * 6.28, h: 0.32 }); }
      else if (p.kind === 'plant') pots.push({ ...p, y: k * H, z: p.z - DZ * k, n: Math.floor(rng() * 4) });
      else if (p.kind === 'mailbox') new Vox().box(0, 0.5, 0, 0.1, 1, 0.1, 0xcccccc).box(0, 1.1, 0, 0.5, 0.36, 0.3, 0x2ec4b6).box(0.2, 1.36, 0, 0.06, 0.2, 0.06, 0xe63946).into(b, p.x, 0, p.z);
    }
    if (k === 0) b.box(fd.x + 0.2, 0.04, fd.z - 1.7, fd.x + 1.4, 0.06, fd.z + 1.7, 0xffd166, 0.3);       // door mat
    const m = new THREE.Mesh(b.geometry(), voxMat); m.castShadow = m.receiveShadow = true; sg.add(m);
    if (gb.pos.length) sg.add(new THREE.Mesh(gb.geometry(), glowMat));
    const fm = new THREE.Mesh(fb.geometry(), plainMat); fm.receiveShadow = true; sg.add(fm);
    for (const r of level.rooms.filter(r => (r.storey || 0) === k)) { // room names stay as soft floor decals
      const l = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), new THREE.MeshBasicMaterial({ map: labelTexture(r.name.toUpperCase(), { fg: 'rgba(255,255,255,.35)', font: 'bold 44px system-ui', w: 512, h: 128 }), transparent: true }));
      l.rotation.x = -Math.PI / 2; l.position.set((r.x0 + r.x1) / 2, 0.05, r.role === 'stairs' ? r.z1 - 0.6 : r.z0 + 1.3); sg.add(l);
    }
  }
  for (let q = 0; q < 4; q++) instanceModels(g, `/models/env/pot${q}.glb`, pots.filter(p => p.n === q).map(p => ({ x: p.x, y: p.y, z: p.z, rot: rng() * 6.28, h: 1.0 })));
  instanceModels(g, '/models/env/food1.glb', foods);
  if (!LITE) decorateYard(g, level, rng);
  scene.scene.add(g);
}

export function buildTruck(scene) {
  const g = new THREE.Group(), b = new Batch();
  const body = 0xf4ead8, accent = 0xff8a3d, dark = 0x2b241e; // Starside white + orange
  const len = TRUCK.bayX1 - TRUCK.bayX0, wid = TRUCK.z1 - TRUCK.z0, x0 = TRUCK.bayX0, x1 = TRUCK.bayX1, fy = TRUCK.floorY;
  b.box(x0, fy - 0.2, -(wid / 2 + 0.4), x1, fy, wid / 2 + 0.4, dark, CELL);                             // floor, one block per cell
  const truck = new THREE.Mesh(b.geometry(), voxMat); truck.castShadow = truck.receiveShadow = true; g.add(truck);
  // the walls are separate pieces so the one between the camera and the load can step aside when the view is turned
  const part = (fn) => { const pb = new Batch(); fn(pb); const m = new THREE.Mesh(pb.geometry(), voxMat); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  const sides = {};
  for (const sz of [-1, 1]) {
    const zc = sz * (wid / 2 + 0.2);
    sides[sz] = part(pb => {
      pb.box(x0, fy, zc - 0.1, x1, fy + 1.2, zc + 0.1, body, 0.4);                                      // side wall
      pb.box(x0, fy + 1.2, zc - 0.11, x1, fy + 1.4, zc + 0.11, accent, 0.4);                            // stripe
    });
  }
  const bulkhead = part(pb => pb.box(x1, fy, -(wid / 2 + 0.3), x1 + 0.2, fy + GRID.H * CELL + 0.3, wid / 2 + 0.3, body, 0.4));
  // the cab is a hover-truck model (see /credits.html), tinted Starside purple; it hovers, so glowing pads instead of tyres
  const cab = new THREE.Group(); cab.position.set((x1 + 0.2 + TRUCK.cabX1) / 2, 0.25, 0);
  attachModel(cab, '/models/env/cab.glb', { tint: 0xf2e6d4, rot: 1, fit: [TRUCK.cabX1 - x1 - 0.2, wid + 0.6, 2.75] });
  g.add(cab);
  const pads = new Batch();
  for (const px of [x0 + 0.8, x1 - 0.8, TRUCK.cabX1 - 1.2]) for (const sz of [-1, 1]) pads.box(px - 0.45, 0.12, sz * (wid / 2 + 0.15) - 0.3, px + 0.45, 0.22, sz * (wid / 2 + 0.15) + 0.3, 0x55ffcc, 0.3);
  g.add(new THREE.Mesh(pads.geometry(), glowMat));
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshBasicMaterial({ map: labelTexture('★ STARSIDE MOVERS', { fg: '#fff', font: 'bold 34px system-ui', w: 420, h: 100 }), transparent: true }));
  logo.rotation.x = -Math.PI / 2; logo.rotation.z = Math.PI / 2; logo.position.set((x1 + TRUCK.cabX1) / 2 + 0.1, 2.92, 0); g.add(logo);
  scene.truckParts = { sides, front: [bulkhead, cab, logo] };
  // a U-Haul style ramp: narrow, thin, ribbed aluminium with side lips, hinged at the truck so it can slide away under the floor
  const r = TRUCK.ramp, run = r.x1 - r.x0, RL = Math.hypot(run, fy), RW = 1.5, rb = new Batch(), AL = 0xb9bcc0, RIB = 0xd8dadc, LIP = 0x8e9196;
  rb.box(-RL, -0.05, -RW / 2, 0, 0, RW / 2, AL, 0.3);                                                  // the deck, 5 cm thick
  for (let x = -RL + 0.12; x < -0.05; x += 0.24) rb.box(x, 0, -RW / 2 + 0.06, x + 0.06, 0.025, RW / 2 - 0.06, RIB, 0.3); // grip ribs
  for (const sz of [-1, 1]) rb.box(-RL, -0.05, sz * RW / 2 - (sz > 0 ? 0.06 : 0), 0, 0.07, sz * RW / 2 + (sz < 0 ? 0.06 : 0), LIP, 0.3); // side lips
  rb.box(-RL - 0.08, -0.05, -RW / 2, -RL, -0.01, RW / 2, LIP, 0.3);                                    // toe plate
  const ramp = new THREE.Group(), rm = new THREE.Mesh(rb.geometry(), voxMat); rm.castShadow = rm.receiveShadow = true; ramp.add(rm);
  ramp.position.set(r.x1, fy, 0); ramp.rotation.z = Math.atan2(fy, run); g.add(ramp);
  scene.ramp = ramp; scene.rampHome = { x: r.x1, y: fy, rot: Math.atan2(fy, run), len: RL };
  const zone = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.12 }));
  zone.rotation.x = -Math.PI / 2; zone.position.set((r.x0 + r.x1) / 2, 0.04, 0); g.add(zone);
  scene.rampZone = zone;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.8), new THREE.MeshBasicMaterial({ map: labelTexture('LOAD ZONE ▶', { fg: '#55ffcc', font: 'bold 40px system-ui', w: 400, h: 96 }), transparent: true }));
  sign.rotation.x = -Math.PI / 2; sign.position.set((r.x0 + r.x1) / 2 - 0.3, 0.06, r.z1 + 0.7); g.add(sign);
  // roll-up shutter: anchored at the top of the doorway so it comes DOWN as it grows (ribbed, Starside white)
  const SH = GRID.H * CELL + 0.3, sh = new Batch();
  for (let y = 0; y < SH - 1e-6; y += 0.2) sh.box(-0.06, -Math.min(SH, y + 0.2), -(wid / 2 + 0.3), 0.06, -y - 0.02, wid / 2 + 0.3, 0xeee4d2, 0.3);
  for (let y = 0.2; y < SH; y += 0.2) sh.box(-0.07, -y - 0.02, -(wid / 2 + 0.3), 0.07, -y, wid / 2 + 0.3, 0xc9bda8, 0.3);
  const shutter = new THREE.Mesh(sh.geometry(), voxMat);
  shutter.position.set(x0 - 0.05, fy + SH, 0);
  shutter.scale.y = 0.001; shutter.visible = false; g.add(shutter);
  scene.shutter = shutter;
  scene.truckGroup = g;
  scene.scene.add(g);
}

/** dust puff as a little tumbling block */
const puffGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
export function puffMesh(color) {
  const m = new THREE.Mesh(puffGeo, new THREE.MeshLambertMaterial({ color, transparent: true, depthWrite: false, opacity: 0.9 }));
  m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
  return m;
}

// ---------- floors & yard ----------
const FLOOR_STYLE = { 'Kitchen': 'tile', 'Laundry': 'tile2', 'Garage': 'concrete', 'Bedroom': 'carpet', 'Kids Room': 'carpet2', 'Game Room': 'carpet3', 'Library': 'darkwood', 'Observatory': 'darkwood' };
const PAL = {
  wood: [0xb07d4f, 0xa26f43, 0xbf8a59, 0x9c6a3f], darkwood: [0x6b4a33, 0x5d3f2b, 0x7a5539, 0x553a28],
  tile: [0xf2e8d5, 0xc8734f], tile2: [0xf4f1ea, 0xa9bfa5], concrete: [0x948d84, 0x8a837a],          // kitchen cream/terracotta, bath sage, warm concrete
  carpet: [0xc9b79c, 0xbfad92, 0xd2c1a6], carpet2: [0x6fae9e, 0x67a595, 0x78b7a7], carpet3: [0xd98a6a, 0xcf8062, 0xe09474],
};
/** top-of-floor quads: planks, checker tiles, carpet speckle or concrete slabs */
function floorPattern(fb, r, rng) {
  const style = r.tiles?.floor || FLOOR_STYLE[r.name] || 'wood', y = 0.04, top = (x0, z0, x1, z1, hex) => fb.face(1, 1, [x0, y, z0], z1 - z0, x1 - x0, hex, 1);
  const pal = PAL[style];
  if (style === 'wood' || style === 'darkwood') { // planks run along x, staggered
    for (let z = r.z0; z < r.z1 - 1e-6; z += 0.3) {
      let x = r.x0 - rng() * 1.2; const z1 = Math.min(r.z1, z + 0.3);
      while (x < r.x1) { const l = 1.2 + rng() * 1.2, xa = Math.max(r.x0, x), xb = Math.min(r.x1, x + l); if (xb > xa) top(xa, z, xb, z1, pal[Math.floor(rng() * pal.length)]); x += l; }
    }
  } else if (style.startsWith('tile') || style === 'concrete') {
    const s = style === 'concrete' ? 1.2 : 0.6;
    for (let x = r.x0, i = 0; x < r.x1 - 1e-6; x += s, i++) for (let z = r.z0, j = 0; z < r.z1 - 1e-6; z += s, j++) top(x, z, Math.min(r.x1, x + s), Math.min(r.z1, z + s), pal[(i + j) % 2]);
  } else { // carpet: soft speckle
    for (let x = r.x0; x < r.x1 - 1e-6; x += 0.5) for (let z = r.z0; z < r.z1 - 1e-6; z += 0.5) top(x, z, Math.min(r.x1, x + 0.5), Math.min(r.z1, z + 0.5), pal[Math.floor(rng() * pal.length)]);
  }
}

/** a lawn round the house and downloaded trees, rocks, flowers, benches and lamp posts (one draw call per model) */
function decorateYard(g, level, rng) {
  const g0 = level.rooms.filter(r => !r.storey), xs = g0.flatMap(r => [r.x0, r.x1]), zs = g0.flatMap(r => [r.z0, r.z1]); // the ground floor's footprint
  const hx0 = Math.min(...xs), hx1 = Math.max(...xs), hz0 = Math.min(...zs), hz1 = Math.max(...zs);
  const L = { x0: hx0 - 8, x1: Math.min(hx1 + 9, 8.4), z0: hz0 - 8, z1: hz1 + 8 };
  const lawn = new Batch(), G = [0x4f9a4a, 0x5aa654, 0x4a9145];
  for (let x = L.x0; x < L.x1 - 1e-6; x += 1) for (let z = L.z0; z < L.z1 - 1e-6; z += 1) lawn.face(1, 1, [x, 0.012, z], Math.min(1, L.z1 - z), Math.min(1, L.x1 - x), G[Math.floor(rng() * G.length)], 1);
  const lm = new THREE.Mesh(lawn.geometry(), plainMat); lm.receiveShadow = true; g.add(lm);
  const fd = level.frontDoor, dz = Math.abs(fd.z) + 2.6;
  const taken = [];
  const free = (x, z, r) => {
    if (x > hx0 - 0.9 - r && x < hx1 + 0.9 + r && z > hz0 - 0.9 - r && z < hz1 + 0.9 + r) return false;          // the house
    if (x < L.x0 + 1 + r || z < L.z0 + 1 + r || z > L.z1 - 1 - r) return false;                                 // the fence
    if (x > fd.x - 1 && Math.abs(z - fd.z) < 2.4 + r) return false;                                              // front path
    if (x > 4.6 - r && Math.abs(z) < dz + 1.2 + r) return false;                                                 // driveway, ramp, truck
    for (const p of level.props) if (Math.hypot(p.x - x, p.z - z) < 1.2 + r) return false;
    for (const t of taken) if (Math.hypot(t.x - x, t.z - z) < t.r + r) return false;
    return true;
  };
  const place = (n, r, tries = 60) => { const out = []; for (let i = 0; i < n; i++) for (let k = 0; k < tries; k++) { const x = L.x0 + rng() * (L.x1 - L.x0), z = L.z0 + rng() * (L.z1 - L.z0); if (free(x, z, r)) { taken.push({ x, z, r }); out.push({ x, z, rot: rng() * 6.28 }); break; } } return out; };
  const group = (list, n) => { const out = Array.from({ length: n }, () => []); list.forEach(p => out[Math.floor(rng() * n)].push(p)); return out; };
  const add = (name, list, h, hv = 0, shadow = true) => instanceModels(g, `/models/env/${name}.glb`, list.map(p => ({ ...p, h: h + rng() * hv })), { shadow });
  group(place(16, 1.6), 12).forEach((l, i) => add(`tree${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12][i]}`, l, 3.6, 1.8));
  group(place(5, 0.9), 3).forEach((l, i) => add(['rock0', 'rock1', 'rock4'][i], l, 0.7, 0.6));
  group(place(3, 0.8), 2).forEach((l, i) => add(['stump0', 'stump1'][i], l, 0.55, 0.2));
  // flowers: mostly the light ones; small things cast no shadow
  const fl = place(28, 0.35); add('flower2', fl.slice(0, 10), 0.55, 0.25, false); add('flower3', fl.slice(10, 20), 0.55, 0.25, false); add('flower1', fl.slice(20, 25), 0.55, 0.25, false); add('flower0', fl.slice(25), 0.55, 0.25, false);
  add('grass0', place(12, 0.3), 0.45, 0.25, false);
  group(place(2, 1.2), 2).forEach((l, i) => add(`bench${i}`, l, 0.9));
  // lamp posts line the front path; the hotdog cart parks by the driveway
  const lamps = []; for (let x = fd.x + 2.5; x < 4.4; x += 3.5) for (const s of [-1, 1]) lamps.push({ x, z: fd.z + s * 2.0, rot: 0 });
  add('lamppost1', lamps, 2.4);
  const cart = place(1, 1.4); if (cart.length) add('hotdog', [{ ...cart[0], rot: rng() * 6.28 }], 1.7);
  // a white picket fence round the back and sides of the yard (the street side stays open to the truck)
  const fb = new Batch(), PK = 0xf1e6d2, POST = 0xd9ccb6, fx1 = Math.min(L.x1, 4.2);
  const run = (alongX, fixed, a0, a1) => {
    for (const y of [0.32, 0.72]) alongX ? fb.box(a0, y, fixed - 0.04, a1, y + 0.08, fixed + 0.04, POST, 0.3) : fb.box(fixed - 0.04, y, a0, fixed + 0.04, y + 0.08, a1, POST, 0.3);
    for (let a = a0; a <= a1 + 1e-6; a += 0.32) {
      const post = Math.abs((a - a0) % 2.56) < 0.01, w = post ? 0.07 : 0.045, top = post ? 1.0 : 0.88;
      alongX ? fb.box(a - w, 0, fixed - w, a + w, top, fixed + w, post ? POST : PK, 0.3) : fb.box(fixed - w, 0, a - w, fixed + w, top, a + w, post ? POST : PK, 0.3);
    }
  };
  run(true, L.z0, L.x0, fx1); run(true, L.z1, L.x0, fx1); run(false, L.x0, L.z0, L.z1);
  const fm = new THREE.Mesh(fb.geometry(), voxMat); fm.castShadow = fm.receiveShadow = true; g.add(fm);
}

/** Render the four classic movers' voxel models into small portrait pictures (data URLs) for the HUD and lobby. */
export function renderClassicPortraits() {
  const out = {};
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(256, 256); r.setClearColor(0x000000, 0); r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x6655aa, 2.2));
  const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(2, 4, 5); sc.add(d);
  const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 50); cam.position.set(1.6, 1.9, 4.6); cam.lookAt(0, 0.9, 0);
  for (const id of ['nova', 'cosmo', 'glorp', 'zibble']) {
    const m = makeMover(id);
    m.children.filter(c => c.isMesh && c.geometry?.type === 'PlaneGeometry').forEach(c => { c.visible = false; }); // no floor shadow square
    sc.add(m); r.render(sc, cam); out[id] = r.domElement.toDataURL('image/png'); sc.remove(m);
  }
  r.dispose(); r.forceContextLoss?.();
  return out;
}
