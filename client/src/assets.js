// Loads the downloaded voxel models (client/public/models) once each and hands out copies.
// Models arrive asynchronously, so callers get a Group right away and the mesh is added when ready.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();
const load = (url) => {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url).then(g => {
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      for (const m of [].concat(o.material)) if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.needsUpdate = true; } // crisp voxel pixels
    });
    return g.scene;
  }).catch(e => { console.warn('model failed', url, e); return null; }));
  return cache.get(url);
};

/** Put a copy of the model at `url` into `group`. tint = hex multiplied into its colours (e.g. a blue moving blanket).
 *  rot = quarter turns about Y; fit = [width x, depth z, height y or null] in metres: the model is scaled to that box,
 *  centred, and stood on the floor (the original files stay untouched, so their colours are exactly the artist's). */
export function attachModel(group, url, { tint = null, rot = 0, fit = null } = {}) {
  load(url).then(src => {
    if (!src || group.userData.disposed) return;
    const m = src.clone(true);
    m.traverse(o => {
      if (!o.isMesh) return;
      o.material = [].concat(o.material).map(mt => { const c = mt.clone(); if (tint !== null) c.color.multiply(new THREE.Color(tint)); return c; });
      if (o.material.length === 1) o.material = o.material[0];
    });
    if (fit) {
      const pivot = new THREE.Group();
      m.rotation.y = rot * Math.PI / 2;
      pivot.add(m); pivot.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(pivot), size = box.getSize(new THREE.Vector3());
      const sx = fit[0] / size.x, sz = fit[1] / size.z, sy = fit[2] ? fit[2] / size.y : (sx + sz) / 2;
      pivot.scale.set(sx, sy, sz);
      pivot.position.set(-(box.min.x + box.max.x) / 2 * sx, -box.min.y * sy, -(box.min.z + box.max.z) / 2 * sz);
      group.add(pivot);
    } else group.add(m);
    group.userData.loaded = true;
  });
  return group;
}

/** Start downloading models before they're needed (e.g. on the menu). */
export const preload = (urls) => urls.forEach(load);
