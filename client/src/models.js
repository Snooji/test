import * as THREE from 'three';
import * as VX from './voxel.js';

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts }));
  return matCache.get(key);
}

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

export function makeMover(char, suit = null) { return VX.makeMover(char, suit); }

// ---------- items ----------
export function makeItem(type, { wrapped = false, assembled = false, loaded = false, dims = null } = {}) { return VX.makeItem(type, { wrapped, assembled, loaded, dims }); }

export function makeCat() { return VX.makeCat(); }
