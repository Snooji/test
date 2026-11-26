// Share image scene: the real house, truck, crew and boxes from the game's code, posed in front of the house at dusk.
import * as THREE from 'three';
import * as VX from './voxel.js';
import { generateLevel } from '../../shared/level.js';

const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, stencil: true });
r.setPixelRatio(1); r.setSize(1200, 630); r.outputColorSpace = THREE.SRGBColorSpace;
r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; document.body.prepend(r.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1410); scene.fog = new THREE.Fog(0x1a1410, 60, 140);
scene.add(new THREE.HemisphereLight(0xffe6c8, 0x3a2e24, 1.5));
const sun = new THREE.DirectionalLight(0xffd6a0, 2.3); sun.position.set(24, 28, 22); sun.target.position.set(6, 0, 2); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 22, bottom: -22, near: 1, far: 90 });
scene.add(sun, sun.target);
const stub = { scene, storeys: [] }; stub.buildTruck = () => VX.buildTruck(stub);
VX.buildWorld(stub);
const level = generateLevel(Number(new URLSearchParams(location.search).get('seed')) || 20261126);
VX.buildHouse(stub, level);


const fd = level.frontDoor;
const pose = (o, x, z, face) => { o.position.set(x, 0, z); (o.userData.body || o).rotation.y = face; scene.add(o); return o; };
const carry = (mover, type, h = 0.2) => { // arms forward, a box held in front at chest height
  mover.userData.body?.traverse(o => { if (o.userData.arm !== undefined) o.rotation.x = -1.35; });
  const b = VX.makeItem(type); b.scale.setScalar(0.62); b.position.set(0, h, 0.42); mover.userData.body.add(b);
};
// the crew heading from the front door to the ramp, faces turned a little toward the camera
const lane = (t) => ({ x: fd.x + 1.5 + t * (9.6 - fd.x - 1.5), z: fd.z + t * (0 - fd.z) });
const face = -0.35; // walking toward the truck, turned toward the camera
const nova = pose(VX.makeMover('nova'), lane(0.62).x, lane(0.62).z + 1.1, face); carry(nova, 'fragile');
const cosmo = pose(VX.makeMover('cosmo'), lane(0.38).x, lane(0.38).z - 0.4, face); carry(cosmo, 'heavy');
const atlas = pose(VX.makeMover('c04'), lane(0.5).x + 0.6, lane(0.5).z - 1.6, face); carry(atlas, 'standard', 0.3);
// two movers sharing the couch
const c1 = lane(0.84), couch = VX.makeItem('couch');
couch.position.set(c1.x + 0.4, 0.5, c1.z + 0.6); couch.rotation.y = face; scene.add(couch);   // side-on, a mover at each end
pose(VX.makeMover('c01'), c1.x + 0.4 - 1.85, c1.z + 0.6 - 0.65, face); pose(VX.makeMover('zibble'), c1.x + 0.4 + 1.85, c1.z + 0.6 + 0.65, face);
// boxes already in the truck
const bay = [[13.6, 1.05, -1.4, 'heavy'], [13.6, 1.05, 0, 'standard'], [13.6, 1.9, -0.7, 'fragile'], [14.5, 1.05, -1.2, 'standard'], [14.5, 1.05, 0.3, 'heavy']];
for (const [x, y, z, t] of bay) { const b = VX.makeItem(t); b.scale.setScalar(1.1); b.position.set(x, y - 0.45, z); scene.add(b); }

const cam = new THREE.PerspectiveCamera(34, 1200 / 630, 0.5, 400);
const mid = lane(0.5);
cam.position.set(mid.x - 0.4, 2.9, mid.z + 8.8); cam.lookAt(mid.x + 1.3, 1.1, mid.z + 0.2);
cam.setViewOffset(1200, 630, -250, 0, 1200, 630); // the scene slides right, clear of the text
// models arrive asynchronously: render once everything is in
const settle = async () => { for (let i = 0; i < 60; i++) { await new Promise(res => setTimeout(res, 150)); let pending = 0; scene.traverse(o => { if (o.isGroup && o.userData.loaded === false) pending++; }); if (!pending && i > 16) break; } };
await settle();
scene.traverse(o => { if (o.isMesh) { o.castShadow = o.castShadow !== false; o.receiveShadow = true; } });
r.render(scene, cam);
document.body.dataset.done = 1;
