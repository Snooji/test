import * as THREE from 'three';
import { ITEM_TYPES } from '../../shared/logic.js';
import { CELL } from '../../shared/world.js';
import { VOXEL } from './style.js';
import * as VX from './voxel.js';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts }));
  return matCache.get(key);
}

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// ---------- canvas textures ----------
export function labelTexture(text, { bg = null, fg = '#fff', font = 'bold 48px system-ui', w = 256, h = 64, stroke = null } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, h, h / 3); g.fill(); }
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (stroke) { g.lineWidth = 8; g.strokeStyle = stroke; g.strokeText(text, w / 2, h / 2 + 2); }
  g.fillStyle = fg; g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function sprite(text, opts = {}, scale = [2.4, 0.6]) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, opts), depthTest: false, transparent: true }));
  s.scale.set(scale[0], scale[1], 1);
  s.renderOrder = 10;
  return s;
}

const boxFaceCache = new Map();
function boxFace(type, wrapped) {
  const key = type + wrapped;
  if (boxFaceCache.has(key)) return boxFaceCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const t = ITEM_TYPES[type];
  if (wrapped) { // quilted moving blanket
    g.fillStyle = '#2f5fd0'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#6f95ff'; g.lineWidth = 3;
    for (let i = -128; i < 256; i += 22) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke(); g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke(); }
  } else {
    g.fillStyle = '#' + t.color.toString(16).padStart(6, '0'); g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, 0, 128, 6); g.fillRect(0, 122, 128, 6);
    if (!t.furniture) { g.fillStyle = '#e8d6a8'; g.fillRect(54, 0, 20, 128); } // packing tape
  }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const lab = { heavy: ['⚠', 'HEAVY', '#ffdd57'], fragile: ['🍷', 'FRAGILE', '#e63946'], standard: ['★', 'STARSIDE', '#3a2a1a'] }[type];
  if (lab && !wrapped) {
    g.font = 'bold 40px system-ui'; g.fillStyle = lab[2]; g.fillText(lab[0], 64, 46);
    g.font = 'bold 20px system-ui'; g.fillText(lab[1], 64, 90);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  boxFaceCache.set(key, tex);
  return tex;
}

// ---------- movers ----------
function astronaut(suit, visor) {
  const g = new THREE.Group();
  const white = mat(0xf1f3fa);
  g.add(mesh(new THREE.CapsuleGeometry(0.34, 0.35, 6, 12), mat(suit), 0, 0.62, 0));            // suit body
  g.add(mesh(new THREE.BoxGeometry(0.42, 0.45, 0.2), mat(0xd9dde8), 0, 0.7, -0.33));             // backpack
  g.add(mesh(new THREE.SphereGeometry(0.36, 20, 16), white, 0, 1.25, 0));                         // helmet
  const v = mesh(new THREE.SphereGeometry(0.26, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), mat(visor, { metalness: 0.6, roughness: 0.2 }), 0, 1.26, 0.14);
  v.rotation.x = Math.PI / 2; v.scale.set(1.15, 1, 0.8);
  g.add(v);
  g.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.25), white, 0.18, 1.62, 0));
  g.add(mesh(new THREE.SphereGeometry(0.06), mat(suit, { emissive: suit, emissiveIntensity: 0.6 }), 0.18, 1.76, 0));
  for (const s of [-1, 1]) { const arm = mesh(new THREE.CapsuleGeometry(0.1, 0.25, 4, 8), white, s * 0.42, 0.7, 0.05); arm.userData.arm = s; g.add(arm); } // arms
  for (const s of [-1, 1]) g.add(mesh(new THREE.CapsuleGeometry(0.11, 0.15, 4, 8), white, s * 0.15, 0.16, 0));   // boots
  return g;
}

function glorp(tint) {
  const g = new THREE.Group();
  const green = mat(tint ?? 0x7bd84a);
  const body = mesh(new THREE.SphereGeometry(0.5, 20, 16), green, 0, 0.6, 0);
  body.scale.set(1, 1.25, 0.95);
  g.add(body);
  g.add(mesh(new THREE.SphereGeometry(0.22, 16, 12), mat(0xffffff), 0, 0.85, 0.36));
  g.add(mesh(new THREE.SphereGeometry(0.12, 12, 10), mat(0x1b1b3a), 0, 0.86, 0.53));
  for (const s of [-1, 1]) {
    const a = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4), mat(0x5aa832), s * 0.2, 1.35, 0);
    a.rotation.z = -s * 0.4; g.add(a);
    g.add(mesh(new THREE.SphereGeometry(0.08), mat(0xc6ff8f, { emissive: 0x88ff44, emissiveIntensity: 0.6 }), s * 0.29, 1.54, 0));
    { const arm = mesh(new THREE.CapsuleGeometry(0.09, 0.22, 4, 8), green, s * 0.52, 0.55, 0.05); arm.userData.arm = s; g.add(arm); }
  }
  const belt = mesh(new THREE.TorusGeometry(0.42, 0.06, 8, 20), mat(0xff8a3d), 0, 0.3, 0); // tool belt
  belt.rotation.x = Math.PI / 2;
  g.add(belt);
  return g;
}

function zibble(tint) {
  const g = new THREE.Group();
  const purple = mat(tint ?? 0xa66cff);
  g.add(mesh(new THREE.CapsuleGeometry(0.3, 0.3, 6, 12), mat(0x7d45d9), 0, 0.5, 0));
  const head = mesh(new THREE.SphereGeometry(0.42, 20, 16), purple, 0, 1.15, 0);
  head.scale.set(1.15, 0.9, 1);
  g.add(head);
  for (const [x, y] of [[-0.18, 1.18], [0, 1.3], [0.18, 1.18]]) {
    g.add(mesh(new THREE.SphereGeometry(0.09, 12, 10), mat(0xffffff), x, y, 0.33));
    g.add(mesh(new THREE.SphereGeometry(0.045, 8, 8), mat(0x1b1b3a), x, y, 0.41));
  }
  for (const s of [-1, 1]) {
    const a = mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.45), mat(0x7d45d9), s * 0.18, 1.65, 0);
    a.rotation.z = -s * 0.5; g.add(a);
    g.add(mesh(new THREE.SphereGeometry(0.08), mat(0xffd166, { emissive: 0xffaa00, emissiveIntensity: 0.7 }), s * 0.3, 1.85, 0));
    { const arm = mesh(new THREE.CapsuleGeometry(0.08, 0.25, 4, 8), purple, s * 0.38, 0.55, 0.05); arm.userData.arm = s; g.add(arm); }
  }
  g.add(mesh(new THREE.BoxGeometry(0.34, 0.18, 0.05), mat(0xffd166), 0, 0.55, 0.3));
  return g;
}

/** suit = colour from SUITS (null = the mover's classic colour) */
export function makeMover(char, suit = null) {
  if (VOXEL) return VX.makeMover(char, suit);
  const g = { nova: () => astronaut(suit ?? 0xff8a3d, 0x1d2b6b), cosmo: () => astronaut(suit ?? 0x2ec4b6, 0xe0a526), glorp: () => glorp(suit), zibble: () => zibble(suit) }[char]?.() || astronaut(suit ?? 0xff8a3d, 0x1d2b6b);
  const root = new THREE.Group();
  root.add(g);
  root.userData.body = g;
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
  root.add(shadow);
  return root;
}

// ---------- items ----------
function makeDolly() {
  const g = new THREE.Group();
  const steel = mat(0x9aa3b8, { metalness: 0.6, roughness: 0.35 }), red = mat(0xe63946);
  g.add(mesh(new THREE.BoxGeometry(0.85, 0.06, 0.55), steel, 0, 0.1, 0));                  // nose plate
  for (const s of [-1, 1]) {
    const rail = mesh(new THREE.BoxGeometry(0.06, 1.35, 0.06), red, s * 0.32, 0.75, -0.25); g.add(rail); // uprights
    const wheel = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16), mat(0x1a1a24), s * 0.44, 0.16, -0.22);
    wheel.rotation.z = Math.PI / 2; g.add(wheel);
  }
  g.add(mesh(new THREE.BoxGeometry(0.7, 0.06, 0.06), red, 0, 1.4, -0.25));                // handle
  g.add(mesh(new THREE.BoxGeometry(0.7, 0.05, 0.05), red, 0, 0.8, -0.25));
  return g;
}

export function makeItem(type, { wrapped = false, assembled = false, loaded = false, dims = null } = {}) {
  if (VOXEL) return VX.makeItem(type, { wrapped, assembled, loaded, dims });
  const t = ITEM_TYPES[type];
  if (type === 'dolly') return makeDolly();
  const g = new THREE.Group();
  if (loaded && dims?.cells) { // shaped piece in the truck: one block per cell, centred on its bounding box
    const face = new THREE.MeshStandardMaterial({ map: boxFace(type, wrapped && t.furniture), roughness: 0.9 });
    const geo = new THREE.BoxGeometry(CELL * 0.96, CELL * 0.96, CELL * 0.96);
    for (const [cx, cy, cz] of dims.cells) {
      const m = mesh(geo, face, -(cz + 0.5 - dims.d / 2) * CELL, cy * CELL + CELL * 0.48, (cx + 0.5 - dims.w / 2) * CELL);
      m.receiveShadow = true; g.add(m);
    }
    const l = sprite(t.label.toUpperCase(), { fg: '#fff', stroke: '#000', font: 'bold 40px system-ui' }, [1.6, 0.4]);
    l.position.y = dims.h * CELL + 0.1; l.material.depthTest = true; g.add(l);
    return g;
  }
  if (!t.furniture || loaded || (!assembled && t.needsDisassemble)) {
    // a box (or flat-pack / wrapped bundle once loaded). In the truck, grid width runs along world-z.
    const flat = t.needsDisassemble && !assembled && !loaded;
    const L = loaded && dims ? dims : { w: t.d, d: t.w, h: t.h || 1 };
    const w = loaded ? L.d * CELL * 0.96 : t.w * 0.9;
    const h = loaded ? (L.h || 1) * CELL * 0.96 : flat ? 0.35 : 0.8;
    const d = loaded ? L.w * CELL * 0.96 : Math.max(0.8, t.d * 0.9);
    const face = new THREE.MeshStandardMaterial({ map: boxFace(type, wrapped && t.furniture), roughness: 0.9 });
    const m = mesh(new THREE.BoxGeometry(w, h, d), face, 0, h / 2, 0);
    m.receiveShadow = true;
    g.add(m);
    if (loaded && t.furniture) { const l = sprite(t.label.toUpperCase(), { fg: '#fff', stroke: '#000', font: 'bold 40px system-ui' }, [1.6, 0.4]); l.position.y = h + 0.1; l.material.depthTest = true; g.add(l); }
    if (flat) { const l = sprite('FLAT-PACK ' + t.label.toUpperCase(), { fg: '#fff', stroke: '#000', font: 'bold 30px system-ui', w: 320 }, [1.8, 0.36]); l.position.y = 0.6; g.add(l); }
    return g;
  }
  const c = wrapped ? new THREE.MeshStandardMaterial({ map: boxFace(type, true) }) : mat(t.color);
  if (type === 'couch') {
    g.add(mesh(new THREE.BoxGeometry(3.0, 0.45, 0.9), c, 0, 0.32, 0));
    g.add(mesh(new THREE.BoxGeometry(3.0, 0.6, 0.25), c, 0, 0.75, -0.33));
    for (const s of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.25, 0.55, 0.9), c, s * 1.42, 0.5, 0));
    if (!wrapped) for (const s of [-0.75, 0.75]) g.add(mesh(new THREE.BoxGeometry(1.35, 0.14, 0.7), mat(0x7d97ff), s, 0.6, 0.06)); // cushions
  } else if (type === 'bed') {
    g.add(mesh(new THREE.BoxGeometry(2.0, 0.35, 3.0), wrapped ? c : mat(0x6b4f8a), 0, 0.2, 0));          // frame
    g.add(mesh(new THREE.BoxGeometry(1.9, 0.28, 2.9), wrapped ? c : mat(0xf4f1ff), 0, 0.5, 0));          // mattress
    if (!wrapped) {
      g.add(mesh(new THREE.BoxGeometry(1.7, 0.08, 1.8), mat(0xa78bfa), 0, 0.66, 0.5));                   // blanket
      g.add(mesh(new THREE.BoxGeometry(1.5, 0.16, 0.5), mat(0xffffff), 0, 0.7, -1.1));                   // pillow
    }
    g.add(mesh(new THREE.BoxGeometry(2.0, 0.9, 0.12), wrapped ? c : mat(0x6b4f8a), 0, 0.6, -1.5));        // headboard
  } else if (type === 'lamp') { // an "r": tall pole, arm across the top, shade hanging off the end
    const pole = wrapped ? c : mat(0xcccccc);
    g.add(mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.12, 16), wrapped ? c : mat(0x444466), -0.45, 0.06, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.7), pole, -0.45, 0.9, 0));
    const arm = mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0), pole, 0.05, 1.72, 0); arm.rotation.z = Math.PI / 2; g.add(arm);
    g.add(mesh(new THREE.ConeGeometry(0.36, 0.42, 16, 1, true), wrapped ? c : mat(0xff9ad5, { emissive: 0xff66bb, emissiveIntensity: 0.6, side: THREE.DoubleSide }), 0.55, 1.45, 0));
  } else { // desk / table assembled
    const top = type === 'desk' ? [2.0, 0.12, 0.9] : [2.0, 0.1, 1.1];
    g.add(mesh(new THREE.BoxGeometry(...top), c, 0, 0.82, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.1, 0.8, 0.1), c, sx * 0.9, 0.4, sz * (top[2] / 2 - 0.08)));
    if (type === 'desk') g.add(mesh(new THREE.BoxGeometry(0.5, 0.4, 0.4), mat(0x222244, { emissive: 0x3355ff, emissiveIntensity: 0.4 }), -0.4, 1.08, -0.15)); // monitor
  }
  return g;
}

export function makeCat() {
  if (VOXEL) return VX.makeCat();
  const g = new THREE.Group();
  const fur = mat(0xc9c3e6);
  const body = mesh(new THREE.SphereGeometry(0.22, 14, 10), fur, 0, 0.22, 0); body.scale.set(0.9, 0.8, 1.4); g.add(body);
  g.add(mesh(new THREE.SphereGeometry(0.16, 14, 10), fur, 0, 0.36, 0.28));
  for (const s of [-1, 1]) { const e = mesh(new THREE.ConeGeometry(0.06, 0.12, 8), fur, s * 0.09, 0.52, 0.28); g.add(e); }
  g.add(mesh(new THREE.TorusGeometry(0.2, 0.05, 6, 12, Math.PI), mat(0xffd166, { emissive: 0xffaa00, emissiveIntensity: 0.5 }), 0, 0.62, 0.28)); // halo ring = space cat
  const tail = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4), fur, 0, 0.35, -0.38); tail.rotation.x = -0.7; g.add(tail);
  return g;
}
