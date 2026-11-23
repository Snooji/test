// Loads the downloaded voxel models (client/public/models) once each and hands out copies.
// Models arrive asynchronously, so callers get a Group right away and the mesh is added when ready.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder); // models are meshopt-compressed (smaller downloads)
const cache = new Map();
const load = (url) => {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url).then(g => {
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.needsUpdate = true; } // crisp voxel pixels
    });
    return mergeByMaterial(g.scene);
  }).catch(e => { console.warn('model failed', url, e); return null; }));
  return cache.get(url);
};

/** One mesh per material: a model made of many parts becomes a single draw call (or one per material). */
function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  root.traverse(o => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    let g = o.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color'].includes(k)) { g.deleteAttribute(k); continue; }
      const a = g.getAttribute(k); // compressed (quantized) models store small integers: expand to floats before transforming
      if (!(a.array instanceof Float32Array) || a.normalized || a.isInterleavedBufferAttribute) {
        const arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.getComponent(i, c);
        g.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize));
      }
    }
    g.applyMatrix4(o.matrixWorld);
    const key = o.material.uuid;
    if (!byMat.has(key)) byMat.set(key, { mat: o.material, geos: [] });
    byMat.get(key).geos.push(g);
  });
  const out = new THREE.Group();
  for (const { mat, geos } of byMat.values()) {
    const attrs = (g) => Object.keys(g.attributes).sort().join();
    const want = attrs(geos[0]);
    const same = geos.every(g => attrs(g) === want);
    const merged = same && geos.length > 1 ? mergeGeometries(geos) : null;
    if (merged) { const m = new THREE.Mesh(merged, mat); m.castShadow = m.receiveShadow = true; out.add(m); }
    else for (const g of geos) { const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true; out.add(m); }
  }
  return out;
}

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

/** Many copies of one model in a single draw call per mesh (yard trees, flowers, rocks…).
 *  placements: [{ x, z, rot (radians), h (height in metres) }]; each copy is centred and stood on the floor. */
export function instanceModels(group, url, placements, { tint = null, shadow = true } = {}) {
  if (!placements.length) return group;
  load(url).then(src => {
    if (!src || group.userData.disposed) return;
    src.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(src), size = box.getSize(new THREE.Vector3());
    const centre = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    src.traverse(o => {
      if (!o.isMesh) return;
      const mat = [].concat(o.material).map(mt => { const c = mt.clone(); if (tint !== null) c.color.multiply(new THREE.Color(tint)); return c; });
      const inst = new THREE.InstancedMesh(o.geometry, mat.length === 1 ? mat[0] : mat, placements.length);
      inst.castShadow = shadow; inst.receiveShadow = true;
      placements.forEach((p, i) => {
        const s = p.h / size.y;
        q.setFromAxisAngle(up, p.rot || 0);
        m4.compose(new THREE.Vector3(p.x, p.y || 0, p.z), q, new THREE.Vector3(s, s, s)).multiply(centre).multiply(o.matrixWorld);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      group.add(inst);
    });
  });
  return group;
}
