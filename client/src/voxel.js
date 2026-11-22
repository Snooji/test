// Voxel look (trial at /voxel). Same game, same rules; only the models change.
// Performance rules: every model is ONE merged mesh (greedy-meshed: neighbouring faces of the same colour
// become one quad), colours live in the vertices, and everything shares one material, so a whole house
// or truck is a single draw call. A faint grid texture draws the block lines without extra triangles.
import * as THREE from 'three';
import { ITEM_TYPES, GRID } from '../../shared/logic.js';
import { CELL, TRUCK } from '../../shared/world.js';
import { sprite, labelTexture } from './models.js';

export const VS = 0.1; // model voxel size in metres

// ---------- shared materials ----------
const gridTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 32, 32);
  g.fillStyle = 'rgba(40,30,80,.16)'; g.fillRect(0, 0, 32, 2); g.fillRect(0, 0, 2, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
})();
export const voxMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: gridTex });
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
function astronaut(suit, visor, material) {
  const white = 0xf1f3fa;
  const v = new Vox()
    .box(-0.15, 0.1, 0.03, 0.2, 0.2, 0.3, 0xd9dde8).box(0.15, 0.1, 0.03, 0.2, 0.2, 0.3, 0xd9dde8)   // boots
    .box(-0.14, 0.32, 0, 0.2, 0.26, 0.24, suit).box(0.14, 0.32, 0, 0.2, 0.26, 0.24, suit)           // legs
    .box(0, 0.72, 0, 0.6, 0.56, 0.44, suit)                                                          // torso
    .box(0, 0.5, 0, 0.62, 0.08, 0.46, shade(suit, 0.6))                                              // belt
    .box(0, 0.8, 0.24, 0.2, 0.16, 0.06, 0xffd166)                                                    // chest badge
    .box(0, 0.76, -0.29, 0.44, 0.46, 0.16, 0xd9dde8)                                                 // backpack
    .ell(0, 1.27, 0, 0.36, 0.33, 0.34, white)                                                        // helmet
    .box(0, 1.28, 0.26, 0.44, 0.24, 0.12, visor)                                                     // visor
    .box(0.2, 1.66, 0, 0.1, 0.3, 0.1, white);                                                        // antenna
  const tip = new Vox().box(0.2, 1.86, 0, 0.12, 0.12, 0.12, suit);
  const g = withArms(v.mesh(material), [[-1, 0.4, 0.98, 0.44, white, suit], [1, 0.4, 0.98, 0.44, white, suit]], material);
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

export function makeMover(char, suit = null) {
  const material = voxMat.clone(); // own copy: knocked-out movers fade without fading everyone
  const g = { nova: () => astronaut(suit ?? 0xff8a3d, 0x1d2b6b, material), cosmo: () => astronaut(suit ?? 0x2ec4b6, 0xe0a526, material), glorp: () => glorp(suit, material), zibble: () => zibble(suit, material) }[char]?.()
    || astronaut(suit ?? 0xff8a3d, 0x1d2b6b, material);
  const root = new THREE.Group();
  const glow = glowMat.clone();
  g.traverse(o => { if (o.material === glowMat) o.material = glow; });
  root.add(g);
  root.userData.body = g;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
  root.add(shadow);
  return root;
}

// ---------- items ----------
const QUILT = (x, y, z) => ((Math.round(x / VS) + Math.round(z / VS) + Math.round(y / VS)) & 3) === 0 ? 0x6f95ff : 0x2f5fd0;
function boxColour(type, w, h, d) {
  const t = ITEM_TYPES[type], base = t.color;
  if (type === 'standard') return (x, y, z) => (Math.abs(x) < 0.1 && (y > h - VS || Math.abs(z) > d / 2 - VS)) ? 0xe8d6a8 : (Math.abs(z) > d / 2 - VS && Math.abs(x - 0.25) < 0.1 && Math.abs(y - h * 0.55) < 0.1) ? 0xffd166 : base;
  if (type === 'heavy') return (x, y, z) => (y < 0.25 && y > 0.1) ? ((Math.round((x + y) / VS) & 1) ? 0xffdd57 : 0x1b1b24) : base;
  if (type === 'fragile') return (x, y, z) => (Math.abs(z) > d / 2 - VS && Math.abs(x) < 0.12 && y > h * 0.35 && y < h * 0.75) ? 0xe63946 : (y > h * 0.8 && y < h * 0.9) ? 0xe63946 : base;
  return (x, y, z) => ((Math.round(x / VS) & 3) === 0 ? shade(base, 0.85) : base);
}

/** a piece in the truck: one block per cell, darker cell edges so the shape reads at a glance */
function loadedPiece(type, wrapped, dims) {
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

function dolly() {
  const steel = 0x9aa3b8, red = 0xe63946;
  const v = new Vox().box(0, 0.1, 0, 0.8, 0.1, 0.6, steel);
  for (const s of [-1, 1]) v.box(s * 0.32, 0.75, -0.25, 0.1, 1.3, 0.1, red).cyl(s * 0.44, 0.16, -0.22, 0.16, 0.1, 0x1a1a24, 'x');
  v.box(0, 1.4, -0.25, 0.74, 0.1, 0.1, red).box(0, 0.8, -0.25, 0.74, 0.1, 0.1, red);
  const g = new THREE.Group(); g.add(v.mesh()); return g;
}

export function makeItem(type, { wrapped = false, assembled = false, loaded = false, dims = null } = {}) {
  const t = ITEM_TYPES[type];
  if (type === 'dolly') return dolly();
  if (loaded && dims) return loadedPiece(type, wrapped, dims);
  const g = new THREE.Group();
  if (!t.furniture || (!assembled && t.needsDisassemble)) {
    const flat = t.needsDisassemble && !assembled;
    const w = t.w * 0.9, h = flat ? 0.3 : 0.8, d = Math.max(0.8, t.d * 0.9);
    g.add(new Vox().box(0, h / 2, 0, w, h, d, wrapped && t.furniture ? QUILT : boxColour(type, w, h, d)).mesh());
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
  b.box(-95, -0.05, -45, 75, 0, 45, 0x3a3358, 2);                                   // lunar ground, 2 m blocks
  for (let i = 0; i < 26; i++) { // craters: sunken dark squares
    const r = 0.6 + Math.random() * 1.8; let x, z;
    do { x = -70 + Math.random() * 110; z = -40 + Math.random() * 80; } while (x > -46 && x < 26 && z > -17 && z < 17);
    b.box(x - r, 0, z - r, x + r, 0.03, z + r, 0x2c2645, 0.5);
  }
  const ground = new THREE.Mesh(b.geometry(), voxMat); ground.receiveShadow = true; s.add(ground);
  const starGeo = new THREE.BufferGeometry(), pts = [];
  for (let i = 0; i < 900; i++) pts.push((Math.random() - 0.5) * 200, 30 + Math.random() * 60, (Math.random() - 0.5) * 200);
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  s.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, sizeAttenuation: true })));
  const planet = new Vox(0.8).ell(0, 0, 0, 8, 8, 8, (x, y) => (Math.floor(y / 1.6) & 1) ? 0xff8a3d : 0xe2702a).mesh(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x552200 }));
  planet.castShadow = planet.receiveShadow = false;
  planet.position.set(-30, 25, -60); s.add(planet);
  scene.buildTruck();
}

export function buildHouse(scene, level) {
  const g = new THREE.Group();
  scene.house = g; scene.level = level;
  const b = new Batch(), fd = level.frontDoor;
  const walkLen = Math.max(0.1, 9.4 - fd.x);
  b.box(fd.x, 0, fd.z - 1.5, fd.x + walkLen, 0.03, fd.z + 1.5, 0x57507a, 0.75);                        // walkway
  const dz = Math.abs(fd.z) + 2.6;
  b.box(5.4, 0, -dz, 9.4, 0.025, dz, 0x57507a, 0.75);                                                  // driveway
  for (const r of level.rooms) b.box(r.x0, 0, r.z0, r.x1, 0.04, r.z1, r.floor, 1);                     // floor tiles
  for (const w of level.houseWalls) {
    b.box(w.x0, 0, w.z0, w.x1, 1.25, w.z1, 0xe9e4ff, 0.42);                                            // wall blocks
    b.box(w.x0 - 0.01, 1.25, w.z0 - 0.01, w.x1 + 0.01, 1.35, w.z1 + 0.01, 0x8f7bff, 0.42);             // trim
  }
  for (const p of level.props) {
    if (p.kind === 'rug') b.box(p.x - p.w / 2, 0.04, p.z - p.d / 2, p.x + p.w / 2, 0.06, p.z + p.d / 2, p.color, 0.3);
    else if (p.kind === 'counter') b.cbox(p.x, 0.45, p.z, p.w, 0.9, p.d, p.color, 0.3);
    else if (p.kind === 'plant') new Vox().cyl(0, 0.2, 0, 0.28, 0.4, 0xff8a3d).ell(0, 0.72, 0, 0.42, 0.4, 0.42, (x, y, z) => ((Math.round(x / VS) + Math.round(y / VS) + Math.round(z / VS)) % 3 ? 0x52d17c : 0x3fae64)).into(b, p.x, 0, p.z);
    else if (p.kind === 'mailbox') new Vox().box(0, 0.5, 0, 0.1, 1, 0.1, 0xcccccc).box(0, 1.1, 0, 0.5, 0.36, 0.3, 0x2ec4b6).box(0.2, 1.36, 0, 0.06, 0.2, 0.06, 0xe63946).into(b, p.x, 0, p.z);
  }
  b.box(fd.x + 0.2, 0.04, fd.z - 1.7, fd.x + 1.4, 0.06, fd.z + 1.7, 0xffd166, 0.3);                     // door mat
  const m = new THREE.Mesh(b.geometry(), voxMat); m.castShadow = m.receiveShadow = true; g.add(m);
  for (const r of level.rooms) { // room names stay as soft floor decals
    const l = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), new THREE.MeshBasicMaterial({ map: labelTexture(r.name.toUpperCase(), { fg: 'rgba(255,255,255,.35)', font: 'bold 44px system-ui', w: 512, h: 128 }), transparent: true }));
    l.rotation.x = -Math.PI / 2; l.position.set((r.x0 + r.x1) / 2, 0.05, r.z0 + 1.3); g.add(l);
  }
  scene.scene.add(g);
}

export function buildTruck(scene) {
  const g = new THREE.Group(), b = new Batch();
  const body = 0xf4f1ff, accent = 0x6b4dff, dark = 0x2a2640;
  const len = TRUCK.bayX1 - TRUCK.bayX0, wid = TRUCK.z1 - TRUCK.z0, x0 = TRUCK.bayX0, x1 = TRUCK.bayX1, fy = TRUCK.floorY;
  b.box(x0, fy - 0.2, -(wid / 2 + 0.4), x1, fy, wid / 2 + 0.4, dark, CELL);                             // floor, one block per cell
  for (const sz of [-1, 1]) {
    const zc = sz * (wid / 2 + 0.2);
    b.box(x0, fy, zc - 0.1, x1, fy + 1.2, zc + 0.1, body, 0.4);                                         // side wall
    b.box(x0, fy + 1.2, zc - 0.11, x1, fy + 1.4, zc + 0.11, accent, 0.4);                               // stripe
    b.box(x0 + 0.05, fy, zc - 0.05, x0 + 0.15, fy + GRID.H * CELL, zc + 0.05, 0xbbbbcc, 0.1);           // height pole
    for (let y = 1; y <= GRID.H; y++) b.box(x0 + 0.03, fy + y * CELL - 0.03, zc - 0.07, x0 + 0.17, fy + y * CELL + 0.03, zc + 0.07, 0x55ffcc, 0.1);
    for (const wx of [x0 + 1, TRUCK.cabX1 - 1.2]) new Vox().cyl(0, 0, 0, 0.5, 0.36, (x, y) => Math.hypot(x, y) < 0.22 ? 0x9aa3b8 : 0x1a1a24, 'z').into(b, wx, 0.5, sz * (wid / 2 + 0.45));
  }
  b.box(x1, fy, -(wid / 2 + 0.3), x1 + 0.2, fy + GRID.H * CELL + 0.3, wid / 2 + 0.3, body, 0.4);        // bulkhead
  b.box(x1 + 0.2, 0.3, -(wid / 2 + 0.3), TRUCK.cabX1, 2.9, wid / 2 + 0.3, accent, 0.4);                 // cab
  b.box(TRUCK.cabX1, 1.7, -wid / 2, TRUCK.cabX1 + 0.1, 2.7, wid / 2, 0x9ad7ff, 0.4);                    // windscreen
  const truck = new THREE.Mesh(b.geometry(), voxMat); truck.castShadow = truck.receiveShadow = true; g.add(truck);
  const lines = [];
  for (let i = 0; i <= GRID.W; i++) { const z = TRUCK.z0 + i * CELL; lines.push(x0, fy + 0.01, z, x1, fy + 0.01, z); }
  for (let i = 0; i <= GRID.D; i++) { const x = x0 + i * CELL; lines.push(x, fy + 0.01, TRUCK.z0, x, fy + 0.01, TRUCK.z1); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.5 })));
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshBasicMaterial({ map: labelTexture('★ STARSIDE MOVERS', { fg: '#fff', font: 'bold 34px system-ui', w: 420, h: 100 }), transparent: true }));
  logo.rotation.x = -Math.PI / 2; logo.rotation.z = Math.PI / 2; logo.position.set((x1 + TRUCK.cabX1) / 2 + 0.1, 2.92, 0); g.add(logo);
  const r = TRUCK.ramp, rb = new Batch();
  rb.cbox(0, 0, 0, r.x1 - r.x0, 0.12, r.z1 - r.z0 - 0.6, 0x8a86a6, 0.3);
  const ramp = new THREE.Mesh(rb.geometry(), voxMat);
  ramp.position.set((r.x0 + r.x1) / 2, fy / 2, 0); ramp.rotation.z = Math.atan2(fy, r.x1 - r.x0); ramp.receiveShadow = true; g.add(ramp);
  const zone = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.12 }));
  zone.rotation.x = -Math.PI / 2; zone.position.set((r.x0 + r.x1) / 2, 0.04, 0); g.add(zone);
  scene.rampZone = zone;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.8), new THREE.MeshBasicMaterial({ map: labelTexture('LOAD ZONE ▶', { fg: '#55ffcc', font: 'bold 40px system-ui', w: 400, h: 96 }), transparent: true }));
  sign.rotation.x = -Math.PI / 2; sign.position.set((r.x0 + r.x1) / 2 - 0.3, 0.06, r.z1 + 0.7); g.add(sign);
  const sh = new Batch(); sh.cbox(0, 0, 0, 0.12, GRID.H * CELL + 0.3, wid + 0.6, 0xd9d4f2, 0.3);
  const shutter = new THREE.Mesh(sh.geometry(), voxMat);
  shutter.position.set(x0 - 0.05, fy + (GRID.H * CELL + 0.3) / 2, 0);
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
